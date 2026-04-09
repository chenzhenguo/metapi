import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import type { schema } from '../db/index.js';
import { config } from '../config.js';

export type RuntimeModelProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

export type RuntimeModelProbeResult = {
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  reason: string;
};

const NON_CONVERSATION_MODEL_PATTERNS = [
  /(^|[-_/])embedding(s)?($|[-_/])/i,
  /(^|[-_/])rerank($|[-_/])/i,
  /(^|[-_/])moderation($|[-_/])/i,
  /(^|[-_/])whisper($|[-_/])/i,
  /(^|[-_/])tts($|[-_/])/i,
  /(^|[-_/])transcribe|transcription/i,
  /(^|[-_/])dall-e($|[-_/])/i,
  /(^|[-_/])imagen($|[-_/])/i,
  /(^|[-_/])veo($|[-_/])/i,
  /(^|[-_/])cogvideo($|[-_/])/i,
];

const DEFINITE_UNSUPPORTED_PATTERNS = [
  /no such model/i,
  /unknown model/i,
  /unsupported model/i,
  /invalid model/i,
  /model[^]{0,80}(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)/i,
  /(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)[^]{0,40}model/i,
  /模型[^]{0,40}(不存在|不可用|不支持|无效|禁用|未开通|未开放)/,
  /(不存在|不可用|不支持|无效|禁用)[^]{0,20}模型/,
  /model[^]{0,80}(access denied|permission|forbidden|not allowed)/i,
  /模型[^]{0,40}(无权限|未授权|禁止访问)/,
];

function isLikelyConversationModel(modelName: string): boolean {
  const normalized = String(modelName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('__')) return false;
  return !NON_CONVERSATION_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyUnsupportedFailure(status: number, rawErrorText: string): boolean {
  if (![400, 403, 404, 422].includes(status)) return false;
  const normalized = String(rawErrorText || '').trim();
  if (!normalized) return false;
  return DEFINITE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

// 多样化提示词库
const DEFAULT_PROBE_PROMPTS = [
  'Hello, can you help me?',
  'What is your name?',
  'How are you today?',
  'Can you say hello?',
  'Tell me a short sentence.',
  'What time is it?',
  'How do you do?',
  'Nice to meet you.',
  'Can you help with a question?',
  'Greetings!',
];

// 使用配置的提示词或默认提示词
const PROBE_PROMPTS = config.modelAvailabilityProbePrompts.length > 0 
  ? config.modelAvailabilityProbePrompts 
  : DEFAULT_PROBE_PROMPTS;

// 站点级提示词使用记录
const sitePromptUsage = new Map<string, Set<string>>();

function getRandomPrompt(siteId: string): string {
  const usedPrompts = sitePromptUsage.get(siteId) || new Set();
  const availablePrompts = PROBE_PROMPTS.filter(prompt => !usedPrompts.has(prompt));
  
  let selectedPrompt: string;
  if (availablePrompts.length > 0) {
    // 从可用提示词中选择
    selectedPrompt = availablePrompts[Math.floor(Math.random() * availablePrompts.length)];
  } else {
    // 如果所有提示词都用过了，重置并重新选择
    const resetPrompts = new Set<string>();
    sitePromptUsage.set(siteId, resetPrompts);
    selectedPrompt = PROBE_PROMPTS[Math.floor(Math.random() * PROBE_PROMPTS.length)];
  }
  
  // 记录使用的提示词
  const updatedUsedPrompts = sitePromptUsage.get(siteId) || new Set();
  updatedUsedPrompts.add(selectedPrompt);
  sitePromptUsage.set(siteId, updatedUsedPrompts);
  
  return selectedPrompt;
}

function buildProbeBody(modelName: string, siteId: string): Record<string, unknown> {
  const prompt = getRandomPrompt(siteId);
  return {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: 8,
    stream: false,
  };
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        // 尝试 unref，如果可用的话
        if (typeof timerId === 'object' && timerId !== null && 'unref' in timerId) {
          timerId.unref();
        }
      }),
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

function resolveRemainingTimeoutMs(deadlineAtMs: number, timeoutLabel: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutLabel);
  }
  return remainingMs;
}

export async function probeRuntimeModel(input: {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  modelName: string;
  timeoutMs: number;
  tokenValue?: string | null;
}): Promise<RuntimeModelProbeResult> {
  if (!isLikelyConversationModel(input.modelName)) {
    return {
      status: 'skipped',
      latencyMs: null,
      reason: 'skipped non-conversation model probe',
    };
  }

  const oauth = getOauthInfoFromAccount(input.account);
  const tokenValue = String(
    input.tokenValue
    || (oauth ? input.account.accessToken : input.account.apiToken)
    || '',
  ).trim();
  if (!tokenValue) {
    return {
      status: 'inconclusive',
      latencyMs: null,
      reason: 'missing credential for probe',
    };
  }

  const startedAt = Date.now();
  const deadlineAtMs = startedAt + Math.max(1, input.timeoutMs);
  try {
    const endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        {
          site: input.site,
          account: input.account,
        },
        input.modelName,
        'openai',
        input.modelName,
      ),
      resolveRemainingTimeoutMs(
        deadlineAtMs,
        `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
      ),
      `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
    );
    if (endpointCandidates.length <= 0) {
      return {
        status: 'inconclusive',
        latencyMs: Date.now() - startedAt,
        reason: 'no compatible probe endpoint candidates',
      };
    }

    const providerHeaders = buildOauthProviderHeaders({
      account: input.account,
      downstreamHeaders: {},
    });
    const openaiBody = buildProbeBody(input.modelName, String(input.site.id));
    const channelProxyUrl = resolveChannelProxyUrl(input.site, input.account.extraConfig);
    const abortController = new AbortController();
    const remainingExecutionTimeoutMs = resolveRemainingTimeoutMs(
      deadlineAtMs,
      `runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`,
    );
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`));
    }, remainingExecutionTimeoutMs);
    // 尝试 unref，如果可用的话
    if (typeof abortTimer === 'object' && abortTimer !== null && 'unref' in abortTimer) {
      abortTimer.unref();
    }

    const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName: input.modelName,
        stream: false,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: input.site.platform,
        siteUrl: input.site.url,
        openaiBody,
        downstreamFormat: 'openai',
        downstreamHeaders: {},
        providerHeaders,
      });
      return {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        runtime: request.runtime,
      };
    };
    const dispatchRequest = async (
      request: BuiltEndpointRequest,
      targetUrl: string,
    ) => (
      dispatchRuntimeRequest({
        siteUrl: input.site.url,
        targetUrl,
        request,
        buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
          input.site,
          {
            method: 'POST',
            headers: requestForFetch.headers,
            body: JSON.stringify(requestForFetch.body),
            signal: abortController.signal,
          },
          channelProxyUrl,
        ),
      })
    );

    let result: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      result = await executeEndpointFlow({
        siteUrl: input.site.url,
        proxyUrl: channelProxyUrl,
        endpointCandidates,
        buildRequest,
        dispatchRequest,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      await result.upstream.text().catch(() => undefined);
      return {
        status: 'supported',
        latencyMs,
        reason: 'probe succeeded',
      };
    }

    const rawErrorText = String(result.rawErrText || result.errText || '').trim();
    return {
      status: classifyUnsupportedFailure(result.status || 0, rawErrorText) ? 'unsupported' : 'inconclusive',
      latencyMs,
      reason: rawErrorText || `probe failed with status ${result.status || 0}`,
    };
  } catch (error) {
    return {
      status: 'inconclusive',
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : 'probe failed',
    };
  }
}

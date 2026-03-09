import type { DownstreamFormat } from './normalized.js';

export type CompatibilityEndpoint = 'chat' | 'messages' | 'responses';
export type CompatibilityEndpointPreference = DownstreamFormat | 'responses';

type PreferResponsesAfterLegacyChatErrorInput = {
  status: number;
  upstreamErrorText?: string | null;
  downstreamFormat: CompatibilityEndpointPreference;
  sitePlatform?: string | null;
  modelName?: string | null;
  requestedModelHint?: string | null;
  currentEndpoint?: CompatibilityEndpoint | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const value = headerValueToString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function buildMinimalJsonHeadersForCompatibility(input: {
  headers: Record<string, string>;
  endpoint: CompatibilityEndpoint;
  stream: boolean;
}): Record<string, string> {
  const source = normalizeHeaderMap(input.headers);
  const minimal: Record<string, string> = {};

  if (source.authorization) minimal.authorization = source.authorization;
  if (source['x-api-key']) minimal['x-api-key'] = source['x-api-key'];

  if (input.endpoint === 'messages') {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('anthropic-')) continue;
      minimal[key] = value;
    }
    if (!minimal['anthropic-version']) {
      minimal['anthropic-version'] = '2023-06-01';
    }
  }

  minimal['content-type'] = 'application/json';
  minimal.accept = input.stream ? 'text/event-stream' : 'application/json';
  return minimal;
}

export function isUnsupportedMediaTypeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  if (status !== 400 && status !== 415) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return status === 415;

  return (
    text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('application/json')
    || text.includes('content-type')
  );
}

export function isEndpointDispatchDeniedError(status: number, upstreamErrorText?: string | null): boolean {
  if (status !== 403) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(upstreamErrorText || '')
    || text.includes('dispatch denied')
  );
}

export function shouldPreferResponsesAfterLegacyChatError(
  input: PreferResponsesAfterLegacyChatErrorInput,
): boolean {
  if (input.status < 400) return false;
  if (input.downstreamFormat !== 'openai') return false;
  if (input.currentEndpoint !== 'chat') return false;

  const sitePlatform = normalizePlatformName(input.sitePlatform);
  if (sitePlatform === 'openai' || sitePlatform === 'claude' || sitePlatform === 'gemini' || sitePlatform === 'anyrouter') {
    return false;
  }

  const modelName = asTrimmedString(input.modelName);
  const requestedModelHint = asTrimmedString(input.requestedModelHint);
  if (isClaudeFamilyModel(modelName) || isClaudeFamilyModel(requestedModelHint)) {
    return false;
  }

  const text = (input.upstreamErrorText || '').toLowerCase();
  return (
    text.includes('unsupported legacy protocol')
    && text.includes('/v1/chat/completions')
    && text.includes('/v1/responses')
  );
}

export function promoteResponsesCandidateAfterLegacyChatError(
  endpointCandidates: CompatibilityEndpoint[],
  input: PreferResponsesAfterLegacyChatErrorInput,
): void {
  if (!shouldPreferResponsesAfterLegacyChatError(input)) return;

  const currentIndex = endpointCandidates.findIndex((endpoint) => endpoint === input.currentEndpoint);
  const responsesIndex = endpointCandidates.indexOf('responses');
  if (currentIndex < 0 || responsesIndex < 0 || responsesIndex <= currentIndex + 1) return;

  endpointCandidates.splice(responsesIndex, 1);
  endpointCandidates.splice(currentIndex + 1, 0, 'responses');
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (status === 404 || status === 405 || status === 415 || status === 501) return true;
  if (!text) return false;

  let parsedCode = '';
  let parsedType = '';
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    parsedCode = asTrimmedString(error.code).toLowerCase();
    parsedType = asTrimmedString(error.type).toLowerCase();
    parsedMessage = asTrimmedString(error.message).toLowerCase();
  } catch {
    parsedCode = '';
    parsedType = '';
    parsedMessage = '';
  }

  return (
    isEndpointDispatchDeniedError(status, upstreamErrorText)
    || text.includes('convert_request_failed')
    || text.includes('not found')
    || text.includes('unknown endpoint')
    || text.includes('unsupported endpoint')
    || text.includes('unsupported path')
    || text.includes('unrecognized request url')
    || text.includes('no route matched')
    || text.includes('does not exist')
    || text.includes('openai_error')
    || text.includes('upstream_error')
    || text.includes('bad_response_status_code')
    || text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || (status === 400 && text.includes('unsupported'))
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsedCode === 'convert_request_failed'
    || parsedCode === 'not_found'
    || parsedCode === 'endpoint_not_found'
    || parsedCode === 'unknown_endpoint'
    || parsedCode === 'unsupported_endpoint'
    || parsedCode === 'bad_response_status_code'
    || parsedCode === 'openai_error'
    || parsedCode === 'upstream_error'
    || parsedType === 'not_found_error'
    || parsedType === 'invalid_request_error'
    || parsedType === 'unsupported_endpoint'
    || parsedType === 'unsupported_path'
    || parsedType === 'bad_response_status_code'
    || parsedType === 'openai_error'
    || parsedType === 'upstream_error'
    || parsedMessage.includes('unknown endpoint')
    || parsedMessage.includes('unsupported endpoint')
    || parsedMessage.includes('unsupported path')
    || parsedMessage.includes('unrecognized request url')
    || parsedMessage.includes('no route matched')
    || parsedMessage.includes('does not exist')
    || parsedMessage.includes('bad_response_status_code')
    || parsedMessage === 'openai_error'
    || parsedMessage === 'upstream_error'
    || parsedMessage.includes('unsupported media type')
    || parsedMessage.includes("only 'application/json' is allowed")
    || parsedMessage.includes('only "application/json" is allowed')
    || (
      status === 400
      && parsedCode === 'invalid_request'
      && parsedType === 'new_api_error'
      && (parsedMessage.includes('claude code cli') || text.includes('claude code cli'))
    )
  );
}

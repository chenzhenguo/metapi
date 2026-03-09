export type DownstreamClientKind = 'generic' | 'codex' | 'claude_code';

export type DownstreamClientContext = {
  clientKind: DownstreamClientKind;
  sessionId?: string;
  traceHint?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
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

function getHeaderValue(headers: Record<string, unknown> | undefined, targetKey: string): string | null {
  if (!headers) return null;
  const normalizedTarget = targetKey.trim().toLowerCase();

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedTarget) continue;
    return headerValueToString(rawValue);
  }

  return null;
}

export function isCodexResponsesSurface(headers?: Record<string, unknown>): boolean {
  if (!headers) return false;

  let sawOpenAiBeta = false;
  let sawStainless = false;

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    const value = headerValueToString(rawValue);
    if (!key || !value) continue;

    if (key === 'originator' && value.toLowerCase() === 'codex_cli_rs') {
      return true;
    }
    if (key === 'openai-beta') {
      sawOpenAiBeta = true;
    }
    if (key.startsWith('x-stainless-')) {
      sawStainless = true;
    }
  }

  return sawOpenAiBeta || sawStainless;
}

const claudeCodeUserIdPattern = /^user_[0-9a-f]{64}_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractClaudeCodeSessionId(userId: string): string | null {
  const trimmed = userId.trim();
  if (!claudeCodeUserIdPattern.test(trimmed)) return null;

  const sessionPrefix = '__session_';
  const sessionIndex = trimmed.lastIndexOf(sessionPrefix);
  if (sessionIndex === -1) return null;

  const sessionId = trimmed.slice(sessionIndex + sessionPrefix.length).trim();
  return sessionId || null;
}

export function detectDownstreamClientContext(input: {
  downstreamPath: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}): DownstreamClientContext {
  const normalizedPath = input.downstreamPath.trim().toLowerCase();

  if (normalizedPath === '/v1/messages' || normalizedPath === '/anthropic/v1/messages') {
    if (isRecord(input.body) && isRecord(input.body.metadata)) {
      const userId = typeof input.body.metadata.user_id === 'string'
        ? input.body.metadata.user_id.trim()
        : '';
      const sessionId = userId ? extractClaudeCodeSessionId(userId) : null;
      if (sessionId) {
        return {
          clientKind: 'claude_code',
          sessionId,
          traceHint: sessionId,
        };
      }
    }

    return { clientKind: 'generic' };
  }

  if (normalizedPath.startsWith('/v1/responses') && isCodexResponsesSurface(input.headers)) {
    const sessionId = getHeaderValue(input.headers, 'session_id') || getHeaderValue(input.headers, 'session-id');
    if (sessionId) {
      return {
        clientKind: 'codex',
        sessionId,
        traceHint: sessionId,
      };
    }

    return { clientKind: 'codex' };
  }

  return { clientKind: 'generic' };
}

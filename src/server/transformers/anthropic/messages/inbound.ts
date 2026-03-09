import { parseDownstreamChatRequest, type ParsedDownstreamChatRequest } from '../../shared/normalized.js';
import { createProtocolRequestEnvelope, type ProtocolRequestEnvelope } from '../../shared/protocolModel.js';
import { validateAnthropicMessagesBody } from './conversion.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 0;
  return Math.trunc(numberValue);
}

function invalidRequest(message: string): { statusCode: number; payload: unknown } {
  return {
    statusCode: 400,
    payload: {
      error: {
        message,
        type: 'invalid_request_error',
      },
    },
  };
}

function validateMaxTokens(body: Record<string, unknown>): { statusCode: number; payload: unknown } | undefined {
  const maxTokens = toPositiveInteger(body.max_tokens ?? body.maxTokens);
  if (maxTokens > 0) return undefined;
  return invalidRequest('max_tokens is required and must be positive');
}

function validateSystemPrompts(body: Record<string, unknown>): { statusCode: number; payload: unknown } | undefined {
  const system = body.system;
  if (system === undefined || system === null || typeof system === 'string') return undefined;
  if (!Array.isArray(system)) return undefined;

  for (const entry of system) {
    if (typeof entry === 'string') continue;
    if (!isRecord(entry)) {
      return invalidRequest('system prompt must be text');
    }

    const type = asTrimmedString(entry.type).toLowerCase();
    if (type && type !== 'text') {
      return invalidRequest('system prompt must be text');
    }
  }

  return undefined;
}

function validateAdaptiveEffort(body: Record<string, unknown>): { statusCode: number; payload: unknown } | undefined {
  const thinking = isRecord(body.thinking) ? body.thinking : null;
  const thinkingType = asTrimmedString(thinking?.type).toLowerCase();
  const outputConfig = isRecord(body.output_config)
    ? body.output_config
    : (isRecord(body.outputConfig) ? body.outputConfig : null);

  if (!outputConfig || !('effort' in outputConfig)) return undefined;

  const effort = asTrimmedString(outputConfig.effort).toLowerCase();
  if (!effort || thinkingType !== 'adaptive') return undefined;

  if (!['low', 'medium', 'high', 'max'].includes(effort)) {
    return invalidRequest('output_config.effort must be one of: low, medium, high, max');
  }

  return undefined;
}

function validateToolChoice(body: Record<string, unknown>): { statusCode: number; payload: unknown } | undefined {
  const rawToolChoice = body.tool_choice ?? body.toolChoice;
  if (rawToolChoice === undefined) return undefined;

  if (typeof rawToolChoice === 'string') {
    const type = asTrimmedString(rawToolChoice).toLowerCase();
    if (!type) return undefined;
    if (type === 'required' || type === 'auto' || type === 'none' || type === 'any') return undefined;
    if (type === 'tool') {
      return invalidRequest('tool_choice.name is required when type is tool');
    }
    return invalidRequest('tool_choice.type must be one of: auto, none, any, tool');
  }

  if (!isRecord(rawToolChoice)) {
    return invalidRequest('tool_choice must be an object or string');
  }

  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (!['auto', 'none', 'any', 'tool'].includes(type)) {
    return invalidRequest('tool_choice.type must be one of: auto, none, any, tool');
  }

  if (type !== 'tool') return undefined;

  const name = asTrimmedString(
    rawToolChoice.name
    ?? (isRecord(rawToolChoice.tool) ? rawToolChoice.tool.name : undefined),
  );
  if (!name) {
    return invalidRequest('tool_choice.name is required when type is tool');
  }

  return undefined;
}

function sanitizeAnthropicInboundBody(
  body: Record<string, unknown>,
): { sanitizedBody?: Record<string, unknown>; error?: { statusCode: number; payload: unknown } } {
  const maxTokensError = validateMaxTokens(body);
  if (maxTokensError) return { error: maxTokensError };

  const systemError = validateSystemPrompts(body);
  if (systemError) return { error: systemError };

  const adaptiveEffortError = validateAdaptiveEffort(body);
  if (adaptiveEffortError) return { error: adaptiveEffortError };

  const toolChoiceError = validateToolChoice(body);
  if (toolChoiceError) return { error: toolChoiceError };

  const validation = validateAnthropicMessagesBody(body, {
    autoOptimizeCacheControls: false,
  });
  if (validation.error) {
    return { error: validation.error };
  }

  return {
    sanitizedBody: validation.sanitizedBody ?? body,
  };
}

export const anthropicMessagesInbound = {
  parse(body: unknown): {
    value?: ProtocolRequestEnvelope<'anthropic/messages', ParsedDownstreamChatRequest>;
    error?: { statusCode: number; payload: unknown };
  } {
    const rawBody = isRecord(body) ? body : null;
    const inboundValidation = rawBody ? sanitizeAnthropicInboundBody(rawBody) : null;
    if (inboundValidation?.error) {
      return { error: inboundValidation.error };
    }

    const effectiveBody = inboundValidation?.sanitizedBody ?? body;
    const parsed = parseDownstreamChatRequest(effectiveBody, 'claude');
    if (parsed.error) {
      return { error: parsed.error };
    }
    if (!parsed.value) {
      return { error: invalidRequest('invalid messages request') };
    }

    if (inboundValidation?.sanitizedBody) {
      parsed.value.claudeOriginalBody = inboundValidation.sanitizedBody;
    }

    return {
      value: createProtocolRequestEnvelope({
        protocol: 'anthropic/messages',
        model: parsed.value.requestedModel,
        stream: parsed.value.isStream,
        rawBody: body,
        parsed: parsed.value,
      }),
    };
  },
};

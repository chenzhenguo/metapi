import { type StreamTransformContext } from '../../shared/normalized.js';
import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  sanitizeResponsesBodyForProxy,
} from './conversion.js';
import {
  buildResponsesCompatibilityBodies as buildRetryBodies,
  buildResponsesCompatibilityHeaderCandidates as buildRetryHeaders,
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  normalizeResponsesMessageItem,
  shouldDowngradeResponsesChatToMessages as shouldDowngradeChatToMessages,
  shouldRetryResponsesCompatibility as shouldRetry,
} from './compatibility.js';
import {
  type OpenAiResponsesAggregateState,
  completeResponsesStream,
  createOpenAiResponsesAggregateState,
  failResponsesStream,
  serializeConvertedResponsesEvents,
} from './aggregator.js';
import { openAiResponsesOutbound } from './outbound.js';
import { openAiResponsesInbound } from './inbound.js';
import { createResponsesProxyStreamSession } from './proxyStream.js';
import { createResponsesEndpointStrategy } from './routeCompatibility.js';
import { openAiResponsesStream } from './stream.js';
import { openAiResponsesUsage } from './usage.js';
import type {
  OpenAiResponsesParsedRequest as OpenAiResponsesParsedRequestModel,
  OpenAiResponsesRequestEnvelope as OpenAiResponsesRequestEnvelopeModel,
} from './model.js';

export const openAiResponsesTransformer = {
  protocol: 'openai/responses' as const,
  inbound: {
    parse: openAiResponsesInbound.parse,
    normalizeInput: normalizeResponsesInputForCompatibility,
    normalizeMessage: normalizeResponsesMessageItem,
    normalizeContent: normalizeResponsesMessageContent,
    sanitizeProxyBody: sanitizeResponsesBodyForProxy,
    fromOpenAiBody: convertOpenAiBodyToResponsesBody,
    toOpenAiBody: convertResponsesBodyToOpenAiBody,
  },
  outbound: openAiResponsesOutbound,
  stream: openAiResponsesStream,
  usage: openAiResponsesUsage,
  compatibility: {
    createEndpointStrategy: createResponsesEndpointStrategy,
    buildRetryBodies,
    buildRetryHeaders,
    shouldRetry,
    shouldDowngradeChatToMessages,
  },
  aggregator: {
    createState: createOpenAiResponsesAggregateState,
    serialize: serializeConvertedResponsesEvents,
    complete: completeResponsesStream,
    fail: failResponsesStream,
  },
  proxyStream: {
    createSession: createResponsesProxyStreamSession,
  },
  transformRequest(
    body: unknown,
    options?: { defaultEncryptedReasoningInclude?: boolean },
  ): { value?: OpenAiResponsesRequestEnvelopeModel; error?: { statusCode: number; payload: unknown } } {
    return openAiResponsesInbound.parse(body, options);
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return openAiResponsesStream.createContext(modelName);
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = '') {
    return openAiResponsesOutbound.normalizeFinal(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string) {
    return openAiResponsesStream.normalizeEvent(payload, context, modelName);
  },
  pullSseEvents(buffer: string) {
    return openAiResponsesStream.pullSseEvents(buffer);
  },
};

export type OpenAiResponsesTransformer = typeof openAiResponsesTransformer;
export type OpenAiResponsesAggregate = OpenAiResponsesAggregateState;
export type OpenAiResponsesParsedRequest = OpenAiResponsesParsedRequestModel;
export type OpenAiResponsesRequestEnvelope = OpenAiResponsesRequestEnvelopeModel;
export {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  normalizeResponsesMessageItem,
  sanitizeResponsesBodyForProxy,
};

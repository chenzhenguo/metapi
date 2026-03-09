import { type NormalizedFinalResponse, type NormalizedStreamEvent, type StreamTransformContext } from '../../shared/normalized.js';
import { createChatEndpointStrategy } from '../../shared/chatEndpointStrategy.js';
import { openAiChatInbound } from './inbound.js';
import { openAiChatOutbound } from './outbound.js';
import { createChatProxyStreamSession } from './proxyStream.js';
import { openAiChatStream } from './stream.js';
import { openAiChatUsage } from './usage.js';
import { createOpenAiChatAggregateState, applyOpenAiChatStreamEvent, finalizeOpenAiChatAggregate } from './aggregator.js';
import type {
  OpenAiChatParsedRequest as OpenAiChatParsedRequestModel,
  OpenAiChatRequestEnvelope as OpenAiChatRequestEnvelopeModel,
} from './model.js';

export const openAiChatTransformer = {
  protocol: 'openai/chat' as const,
  inbound: openAiChatInbound,
  outbound: openAiChatOutbound,
  stream: openAiChatStream,
  usage: openAiChatUsage,
  compatibility: {
    createEndpointStrategy: createChatEndpointStrategy,
  },
  aggregator: {
    createState: createOpenAiChatAggregateState,
    applyEvent: applyOpenAiChatStreamEvent,
    finalize: finalizeOpenAiChatAggregate,
  },
  proxyStream: {
    createSession: createChatProxyStreamSession,
  },
  transformRequest(body: unknown): ReturnType<typeof openAiChatInbound.parse> {
    return openAiChatInbound.parse(body);
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return openAiChatStream.createContext(modelName);
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = ''): NormalizedFinalResponse {
    return openAiChatOutbound.normalizeFinal(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string): NormalizedStreamEvent {
    return openAiChatStream.normalizeEvent(payload, context, modelName);
  },
  serializeStreamEvent(
    event: NormalizedStreamEvent,
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeEvent>[2],
  ): string[] {
    return openAiChatStream.serializeEvent(event, context, claudeContext);
  },
  serializeDone(
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeDone>[1],
  ): string[] {
    return openAiChatStream.serializeDone(context, claudeContext);
  },
  serializeFinalResponse(
    normalized: NormalizedFinalResponse,
    usage: Parameters<typeof openAiChatOutbound.serializeFinal>[1],
  ) {
    return openAiChatOutbound.serializeFinal(normalized, usage);
  },
  serializeUpstreamFinalAsStream(
    payload: unknown,
    modelName: string,
    fallbackText: string,
    streamContext: StreamTransformContext,
  ) {
    const normalizedFinal = openAiChatOutbound.normalizeFinal(payload, modelName, fallbackText);
    streamContext.id = normalizedFinal.id;
    streamContext.model = normalizedFinal.model;
    streamContext.created = normalizedFinal.created;
    return openAiChatOutbound
      .buildSyntheticChunks(normalizedFinal)
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  },
  buildSyntheticChunks(normalized: NormalizedFinalResponse) {
    return openAiChatOutbound.buildSyntheticChunks(normalized);
  },
  pullSseEvents(buffer: string) {
    return openAiChatStream.pullSseEvents(buffer);
  },
};

export type OpenAiChatTransformer = typeof openAiChatTransformer;
export type OpenAiChatParsedRequest = OpenAiChatParsedRequestModel;
export type OpenAiChatRequestEnvelope = OpenAiChatRequestEnvelopeModel;

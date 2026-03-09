import { describe, expect, it } from 'vitest';

import { openAiResponsesTransformer } from './index.js';

describe('openAiResponsesTransformer.inbound', () => {
  it('returns a protocol request envelope with a normalized responses body', () => {
    const result = openAiResponsesTransformer.transformRequest({
      model: 'gpt-5',
      input: 'hello',
      reasoning: {
        effort: 'high',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      protocol: 'openai/responses',
      model: 'gpt-5',
      stream: false,
      rawBody: {
        model: 'gpt-5',
        input: 'hello',
      },
      parsed: {
        normalizedBody: {
          model: 'gpt-5',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: 'hello',
                },
              ],
            },
          ],
          stream: false,
        },
      },
    });
  });

  it('rejects requests without a model at the transformer boundary', () => {
    const result = openAiResponsesTransformer.transformRequest({
      input: 'hello',
    });

    expect(result.error).toEqual({
      statusCode: 400,
      payload: {
        error: {
          message: 'model is required',
          type: 'invalid_request_error',
        },
      },
    });
  });
});

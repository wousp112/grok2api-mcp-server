import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAssistantTextFromUpstreamData } from '../lib/upstream-response.js';

test('extracts assistant content from standard chat completion JSON', () => {
  const data = {
    choices: [
      {
        message: {
          content: '{"summary":"ok"}',
        },
      },
    ],
  };

  assert.equal(extractAssistantTextFromUpstreamData(data), '{"summary":"ok"}');
});

test('extracts assistant content from stringified JSON responses', () => {
  const data = JSON.stringify({
    choices: [
      {
        message: {
          content: '{"summary":"ok"}',
        },
      },
    ],
  });

  assert.equal(extractAssistantTextFromUpstreamData(data), '{"summary":"ok"}');
});

test('reconstructs assistant content from SSE chat completion payload', () => {
  const data = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"{"}}]}',
    'data: {"choices":[{"delta":{"content":"\\"summary\\":\\"ok\\""}}]}',
    'data: {"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  assert.equal(extractAssistantTextFromUpstreamData(data), '{"summary":"ok"}');
});

test('drops think blocks from SSE payloads before returning assistant content', () => {
  const data = [
    'data: {"choices":[{"delta":{"content":"<think>internal notes</think>"}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"ok\\"}"}}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  assert.equal(extractAssistantTextFromUpstreamData(data), '{"summary":"ok"}');
});

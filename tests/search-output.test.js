import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSourceUrlsFromAssistantText,
  parseCliSearchResult,
} from '../lib/search-output.js';

test('extracts source urls from object json text', () => {
  const text = '{"sources":["https://x.com/a","https://x.com/b"]}';
  assert.deepEqual(extractSourceUrlsFromAssistantText(text), [
    'https://x.com/a',
    'https://x.com/b',
  ]);
});

test('extracts source urls from fenced array json text', () => {
  const text = '```json\n["https://x.com/a","https://x.com/b"]\n```';
  assert.deepEqual(extractSourceUrlsFromAssistantText(text), [
    'https://x.com/a',
    'https://x.com/b',
  ]);
});

test('parses cli result from assistant json content', () => {
  const payload = {
    choices: [
      {
        message: {
          content: '{"sources":["https://x.com/a","https://x.com/b"]}',
        },
      },
    ],
  };

  const result = parseCliSearchResult(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, [
    'https://x.com/a',
    'https://x.com/b',
  ]);
  assert.equal(result.first_source_url, 'https://x.com/a');
});

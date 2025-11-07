import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const WORKSPACE = process.env.CODEX_STRUCTURED_WORKSPACE ?? process.cwd();

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
    },
  },
  required: ['summary', 'keyPoints'],
  additionalProperties: false,
} as const;

test('codex returns structured summary output', async () => {
  const coder = createCoder(CODER_TYPES.CODEX, {
    workingDirectory: WORKSPACE,
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
  });

  const thread = await coder.startThread();
  const result = await coder.run(
    thread,
    'Summarise the purpose of this repository and list two components.',
    { outputSchema: SCHEMA },
  );

  assert.ok(result.json, 'Structured output should be parsed into json.');
  const structured = result.json as { summary: string; keyPoints: string[] };
  assert.equal(typeof structured.summary, 'string');
  assert.ok(Array.isArray(structured.keyPoints));
  assert.ok(structured.keyPoints.length >= 2);
});

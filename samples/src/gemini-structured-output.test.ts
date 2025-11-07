import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const WORKSPACE = process.env.GEMINI_STRUCTURED_WORKSPACE ?? process.cwd();

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    components: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'components'],
} as const;

function isGeminiMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ENOENT|not found|command failed.*gemini/i.test(message);
}

test('gemini returns structured output', async t => {
  const coder = createCoder(CODER_TYPES.GEMINI, {
    workingDirectory: WORKSPACE,
    includeDirectories: [WORKSPACE],
  });

  const thread = await coder.startThread();
  try {
    const result = await coder.run(
      thread,
      'Provide JSON describing this project (summary + components array).',
      { outputSchema: SCHEMA },
    );
    assert.ok(result.json, 'Structured output should be parsed.');
    const structured = result.json as { summary: string; components: string[] };
    assert.equal(typeof structured.summary, 'string');
    assert.ok(Array.isArray(structured.components));
  } catch (error) {
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini structured test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }
});


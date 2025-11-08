import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as GEMINI_CODER_NAME } from '@headless-coder-sdk/gemini-adapter';

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
  const coder = createCoder(GEMINI_CODER_NAME, {
    workingDirectory: WORKSPACE,
    includeDirectories: [WORKSPACE],
  });

  const thread = await coder.startThread();
  try {
    const result = await thread.run(
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

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, cp } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const WORKSPACE = process.env.CLAUDE_STRUCTURED_WORKSPACE ?? '/tmp/headless-coder/test_claude_structured';
const CONFIG_SOURCE = process.env.CLAUDE_STREAM_CONFIG_SOURCE ?? '/tmp/headless-coder/test_claude/.claude';

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    risks: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'risks'],
} as const;

async function prepareWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function hydrateConfig(targetDir: string): Promise<void> {
  try {
    await access(CONFIG_SOURCE, fsConstants.R_OK);
  } catch {
    return;
  }
  await mkdir(path.dirname(targetDir), { recursive: true });
  await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  await cp(CONFIG_SOURCE, targetDir, { recursive: true });
}

async function runClaudeStructured(t: TestContext): Promise<void> {
  const hasKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_API_KEY ||
    !!process.env.ANTHROPIC_API_TOKEN ||
    !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!hasKey) {
    t.skip('Skipping Claude structured test because no Claude credentials are configured.');
    return;
  }

  await prepareWorkspace(WORKSPACE);
  const configDir = path.join(WORKSPACE, '.claude');
  await hydrateConfig(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const coder = createCoder(CODER_TYPES.CLAUDE_CODE, {
    workingDirectory: WORKSPACE,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Write', 'Edit', 'Read', 'NotebookEdit'],
  });

  const thread = await coder.startThread();
  const result = await coder.run(
    thread,
    'Provide JSON containing a summary and two risks of using autonomous coding agents.',
    { outputSchema: SCHEMA },
  );

  assert.ok(result.json, 'Structured output should be parsed.');
  const structured = result.json as { summary: string; risks: string[] };
  assert.equal(typeof structured.summary, 'string');
  assert.ok(Array.isArray(structured.risks));
  assert.ok(structured.risks.length >= 1);
}

test('claude returns structured output', runClaudeStructured);

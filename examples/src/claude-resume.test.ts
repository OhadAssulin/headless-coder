import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, rm, cp } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as CLAUDE_CODER_NAME } from '@headless-coder-sdk/claude-adapter';

const WORKSPACE = process.env.CLAUDE_RESUME_WORKSPACE ?? '/tmp/headless-coder-sdk/test_claude_resume';
const CONFIG_SOURCE = process.env.CLAUDE_STREAM_CONFIG_SOURCE ?? '/tmp/headless-coder-sdk/test_claude/.claude';

async function hydrateClaudeConfig(targetDir: string): Promise<void> {
  try {
    await access(CONFIG_SOURCE, fsConstants.R_OK);
  } catch {
    return;
  }
  await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(CONFIG_SOURCE, targetDir, { recursive: true });
}

test('claude resumes a conversation', async t => {
  const hasKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_API_KEY ||
    !!process.env.ANTHROPIC_API_TOKEN ||
    !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!hasKey) {
    t.skip('Skipping Claude resume test because no Claude credentials are configured.');
    return;
  }

  await mkdir(WORKSPACE, { recursive: true });
  const configDir = path.join(WORKSPACE, '.claude');
  await hydrateClaudeConfig(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const coder = createCoder(CLAUDE_CODER_NAME, {
    workingDirectory: WORKSPACE,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Write', 'Edit', 'Read', 'NotebookEdit'],
  });

  const thread = await coder.startThread();
  const first = await thread.run('Give one idea for improving DX.');
  assert.ok(first.text && first.text.length > 0, 'First Claude response should exist.');

  const resumed = await coder.resumeThread(thread.id!);
  const followUp = await resumed.run('Continue with implementation guidance.');
  assert.equal(followUp.threadId, thread.id);
  assert.ok(followUp.text && followUp.text.length > 0, 'Claude follow-up should exist.');
});

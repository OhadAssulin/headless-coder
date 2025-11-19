/**
 * @fileoverview Exercises Gemini session resume workflows to ensure the adapter
 * forwards the CLI --resume flag for repeated runs and explicit resumeThread calls.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as GEMINI_CODER_NAME } from '@headless-coder-sdk/gemini-adapter';
import { ensureAdaptersRegistered } from './register-adapters';

const WORKSPACE = process.env.GEMINI_RESUME_WORKSPACE ?? '/tmp/headless-coder-sdk/test_gemini_resume';

ensureAdaptersRegistered();

async function prepareWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function isGeminiMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ENOENT|not found|command failed.*gemini/i.test(message);
}

async function registerThreadCleanup(t: TestContext, closeFn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (!closeFn) return;
  const registerCleanup = (t as { cleanup?: (fn: () => Promise<void> | void) => void }).cleanup;
  if (typeof registerCleanup === 'function') {
    registerCleanup(closeFn);
  } else {
    t.signal.addEventListener('abort', () => {
      void closeFn();
    });
  }
}

test('gemini reuses the same session within a thread', async t => {
  await prepareWorkspace(WORKSPACE);
  const coder = createCoder(GEMINI_CODER_NAME, {
    workingDirectory: WORKSPACE,
    includeDirectories: [WORKSPACE],
    yolo: true,
  });
  const thread = await coder.startThread();
  await registerThreadCleanup(t, coder.close?.bind(coder, thread));

  try {
    const first = await thread.run('List two numbered steps for debugging flaky tests.');
    if (!first.threadId) {
      throw new Error('Gemini resume support should return a session identifier.');
    }
    const followUp = await thread.run('Add one final note emphasizing deterministic tooling.');
    assert.equal(
      followUp.threadId,
      first.threadId,
      'Subsequent runs within the same thread must reuse the Gemini session id.',
    );
    assert.ok(followUp.text, 'Gemini follow-up response should contain assistant text.');
  } catch (error) {
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini resume test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }
});

test('gemini resumeThread continues an earlier session id', async t => {
  await prepareWorkspace(WORKSPACE);
  const coder = createCoder(GEMINI_CODER_NAME, {
    workingDirectory: WORKSPACE,
    includeDirectories: [WORKSPACE],
    yolo: true,
  });
  const baseThread = await coder.startThread();
  await registerThreadCleanup(t, coder.close?.bind(coder, baseThread));

  let firstRunThreadId: string | undefined;
  try {
    const initial = await baseThread.run('Provide a short two-step incident response checklist.');
    firstRunThreadId = initial.threadId;
    if (!firstRunThreadId) {
      throw new Error('Gemini resume support should provide a session id after the first run.');
    }
  } catch (error) {
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini resume test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }

  const resumed = await coder.resumeThread(firstRunThreadId);
  await registerThreadCleanup(t, coder.close?.bind(coder, resumed));

  try {
    const followUp = await resumed.run('Extend the checklist with one preventative follow-up action.');
    assert.equal(
      followUp.threadId,
      firstRunThreadId,
      'Resumed Gemini runs should maintain the original session id.',
    );
    assert.match(followUp.text ?? '', /follow/i, 'Gemini follow-up response should mention the additive action.');
  } catch (error) {
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini resume test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }
});

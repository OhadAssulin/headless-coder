import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

test('codex resumes a conversation', async () => {
  const coder = createCoder(CODER_TYPES.CODEX, {
    workingDirectory: process.cwd(),
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
  });

  const initialThread = await coder.startThread({ model: 'gpt-5-codex' });
  const firstRun = await initialThread.run('List two tasks we should automate.');
  assert.ok(firstRun.text && firstRun.text.length > 0, 'First run should produce text.');

  const initialId = coder.getThreadId(initialThread) ?? firstRun.threadId;
  assert.ok(initialId, 'Codex should supply a thread id after the first run.');

  const resumedThread = await coder.resumeThread(initialId!);
  const followUp = await resumedThread.run('Continue with mitigation steps.');

  assert.equal(followUp.threadId, initialId);
  assert.ok(followUp.text && followUp.text.length > 0, 'Follow-up run should produce text.');
});

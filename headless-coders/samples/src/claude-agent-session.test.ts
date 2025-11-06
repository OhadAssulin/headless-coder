/**
 * @fileoverview Validates Claude Agent SDK integration through the shared headless coder facade.
 *
 * The test instructs Claude to generate a calculator and verifies the produced page.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { createCoder } from '@headless-coders/core/factory';
import type { PromptInput, RunResult } from '@headless-coders/core/types';

const CLAUDE_WORKSPACE = process.env.CLAUDE_TEST_WORKSPACE ?? '/tmp/headless-coder/test_claude';
const CLAUDE_TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_TEST_TIMEOUT_MS ?? '', 10) || 180_000;

/**
 * Ensures the Claude working directory exists without mutating user-provided settings.
 *
 * Args:
 *   dir: Absolute path to the workspace that should exist for the test run.
 *
 * Returns:
 *   Promise that resolves once the workspace directory is present.
 *
 * Raises:
 *   Error: Propagated if the directory cannot be created.
 */
async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Loads Claude configuration variables stored in the workspace settings directory.
 *
 * Args:
 *   workspace: Absolute path where the `.claude` folder resides.
 *
 * Returns:
 *   Promise that resolves once environment variables are merged into `process.env`.
 *
 * Raises:
 *   Error: Propagated when settings files exist but contain invalid JSON.
 */
async function loadClaudeEnvironment(workspace: string): Promise<void> {
  const configDir = path.join(workspace, '.claude');
  const configFiles = ['settings.json', 'settings.local.json'];

  await mkdir(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;

  for (const file of configFiles) {
    const fullPath = path.join(configDir, file);
    try {
      await access(fullPath, fsConstants.R_OK);
    } catch {
      continue;
    }

    const raw = await readFile(fullPath, 'utf8');
    if (!raw.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse Claude settings file at ${fullPath}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    const envBlock = (parsed as { env?: Record<string, string> })?.env;
    if (!envBlock) continue;
    for (const [key, value] of Object.entries(envBlock)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Builds a prompt that asks Claude to enumerate validation steps for a calculator feature.
 *
 * Args:
 *   workspace: The working directory Claude can read/write within.
 *
 * Returns:
 *   PromptInput requesting a concise validation checklist.
 */
function buildPrompt(workspace: string): PromptInput {
  const instructions = [
    `You are operating inside ${workspace}.`,
    'Tasks:',
    '- Overwrite index.html in this directory with a complete, production-ready calculator page.',
    '- Requirements:',
    '  * Use semantic HTML; wrap the interface in a main element.',
    '  * Provide two numeric inputs with ids numberA and numberB, a select with id operator that offers "+", "-", "*", "/", and a button with id compute.',
    '  * Include a span with id="result" that displays the outcome; it may be wrapped in descriptive text like "Result:".',
    '  * Define window.calculate(a, b, operator) in inline JavaScript. It must parse numeric inputs, execute the requested operation, update the result span text, and return the numeric result.',
    '  * Register a click listener on the compute button that prevents default submission, reads the inputs, and calls window.calculate.',
    '  * Apply modest inline CSS for clarity, avoiding any external assets.',
    '- Do not create additional files or run shell commands beyond writing index.html.',
    '- After writing the file, confirm success in a single concise sentence.',
  ].join('\n');

  return [
    { role: 'system', content: 'You are a meticulous software engineer generating deterministic project files.' },
    { role: 'user', content: instructions },
  ];
}

/**
 * Wraps a promise with an upper bound on completion time.
 *
 * Args:
 *   promise: The promise to monitor.
 *   timeoutMs: Milliseconds before rejecting with a timeout error.
 *   message: Error message used when the timeout elapses.
 *
 * Returns:
 *   The fulfilled promise value when completed before timeout.
 *
 * Raises:
 *   Error: When the underlying promise rejects or when the timeout is exceeded.
 */
async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Executes the Claude planning scenario and validates the returned response.
 *
 * Args:
 *   t: Node.js test context used for cleanup registration.
 *
 * Returns:
 *   Promise that resolves once validation completes.
 *
 * Raises:
 *   Error: When prerequisites are missing or Claude fails to respond.
 */
async function runClaudeScenario(t: TestContext): Promise<void> {
  await ensureWorkspace(CLAUDE_WORKSPACE);
  await loadClaudeEnvironment(CLAUDE_WORKSPACE);
  await rm(path.join(CLAUDE_WORKSPACE, 'index.html'), { force: true });

  const hasAnthropicKey =
    !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_API_KEY || !!process.env.ANTHROPIC_API_TOKEN;
  const hasBedrockToken = !!process.env.AWS_BEARER_TOKEN_BEDROCK;

  if (!hasAnthropicKey && !hasBedrockToken) {
    t.skip(
      'Skipping Claude integration test because Claude API credentials or Bedrock token are unavailable.',
    );
    return;
  }

  const coder = createCoder('claude', {
    workingDirectory: CLAUDE_WORKSPACE,
    model: process.env.CLAUDE_TEST_MODEL,
    allowedTools: ['Write', 'Edit', 'Read', 'NotebookEdit'],
    permissionMode: 'bypassPermissions',
  });
  const thread = await coder.startThread();

  const registerCleanup = (t as { cleanup?: (fn: () => Promise<void> | void) => void }).cleanup;
  if (typeof registerCleanup === 'function') {
    registerCleanup(async () => {
      await coder.close?.(thread);
    });
  } else {
    t.signal.addEventListener('abort', () => {
      void coder.close?.(thread);
    });
  }

  let result: RunResult;
  try {
    result = await withinTimeout<RunResult>(
      coder.run(thread, buildPrompt(CLAUDE_WORKSPACE), { streamPartialMessages: true }),
      CLAUDE_TIMEOUT_MS,
      `Claude integration test timed out after ${CLAUDE_TIMEOUT_MS}ms.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/credit balance is too low/i.test(message)) {
      t.skip('Skipping Claude integration test because the credit balance is insufficient.');
      return;
    }
    throw error;
  }

  assert.ok(result.text && result.text.trim().length > 0, 'Claude should return a non-empty reply.');
  if (typeof thread.id === 'string') {
    assert.equal(
      result.threadId,
      thread.id,
      'Claude run should report the same thread identifier that was started.',
    );
  }

  const htmlPath = path.join(CLAUDE_WORKSPACE, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  assert.ok(html.includes('numberA'), 'Generated HTML should include the first input field.');

  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;

  assert.equal(typeof window.calculate, 'function', 'window.calculate must be defined.');
  const direct = window.calculate(6, 3, '-');
  assert.equal(direct, 3, 'window.calculate should compute subtraction.');

  const numberA = window.document.getElementById('numberA') as HTMLInputElement | null;
  const numberB = window.document.getElementById('numberB') as HTMLInputElement | null;
  const operator = window.document.getElementById('operator') as HTMLSelectElement | null;
  const compute = window.document.getElementById('compute') as HTMLButtonElement | null;
  const resultSpan = window.document.getElementById('result');

  assert.ok(numberA && numberB && operator && compute && resultSpan, 'Calculator DOM elements must exist.');

  numberA.value = '10';
  numberB.value = '2';
  operator.value = '*';
  compute.click();

  const claudeRawResult = resultSpan.textContent?.trim() ?? '';
  const claudeNormalized = claudeRawResult.replace(/^result:\s*/i, '');

  assert.equal(
    claudeNormalized,
    '20',
    'Claude-generated calculator should update the result span with the calculated value.',
  );
}

test('claude agent produces a verification plan', runClaudeScenario);

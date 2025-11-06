/**
 * @fileoverview Integration test that exercises Codex via the headless coder facade.
 *
 * The test instructs Codex to generate a web-based calculator in a temporary workspace,
 * then verifies the generated page behaves correctly by simulating user interaction
 * with JSDOM.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { createCoder } from '@headless-coders/core/factory';
import type { PromptInput } from '@headless-coders/core/types';

const TARGET_DIR = '/tmp/headless-coder/test';

/**
 * Prepares an empty working directory for Codex.
 *
 * Args:
 *   dir: Absolute path to the directory that should be initialised.
 *
 * Returns:
 *   Promise that resolves once the directory exists and is empty.
 *
 * Raises:
 *   Error: When the directory cannot be created or cleared.
 */
async function prepareWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * Builds the prompt instructing Codex to create a calculator web app.
 *
 * Args:
 *   targetDir: Absolute directory where Codex should write files.
 *
 * Returns:
 *   Prompt input compatible with the HeadlessCoder interface.
 */
function buildCalculatorPrompt(targetDir: string): PromptInput {
  const instructions = [
    `Create a minimal web-based calculator and save it as index.html in ${targetDir}.`,
    'Requirements:',
    '- Provide semantic HTML with two numeric inputs (ids: numberA, numberB), a select (id: operator) with "+", "-", "*", "/", and a button (id: compute).',
    '- Include a span with id="result" to display outcomes.',
    '- Add inline JavaScript that defines window.calculate(a, b, operator). The function must:',
    '  * Convert inputs to numbers, perform the requested operation, return the numeric result,',
    '  * Update the textContent of the result span with the formatted result.',
    '- Attach a click listener to the compute button that reads the form values and calls window.calculate.',
    '- Overwrite any existing index.html but do not create additional files or install dependencies.',
    '- Use only vanilla JavaScript and inline CSS; do not rely on external CDNs.',
  ].join('\n');

  return [
    {
      role: 'system',
      content:
        'You are an autonomous coding agent with filesystem access limited to the provided working directory.',
    },
    {
      role: 'user',
      content: instructions,
    },
  ];
}

/**
 * Executes the Codex generation flow and validates the resulting calculator.
 *
 * Args:
 *   t: Node test context used for lifecycle management.
 *
 * Returns:
 *   Promise that resolves once Codex output is generated and validated.
 *
 * Raises:
 *   Error: When Codex generation fails or the resulting calculator behaves incorrectly.
 */
async function runCalculatorScenario(t: TestContext): Promise<void> {
  await prepareWorkspace(TARGET_DIR);

  const coder = createCoder('codex', {
    workingDirectory: TARGET_DIR,
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
    model: process.env.CODEX_MODEL ?? undefined,
    codexExecutablePath: process.env.CODEX_EXECUTABLE_PATH ?? undefined,
  });

  const thread = await coder.startThread();
  const cleanup = async () => {
    await coder.close?.(thread);
  };
  const maybeCleanup = (t as { cleanup?: (fn: () => Promise<void> | void) => void }).cleanup;
  if (typeof maybeCleanup === 'function') {
    maybeCleanup(cleanup);
  } else {
    t.signal.addEventListener('abort', () => {
      void cleanup();
    });
  }

  const prompt = buildCalculatorPrompt(TARGET_DIR);

  try {
    await coder.run(thread, prompt);
  } catch (error) {
    throw new Error(
      'Codex failed to generate the calculator. Ensure the codex executable is available and licensed.',
      { cause: error instanceof Error ? error : undefined },
    );
  }

  const htmlPath = path.join(TARGET_DIR, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  assert.ok(html.toLowerCase().includes('calculator'), 'Generated HTML should reference a calculator UI.');

  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;

  assert.equal(typeof window.calculate, 'function', 'window.calculate must be defined.');
  const directResult = window.calculate(2, 3, '+');
  assert.equal(directResult, 5, 'Direct invocation should support addition.');

  const numberA = window.document.getElementById('numberA') as HTMLInputElement | null;
  const numberB = window.document.getElementById('numberB') as HTMLInputElement | null;
  const operator = window.document.getElementById('operator') as HTMLSelectElement | null;
  const button = window.document.getElementById('compute') as HTMLButtonElement | null;
  const resultSpan = window.document.getElementById('result');

  assert.ok(numberA && numberB && operator && button && resultSpan, 'Calculator controls must exist.');

  numberA.value = '12';
  numberB.value = '3';
  operator.value = '/';
  button.click();

  const rawResult = resultSpan.textContent?.trim() ?? '';
  const normalizedResult = rawResult.replace(/^result:\s*/i, '');

  assert.equal(
    normalizedResult,
    '4',
    'Clicking compute should update the result span with the calculated value.',
  );
}

test('codex generates a runnable web calculator', runCalculatorScenario);

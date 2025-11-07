/**
 * @fileoverview Validates Gemini CLI integration through the shared headless coder facade.
 *
 * The test instructs Gemini to generate a calculator in the designated workspace and verifies the output.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';
import type { PromptInput, RunResult } from '@headless-coders/core/types';

const GEMINI_WORKSPACE = process.env.GEMINI_TEST_WORKSPACE ?? '/tmp/headless-coder/test_gemini';
const GEMINI_TIMEOUT_MS = Number.parseInt(process.env.GEMINI_TEST_TIMEOUT_MS ?? '', 10) || 180_000;

/**
 * Ensures the Gemini working directory exists in a clean state.
 */
async function prepareWorkspace(dir: string): Promise<void> {
  await rm(path.join(dir, 'index.html'), { force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * Builds the prompt instructing Gemini to produce a calculator HTML file.
 */
function buildPrompt(workspace: string): PromptInput {
  const instructions = [
    `You are operating inside ${workspace}.`,
    'Tasks:',
    '- Overwrite index.html with a complete calculator web page.',
    '- Requirements:',
    '  * Use semantic HTML and wrap the interface within a main element.',
    '  * Provide numeric inputs with ids numberA and numberB, a select with id operator supporting +, -, *, /, and a button with id compute.',
    '  * Include a span with id="result" to display the outcome; descriptive prefixes like "Result:" are acceptable.',
    '  * Define window.calculate(a, b, operator) in inline JavaScript. It must parse numeric inputs, execute the selected operation, update the result span text, and return the numeric result.',
    '  * Ensure the compute button prevents default form submission, gathers values, and invokes window.calculate.',
    '  * Apply modest inline CSS for readability without external assets.',
    '- Do not create additional files or invoke shell commands beyond writing index.html.',
    '- Provide a short confirmation message after writing the file.',
  ].join('\n');

  return [
    { role: 'system', content: 'You are a deterministic engineer generating project files exactly as specified.' },
    { role: 'user', content: instructions },
  ];
}

/**
 * Enforces a timeout around asynchronous execution.
 */
async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Attempts to detect whether the Gemini CLI is available based on an error message.
 */
function isGeminiMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ENOENT|not found|command failed.*gemini/i.test(message);
}

/**
 * Executes the Gemini calculator scenario and validates the generated page.
 */
async function runGeminiScenario(t: TestContext): Promise<void> {
  await prepareWorkspace(GEMINI_WORKSPACE);

  const coder = createCoder(CODER_TYPES.GEMINI, {
    workingDirectory: GEMINI_WORKSPACE,
    includeDirectories: [GEMINI_WORKSPACE],
    yolo: true,
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
    result = await withinTimeout(
      coder.run(thread, buildPrompt(GEMINI_WORKSPACE)),
      GEMINI_TIMEOUT_MS,
      `Gemini integration test timed out after ${GEMINI_TIMEOUT_MS}ms.`,
    );
  } catch (error) {
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini integration test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }

  assert.ok(result.text || result.raw, 'Gemini should return confirmation content.');

  const htmlPath = path.join(GEMINI_WORKSPACE, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  assert.ok(html.includes('numberA'), 'Generated HTML should include the first input field.');

  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;

  assert.equal(typeof window.calculate, 'function', 'window.calculate must be defined.');

  const numberA = window.document.getElementById('numberA') as HTMLInputElement | null;
  const numberB = window.document.getElementById('numberB') as HTMLInputElement | null;
  const operator = window.document.getElementById('operator') as HTMLSelectElement | null;
  const compute = window.document.getElementById('compute') as HTMLButtonElement | null;
  const resultSpan = window.document.getElementById('result');

  assert.ok(numberA && numberB && operator && compute && resultSpan, 'Calculator DOM elements must exist.');

  numberA.value = '7';
  numberB.value = '6';
  operator.value = '+';
  compute.click();

  const rawResult = resultSpan.textContent?.trim() ?? '';
  const normalized = rawResult.replace(/^result:\s*/i, '');
  assert.ok(/\d/.test(normalized), 'Gemini-generated calculator should update the result span with numeric output.');
}

test('gemini generates a runnable web calculator', runGeminiScenario);

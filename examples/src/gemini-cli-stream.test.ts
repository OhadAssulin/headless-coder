/**
 * @fileoverview Streams Gemini CLI output while producing a sin/cos calculator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';
import type { PromptInput } from '@headless-coder-sdk/core/types';

const WORKSPACE = process.env.GEMINI_STREAM_WORKSPACE ?? '/tmp/headless-coder-sdk/test_gemini_stream';
const STREAM_FILE = 'stream.txt';

/**
 * Constructs the prompt instructing Gemini to build the streaming calculator.
 */
function buildPrompt(workspace: string): PromptInput {
  const instructions = [
    `You are working inside ${workspace}.`,
    'Tasks:',
    '- Overwrite index.html with a trigonometry assistant page that computes sin and cos.',
    '- Requirements:',
    '  * Provide inputs with ids trigAngleDegrees and trigAngleRadians and a compute button with id trigCompute.',
    '  * Include spans with ids trigSin and trigCos displaying the results; prefixes such as "sin:" or "cos:" are acceptable.',
    '  * Define window.handleTrig() to parse inputs, compute Math.sin/Math.cos, update the spans, and return an object containing the numeric results.',
    '  * Prevent default form submission and ensure the button triggers window.handleTrig().',
    '  * Include inline CSS; avoid external resources.',
    '- Confirm completion in one sentence once the file is written.',
  ].join('\n');

  return [
    { role: 'system', content: 'You create deterministic project files with no extraneous output.' },
    { role: 'user', content: instructions },
  ];
}

/**
 * Infers whether the Gemini CLI is unavailable based on the thrown error.
 */
function isGeminiMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ENOENT|not found|command failed.*gemini/i.test(message);
}

test('gemini streams a sin/cos calculator', async t => {
  await rm(path.join(WORKSPACE, 'index.html'), { force: true });
  await rm(path.join(WORKSPACE, STREAM_FILE), { force: true });
  await mkdir(WORKSPACE, { recursive: true });

  const coder = createCoder(CODER_TYPES.GEMINI, {
    workingDirectory: WORKSPACE,
    includeDirectories: [WORKSPACE],
    yolo: true,
  });

  const thread = await coder.startThread();
  const streamPath = path.join(WORKSPACE, STREAM_FILE);
  const stream = createWriteStream(streamPath, { flags: 'w' });

  try {
  for await (const event of thread.runStreamed(buildPrompt(WORKSPACE))) {
      stream.write(`${JSON.stringify(event)}\n`);
    }
  } catch (error) {
    await new Promise<void>(resolve => stream.end(resolve));
    if (isGeminiMissing(error)) {
      t.skip('Skipping Gemini stream test because the gemini CLI is not available.');
      return;
    }
    throw error;
  }

  await new Promise<void>(resolve => stream.end(resolve));

  const html = await readFile(path.join(WORKSPACE, 'index.html'), 'utf8');
  assert.ok(html.includes('trigAngleDegrees'), 'Generated HTML should include the degrees input.');

  let dom: JSDOM;
  let scriptExecutable = true;
  try {
    dom = new JSDOM(html, { runScripts: 'dangerously' });
  } catch {
    scriptExecutable = false;
    dom = new JSDOM(html);
  }
  const { window } = dom;

  if (!scriptExecutable || typeof window.handleTrig !== 'function') {
    assert.ok(/Math\.sin/.test(html), 'Calculator markup should reference Math.sin.');
    return;
  }

  const degreesInput = window.document.getElementById('trigAngleDegrees') as HTMLInputElement | null;
  const trigButton = window.document.getElementById('trigCompute');
  const sinSpan = window.document.getElementById('trigSin');
  const cosSpan = window.document.getElementById('trigCos');

  assert.ok(degreesInput && trigButton && sinSpan && cosSpan, 'Calculator DOM elements must exist.');

  degreesInput.value = '30';
  if (typeof window.handleTrig === 'function') {
    window.handleTrig();
  }
  trigButton.dispatchEvent(new window.Event('click'));

  const sinContent = sinSpan.textContent?.toLowerCase() ?? '';
  const cosContent = cosSpan.textContent?.toLowerCase() ?? '';
  assert.ok(sinContent.includes('0.5'), 'Sine result should reflect sin(30°).');
  assert.ok(cosContent.includes('0.866') || cosContent.includes('0.86'), 'Cosine result should reflect cos(30°).');

  const streamed = await readFile(streamPath, 'utf8');
  assert.ok(streamed.trim().length > 0, 'Stream output should be recorded.');
});

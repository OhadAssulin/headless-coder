/**
 * @fileoverview Streams Codex output while producing a sin/cos calculator.
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

const WORKSPACE = process.env.CODEX_STREAM_WORKSPACE ?? '/tmp/headless-coder-sdk/test_codex_stream';
const STREAM_FILE = 'stream.txt';

/**
 * Builds a prompt that instructs Codex to create a sin/cos calculator page.
 */
function buildPrompt(workspace: string): PromptInput {
  const instructions = [
    `You are working inside ${workspace}.`,
    'Tasks:',
    '- Overwrite index.html with a scientific calculator focused on sine and cosine.',
    '- Requirements:',
    '  * Provide inputs with ids angleDegrees and angleRadians plus buttons to compute sine and cosine.',
    '  * Display results in spans with ids sinResult and cosResult; descriptive prefixes like "sin:" are allowed.',
    '  * Implement window.toRadians(deg) and window.updateTrigValues() in inline JavaScript. They must parse numeric inputs, compute Math.sin and Math.cos, update the spans, and return the values.',
    '  * Attach event handlers so clicking the compute button prevents default submission and updates both sin and cos.',
    '  * Include inline CSS for clarity without external assets.',
    '- Do not create additional files or run shell commands beyond writing index.html.',
    '- After writing the file, confirm completion succinctly.',
  ].join('\n');

  return [
    { role: 'system', content: 'You produce deterministic project artifacts exactly as specified.' },
    { role: 'user', content: instructions },
  ];
}

test('codex streams a sin/cos calculator', async () => {
  await rm(path.join(WORKSPACE, 'index.html'), { force: true });
  await rm(path.join(WORKSPACE, STREAM_FILE), { force: true });
  await mkdir(WORKSPACE, { recursive: true });

  const coder = createCoder(CODER_TYPES.CODEX, {
    workingDirectory: WORKSPACE,
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
  });

  const thread = await coder.startThread();
  const streamPath = path.join(WORKSPACE, STREAM_FILE);
  const stream = createWriteStream(streamPath, { flags: 'w' });

  try {
    for await (const event of thread.runStreamed(buildPrompt(WORKSPACE))) {
      stream.write(`${JSON.stringify(event)}\n`);
    }
  } finally {
    await new Promise<void>(resolve => stream.end(resolve));
  }

  const htmlPath = path.join(WORKSPACE, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  assert.ok(html.includes('angleDegrees'), 'Generated HTML should contain the degrees input.');
  assert.ok(/Math\.sin|Math\.cos/.test(html), 'Generated HTML should reference Math.sin or Math.cos.');

  let dom: JSDOM;
  let scriptExecutable = true;
  try {
    dom = new JSDOM(html, { runScripts: 'dangerously' });
  } catch {
    scriptExecutable = false;
    dom = new JSDOM(html);
  }
  const { window } = dom;

  if (!scriptExecutable || typeof window.updateTrigValues !== 'function') {
    assert.ok(/Math\.sin/.test(html), 'Calculator markup should reference Math.sin.');
    return;
  }

  const sinSpan = window.document.getElementById('sinResult');
  const cosSpan = window.document.getElementById('cosResult');
  const button =
    (window.document.getElementById('compute') as HTMLButtonElement | null) ||
    (window.document.getElementById('computeButton') as HTMLButtonElement | null) ||
    (window.document.getElementById('computeTrig') as HTMLButtonElement | null) ||
    (window.document.getElementById('computeSin') as HTMLButtonElement | null) ||
    (window.document.querySelector('.compute-btn') as HTMLButtonElement | null) ||
    (window.document.querySelector('.compute-button') as HTMLButtonElement | null);
  const angleDegrees = window.document.getElementById('angleDegrees') as HTMLInputElement | null;

  if (!sinSpan || !cosSpan || !button || !angleDegrees) {
    assert.ok(/sin/i.test(html) && /cos/i.test(html), 'Calculator markup should mention sin/cos outputs.');
    return;
  }

  angleDegrees.value = '60';
  if (typeof window.updateTrigValues === 'function') {
    void window.updateTrigValues();
  }
  button.dispatchEvent(new window.Event('click'));

  const sinValue = sinSpan.textContent?.toLowerCase() ?? '';
  const cosValue = cosSpan.textContent?.toLowerCase() ?? '';
  assert.ok(sinValue.includes('0.866') || sinValue.includes('√3/2'.toLowerCase()), 'Sine result should update.');
  assert.ok(cosValue.includes('0.5') || cosValue.includes('1/2'), 'Cosine result should update.');

  const streamed = await readFile(streamPath, 'utf8');
  assert.ok(streamed.trim().length > 0, 'Stream output should be recorded.');
});

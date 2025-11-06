/**
 * @fileoverview Streams Claude output while producing a sin/cos calculator.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { createCoder } from '@headless-coders/core/factory';
import type { PromptInput } from '@headless-coders/core/types';

const WORKSPACE = process.env.CLAUDE_STREAM_WORKSPACE ?? '/tmp/headless-coder/test_claude_stream';
const STREAM_FILE = 'stream.txt';

/**
 * Prepares the Claude workspace by removing prior artifacts and ensuring directories exist.
 */
async function ensureWorkspace(dir: string): Promise<void> {
  await rm(path.join(dir, 'index.html'), { force: true });
  await rm(path.join(dir, STREAM_FILE), { force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * Loads Claude configuration settings from the workspace into process.env.
 */
async function loadClaudeEnvironment(dir: string): Promise<void> {
  const configDir = path.join(dir, '.claude');
  await hydrateClaudeConfig(configDir);
  await mkdir(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const configs = ['settings.json', 'settings.local.json'];
  for (const name of configs) {
    const file = path.join(configDir, name);
    try {
      await access(file, fsConstants.R_OK);
    } catch {
      continue;
    }
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw) as { env?: Record<string, string> };
    for (const [key, value] of Object.entries(parsed.env ?? {})) {
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Copies Claude configuration from a known source directory when present.
 */
async function hydrateClaudeConfig(targetDir: string): Promise<void> {
  const sourceDir = process.env.CLAUDE_STREAM_CONFIG_SOURCE ?? '/tmp/headless-coder/test_claude/.claude';
  try {
    await access(sourceDir, fsConstants.R_OK);
  } catch {
    return;
  }
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

/**
 * Constructs the prompt used to instruct Claude to build the calculator.
 */
function buildPrompt(workspace: string): PromptInput {
  const instructions = [
    `You are working inside ${workspace}.`,
    'Tasks:',
    '- Overwrite index.html with a sin/cos calculator.',
    '- Requirements:',
    '  * Provide inputs for degrees and radians plus a compute button (ids: degreesInput, radiansInput, computeTrig).',
    '  * Place spans with ids sinValue and cosValue to display results; numeric outputs may include prefixes.',
    '  * Define window.computeTrig() in inline JavaScript to parse inputs, compute Math.sin/Math.cos, update spans, and return the values.',
    '  * Ensure clicking computeTrig prevents default submission and calls window.computeTrig().',
    '  * Include helper functions for converting between degrees and radians.',
    '  * Use inline CSS; avoid external dependencies.',
    '- Confirm completion with a single sentence.',
  ].join('\n');

  return [
    { role: 'system', content: 'You generate deterministic project files.' },
    { role: 'user', content: instructions },
  ];
}

/**
 * Executes the streaming scenario for Claude and validates the generated calculator.
 */
async function runClaudeScenario(t: TestContext): Promise<void> {
  await ensureWorkspace(WORKSPACE);
  await loadClaudeEnvironment(WORKSPACE);

  const hasAnthropicKey =
    !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_API_KEY || !!process.env.ANTHROPIC_API_TOKEN;
  const hasBedrockToken = !!process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!hasAnthropicKey && !hasBedrockToken) {
    t.skip('Skipping Claude stream test because Claude credentials are unavailable.');
    return;
  }

  const coder = createCoder('claude', {
    workingDirectory: WORKSPACE,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Write', 'Edit', 'Read', 'NotebookEdit'],
  });

  const thread = await coder.startThread();
  const streamPath = path.join(WORKSPACE, STREAM_FILE);
  const stream = createWriteStream(streamPath, { flags: 'w' });

  try {
    for await (const event of coder.runStreamed(thread, buildPrompt(WORKSPACE))) {
      stream.write(`${JSON.stringify(event)}\n`);
    }
  } finally {
    await new Promise<void>(resolve => stream.end(resolve));
  }

  const html = await readFile(path.join(WORKSPACE, 'index.html'), 'utf8');
  assert.ok(html.includes('degreesInput'), 'Generated HTML should include the degrees input.');

  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;

  assert.equal(typeof window.computeTrig, 'function', 'computeTrig must be defined.');

  const degreesInput = window.document.getElementById('degreesInput') as HTMLInputElement | null;
  const cosSpan = window.document.getElementById('cosValue');
  const sinSpan = window.document.getElementById('sinValue');
  const button = window.document.getElementById('computeTrig');

  assert.ok(degreesInput && cosSpan && sinSpan && button, 'Calculator DOM elements must exist.');

  degreesInput.value = '90';
  if (typeof window.computeTrig === 'function') {
    window.computeTrig();
  }
  button.dispatchEvent(new window.Event('click'));

  const sinContent = sinSpan.textContent?.toLowerCase() ?? '';
  const cosContent = cosSpan.textContent?.toLowerCase() ?? '';
  assert.ok(sinContent.includes('1'), 'Sine result should reflect sin(90°).');
  assert.ok(cosContent.includes('0'), 'Cosine result should reflect cos(90°).');

  const streamed = await readFile(streamPath, 'utf8');
  assert.ok(streamed.trim().length > 0, 'Stream output should be recorded.');
}

test('claude streams a sin/cos calculator', runClaudeScenario);

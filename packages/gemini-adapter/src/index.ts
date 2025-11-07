/**
 * @fileoverview Gemini CLI adapter integrating with the HeadlessCoder contract.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { now } from '@headless-coders/core';
import type {
  HeadlessCoder,
  ThreadHandle,
  PromptInput,
  StartOpts,
  RunOpts,
  RunResult,
  CoderStreamEvent,
  EventIterator,
  Provider,
} from '@headless-coders/core';

const STRUCTURED_OUTPUT_SUFFIX =
  'Respond with JSON that matches the provided schema. Do not include explanatory text outside the JSON.';

/**
 * Resolves the Gemini binary path, honoring user overrides.
 *
 * Args:
 *   override: Optional executable override.
 *
 * Returns:
 *   Binary path to invoke.
 */
function geminiPath(override?: string): string {
  return override || 'gemini';
}

/**
 * Normalises prompt input into a single string for CLI invocation.
 *
 * Args:
 *   input: Prompt payload.
 *
 * Returns:
 *   Prompt string understood by Gemini CLI.
 */
function toPrompt(input: PromptInput): string {
  if (typeof input === 'string') return input;
  return input.map(message => `${message.role}: ${message.content}`).join('\n');
}

function applyOutputSchemaPrompt(input: PromptInput, schema?: object): string {
  if (!schema) return toPrompt(input);
  const schemaText = JSON.stringify(schema, null, 2);
  const instruction = `${STRUCTURED_OUTPUT_SUFFIX}\nSchema:\n${schemaText}`;
  if (typeof input === 'string') {
    return `${input}\n\n${instruction}`;
  }
  return toPrompt([{ role: 'system', content: instruction }, ...input]);
}

function extractJsonPayload(text: string | undefined): unknown | undefined {
  if (!text) return undefined;
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Adapter that proxies Gemini CLI headless invocations.
 *
 * Args:
 *   defaultOpts: Default options used whenever callers omit overrides.
 */
export class GeminiAdapter implements HeadlessCoder {
  /**
   * Creates a new Gemini adapter instance.
   *
   * Args:
   *   defaultOpts: Default options used whenever callers omit overrides.
   */
  constructor(private readonly defaultOpts?: StartOpts) {}

  /**
   * Creates a thread handle encapsulating Gemini options.
   *
   * Args:
   *   opts: Start options for the thread lifecycle.
   *
   * Returns:
   *   Thread handle stub (Gemini is stateless).
   */
  async startThread(opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    return { provider: 'gemini', internal: { opts: options } };
  }

  /**
   * Produces a thread handle for a previously known identifier.
   *
   * Args:
   *   threadId: Gemini session identifier (best-effort).
   *   opts: Options that should apply to future runs.
   *
   * Returns:
   *   Thread handle referencing Gemini state.
   */
  async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    return { provider: 'gemini', id: threadId, internal: { opts: options } };
  }

  /**
   * Runs Gemini CLI and returns the parsed JSON response when available.
   *
   * Args:
   *   thread: Thread handle.
   *   input: Prompt payload.
   *   opts: Run-level configuration such as additional env vars.
   *
   * Returns:
   *   Parsed run result.
   *
   * Raises:
   *   Error: When the Gemini CLI exits with a non-zero status.
   */
  async run(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
    const startOpts = ((thread.internal as any)?.opts ?? {}) as StartOpts;
    const prompt = applyOutputSchemaPrompt(input, opts?.outputSchema);
    const args = ['--output-format', 'json', '--prompt', prompt];
    if (startOpts.model) args.push('--model', startOpts.model);
    if (startOpts.includeDirectories?.length) {
      args.push('--include-directories', startOpts.includeDirectories.join(','));
    }
    if (startOpts.yolo) args.push('--yolo');

    const proc = spawn(geminiPath(startOpts.geminiBinaryPath), args, {
      cwd: startOpts.workingDirectory,
      env: { ...process.env, ...(opts?.extraEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    const stderr: string[] = [];
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', chunk => {
      stderr.push(chunk.toString('utf8'));
    });

    const exitCode = await new Promise<number>(resolve => proc.on('close', resolve));
    if (exitCode !== 0) {
      throw new Error(`gemini exited with code ${exitCode}: ${stderr.join('')}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { response: stdout };
    }

    const text = parsed.response ?? parsed.text ?? stdout;
    const structured = opts?.outputSchema ? extractJsonPayload(text) : undefined;
    return {
      threadId: parsed.session_id ?? thread.id,
      text,
      json: structured ?? parsed.json,
      usage: parsed.stats,
      raw: parsed,
    };
  }

  /**
   * Streams Gemini CLI output and maps events into the shared shape.
   *
   * Args:
   *   thread: Thread handle used for contextual options.
   *   input: Prompt payload.
   *   opts: Run-level modifiers (e.g., environment variables).
   *
   * Returns:
   *   Async iterator over stream events.
   *
   * Raises:
   *   Error: When the Gemini CLI process fails before emitting events.
   */
  async *runStreamed(
    thread: ThreadHandle,
    input: PromptInput,
    opts?: RunOpts,
  ): EventIterator {
    const startOpts = ((thread.internal as any)?.opts ?? {}) as StartOpts;
    const prompt = applyOutputSchemaPrompt(input, opts?.outputSchema);
    const args = ['--output-format', 'stream-json', '--prompt', prompt];
    if (startOpts.model) args.push('--model', startOpts.model);
    if (startOpts.includeDirectories?.length) {
      args.push('--include-directories', startOpts.includeDirectories.join(','));
    }
    if (startOpts.yolo) args.push('--yolo');

    const proc = spawn(geminiPath(startOpts.geminiBinaryPath), args, {
      cwd: startOpts.workingDirectory,
      env: { ...process.env, ...(opts?.extraEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: proc.stdout });
    for await (const line of rl) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.session_id) {
        thread.id = event.session_id;
      }

      for (const normalized of normalizeGeminiEvent(event)) {
        yield normalized;
      }
    }
  }

  /**
   * Returns last known Gemini session identifier.
   *
   * Args:
   *   thread: Thread handle.
   *
   * Returns:
   *   Session identifier if present.
   */
  getThreadId(thread: ThreadHandle): string | undefined {
    return thread.id;
  }
}

function normalizeGeminiEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = 'gemini';
  const type = event?.type;
  const normalized: CoderStreamEvent[] = [];

  switch (type) {
    case 'init':
      normalized.push({
        type: 'init',
        provider,
        threadId: event.session_id,
        model: event.model,
        raw: event,
        ts,
      });
      return normalized;
    case 'message':
      normalized.push({
        type: 'message',
        provider,
        role: event.role ?? 'assistant',
        text: event.content,
        delta: !!event.delta,
        raw: event,
        ts,
      });
      return normalized;
    case 'tool_use':
      normalized.push({
        type: 'tool_use',
        provider,
        name: event.tool_name ?? 'tool',
        callId: event.call_id,
        args: event.args,
        raw: event,
        ts,
      });
      return normalized;
    case 'tool_result':
      normalized.push({
        type: 'tool_result',
        provider,
        name: event.tool_name ?? 'tool',
        callId: event.call_id,
        result: event.result,
        exitCode: event.exit_code ?? null,
        raw: event,
        ts,
      });
      return normalized;
    case 'error':
      normalized.push({
        type: 'error',
        provider,
        message: event.message ?? 'gemini error',
        raw: event,
        ts,
      });
      return normalized;
    case 'result': {
      if (event.stats) {
        normalized.push({ type: 'usage', provider, stats: event.stats, raw: event, ts });
      }
      normalized.push({ type: 'done', provider, raw: event, ts });
      return normalized;
    }
    default:
      normalized.push({
        type: 'progress',
        provider,
        label: typeof type === 'string' ? type : 'gemini.event',
        raw: event,
        ts,
      });
      return normalized;
  }
}

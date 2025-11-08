/**
 * @fileoverview Gemini CLI adapter integrating with the HeadlessCoderSdk contract.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { now } from '@headless-coder-sdk/core';
import type {
  HeadlessCoderSdk,
  ThreadHandle,
  PromptInput,
  StartOpts,
  RunOpts,
  RunResult,
  CoderStreamEvent,
  EventIterator,
  Provider,
} from '@headless-coder-sdk/core';

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
export class GeminiAdapter implements HeadlessCoderSdk {
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
    return this.createThreadHandle(options);
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
    return this.createThreadHandle(options, threadId);
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
  private async runInternal(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
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
  private async *runStreamedInternal(
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

  private createThreadHandle(options: StartOpts, threadId?: string): ThreadHandle {
    const handle: ThreadHandle = {
      provider: 'gemini',
      id: threadId,
      internal: { opts: options },
      run: (input, opts) => this.runInternal(handle, input, opts),
      runStreamed: (input, opts) => this.runStreamedInternal(handle, input, opts),
    };
    return handle;
  }
}

function normalizeGeminiEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = 'gemini';
  const ev = event ?? {};

  switch (ev.type) {
    case 'init':
      return [
        {
          type: 'init',
          provider,
          threadId: ev.session_id,
          model: ev.model,
          ts,
          originalItem: ev,
        },
      ];
    case 'message':
      return [
        {
          type: 'message',
          provider,
          role: ev.role ?? 'assistant',
          text: ev.content,
          delta: !!ev.delta,
          ts,
          originalItem: ev,
        },
      ];
    case 'tool_use':
      return [
        {
          type: 'tool_use',
          provider,
          name: ev.tool_name ?? 'tool',
          callId: ev.call_id,
          args: ev.args,
          ts,
          originalItem: ev,
        },
      ];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          provider,
          name: ev.tool_name ?? 'tool',
          callId: ev.call_id,
          result: ev.result,
          exitCode: ev.exit_code ?? null,
          ts,
          originalItem: ev,
        },
      ];
    case 'error':
      return [
        {
          type: 'error',
          provider,
          message: ev.message ?? 'gemini error',
          ts,
          originalItem: ev,
        },
      ];
    case 'result': {
      const out: CoderStreamEvent[] = [];
      if (ev.stats) {
        out.push({ type: 'usage', provider, stats: ev.stats, ts, originalItem: ev });
      }
      out.push({ type: 'done', provider, ts, originalItem: ev });
      return out;
    }
    default:
      return [
        {
          type: 'progress',
          provider,
          label: typeof ev.type === 'string' ? ev.type : 'gemini.event',
          ts,
          originalItem: ev,
        },
      ];
  }
}

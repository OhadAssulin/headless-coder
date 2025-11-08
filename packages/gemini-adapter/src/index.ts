/**
 * @fileoverview Gemini CLI adapter integrating with the HeadlessCoder contract.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { once } from 'node:events';
import { now } from '@headless-coder-sdk/core';
import type {
  AdapterFactory,
  HeadlessCoder,
  ThreadHandle,
  PromptInput,
  StartOpts,
  RunOpts,
  RunResult,
  CoderStreamEvent,
  EventIterator,
  Provider,
} from '@headless-coder-sdk/core';

export const CODER_NAME: Provider = 'gemini';

export function createAdapter(defaults?: StartOpts): HeadlessCoder {
  return new GeminiAdapter(defaults);
}
(createAdapter as AdapterFactory).coderName = CODER_NAME;

const STRUCTURED_OUTPUT_SUFFIX =
  'Respond with JSON that matches the provided schema. Do not include explanatory text outside the JSON.';

const SOFT_KILL_DELAY_MS = 250;
const HARD_KILL_DELAY_MS = 1500;
const DONE = Symbol('gemini-stream-done');

interface GeminiThreadState {
  id?: string;
  opts: StartOpts;
  currentRun?: ActiveRun | null;
}

interface ActiveRun {
  child: ChildProcess;
  abortController: AbortController;
  stopExternal: () => void;
  aborted: boolean;
  abortReason?: string;
  softKillTimer?: NodeJS.Timeout;
  hardKillTimer?: NodeJS.Timeout;
}

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
    const state: GeminiThreadState = { opts: options };
    return this.createThreadHandle(state);
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
    const state: GeminiThreadState = { opts: options, id: threadId };
    return this.createThreadHandle(state);
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
  private async runInternal(handle: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
    const state = handle.internal as GeminiThreadState;
    this.assertIdle(state);
    const prompt = applyOutputSchemaPrompt(input, opts?.outputSchema);
    const { child, active, cleanup } = this.spawnGeminiProcess(state, prompt, 'json', opts);
    try {
      const { stdout, stderr, exitCode } = await waitForChild(child);
      if (active.aborted) {
        throw createAbortError(active.abortReason);
      }
      if (exitCode !== 0) {
        throw new Error(`gemini exited with code ${exitCode}: ${stderr}`);
      }
      const parsed = parseGeminiJson(stdout);
      if (parsed.session_id) {
        state.id = parsed.session_id;
        handle.id = parsed.session_id;
      }
      const text = parsed.response ?? parsed.text ?? stdout;
      const structured = opts?.outputSchema ? extractJsonPayload(text) : undefined;
      return {
        threadId: state.id,
        text,
        json: structured ?? parsed.json,
        usage: parsed.stats,
        raw: parsed,
      };
    } finally {
      cleanup();
    }
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
  private runStreamedInternal(handle: ThreadHandle, input: PromptInput, opts?: RunOpts): EventIterator {
    const state = handle.internal as GeminiThreadState;
    this.assertIdle(state);
    const prompt = applyOutputSchemaPrompt(input, opts?.outputSchema);
    const { child, active, cleanup } = this.spawnGeminiProcess(state, prompt, 'stream-json', opts);
    const queue: Array<CoderStreamEvent | typeof DONE | Error> = [];
    const waiters: Array<(entry: CoderStreamEvent | typeof DONE | Error) => void> = [];
    let finished = false;

    const push = (entry: CoderStreamEvent | typeof DONE | Error) => {
      if (waiters.length) {
        waiters.shift()!(entry);
      } else {
        queue.push(entry);
      }
    };

    const next = () => {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (finished) return Promise.resolve(DONE);
      return new Promise<CoderStreamEvent | typeof DONE | Error>(resolve => waiters.push(resolve));
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (finished) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.session_id) {
        state.id = event.session_id;
        handle.id = event.session_id;
      }
      for (const normalized of normalizeGeminiEvent(event)) {
        push(normalized);
      }
    });

    const onExit = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (active.aborted) {
        push({
          type: 'cancelled',
          provider: CODER_NAME,
          ts: now(),
          originalItem: { reason: active.abortReason ?? 'Interrupted' },
        });
        push(DONE);
        return;
      }
      if (code !== 0) {
        push(new Error(`gemini exited with code ${code}`));
      }
      push(DONE);
    };

    child.once('exit', onExit);
    child.once('error', error => {
      if (finished) return;
      finished = true;
      push(error);
      push(DONE);
    });

    const iterator = {
      [Symbol.asyncIterator]: async function* (this: GeminiAdapter) {
        try {
          while (true) {
            const entry = await next();
            if (entry === DONE) break;
            if (entry instanceof Error) throw entry;
            yield entry;
          }
        } finally {
          cleanup();
          rl.close();
          if (!finished && !active.aborted) {
            this.abortChild(state, 'Stream closed');
          }
        }
      }.bind(this),
    };

    return iterator;
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
    const state = thread.internal as GeminiThreadState;
    return state.id;
  }

  private createThreadHandle(state: GeminiThreadState): ThreadHandle {
    const handle: ThreadHandle = {
      provider: CODER_NAME,
      id: state.id,
      internal: state,
      run: (input, opts) => this.runInternal(handle, input, opts),
      runStreamed: (input, opts) => this.runStreamedInternal(handle, input, opts),
      interrupt: async reason => {
        this.abortChild(state, reason ?? 'Interrupted');
      },
    };
    return handle;
  }

  private spawnGeminiProcess(
    state: GeminiThreadState,
    prompt: string,
    mode: 'json' | 'stream-json',
    opts?: RunOpts,
  ) {
    const startOpts = state.opts ?? {};
    const args = buildGeminiArgs(startOpts, prompt, mode);
    const child = spawn(geminiPath(startOpts.geminiBinaryPath), args, {
      cwd: startOpts.workingDirectory,
      env: { ...process.env, ...(opts?.extraEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const abortController = new AbortController();
    const stopExternal = linkSignal(opts?.signal, reason => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason ?? 'Interrupted');
        this.abortChild(state, reason);
      }
    });

    const active: ActiveRun = {
      child,
      abortController,
      stopExternal,
      aborted: false,
    };
    state.currentRun = active;

    child.once('error', () => {
      // handled by waiters
    });

    return {
      child,
      active,
      cleanup: () => {
        stopExternal();
        this.clearKillTimers(active);
        if (state.currentRun === active) {
          state.currentRun = null;
        }
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGTERM');
        }
      },
    };
  }

  private abortChild(state: GeminiThreadState, reason?: string): void {
    const active = state.currentRun;
    if (!active || active.aborted) return;
    active.aborted = true;
    active.abortReason = reason ?? 'Interrupted';
    try {
      active.child.stdin?.end();
    } catch {
      // ignore
    }
    if (!active.softKillTimer) {
      active.softKillTimer = setTimeout(() => {
        if (!active.child.killed) {
          active.child.kill('SIGTERM');
        }
      }, SOFT_KILL_DELAY_MS);
    }
    if (!active.hardKillTimer) {
      active.hardKillTimer = setTimeout(() => {
        if (!active.child.killed) {
          active.child.kill('SIGKILL');
        }
      }, HARD_KILL_DELAY_MS);
    }
  }

  private clearKillTimers(active: ActiveRun): void {
    if (active.softKillTimer) {
      clearTimeout(active.softKillTimer);
      active.softKillTimer = undefined;
    }
    if (active.hardKillTimer) {
      clearTimeout(active.hardKillTimer);
      active.hardKillTimer = undefined;
    }
  }

  private assertIdle(state: GeminiThreadState): void {
    if (state.currentRun) {
      throw new Error('Gemini adapter only supports one in-flight run per thread.');
    }
  }
}

function normalizeGeminiEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = CODER_NAME;
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

function buildGeminiArgs(opts: StartOpts, prompt: string, format: 'json' | 'stream-json'): string[] {
  const args = ['--output-format', format, '--prompt', prompt];
  if (opts.model) args.push('--model', opts.model);
  if (opts.includeDirectories?.length) {
    args.push('--include-directories', opts.includeDirectories.join(','));
  }
  if (opts.yolo) args.push('--yolo');
  return args;
}

async function waitForChild(child: ChildProcess): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
{
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
      });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function parseGeminiJson(output: string): any {
  try {
    return JSON.parse(output);
  } catch {
    return { response: output };
  }
}

function linkSignal(signal: AbortSignal | undefined, onAbort: (reason?: string) => void): () => void {
  if (!signal) return () => {};
  const handler = () => onAbort(reasonToString(signal.reason));
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

function createAbortError(reason?: string): Error {
  const error = new Error(reason ?? 'Operation was interrupted');
  error.name = 'AbortError';
  (error as any).code = 'interrupted';
  return error;
}

function reasonToString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return undefined;
}

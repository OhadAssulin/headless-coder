/**
 * @fileoverview Codex adapter that conforms to the HeadlessCoder interface while
 * delegating directly to the Codex SDK with AbortSignal-based cancellation.
 */

import type { Thread, TurnOptions } from '@openai/codex-sdk';
import {
  now,
  registerAdapter,
  getAdapterFactory,
  createCoder,
} from '@headless-coder-sdk/core';
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

const isNodeRuntime = typeof process !== 'undefined' && !!process.versions?.node;

type CodexModule = typeof import('@openai/codex-sdk');
let codexModule: CodexModule | undefined;
let codexModulePromise: Promise<CodexModule> | undefined;

async function loadCodexModule(): Promise<CodexModule> {
  if (codexModule) return codexModule;
  if (!codexModulePromise) {
    codexModulePromise = import('@openai/codex-sdk').then(module => {
      codexModule = module;
      return module;
    });
  }
  return codexModulePromise;
}

function ensureNodeRuntime(action: string): void {
  if (!isNodeRuntime) {
    throw new Error(
      `@headless-coder-sdk/codex-adapter can only ${action} inside a Node.js runtime.`,
    );
  }
}

export const CODER_NAME: Provider = 'codex';
export function createAdapter(defaults?: StartOpts): HeadlessCoder {
  return new CodexAdapter(defaults);
}
(createAdapter as AdapterFactory).coderName = CODER_NAME;

export function createHeadlessCodex(defaults?: StartOpts): HeadlessCoder {
  if (!getAdapterFactory(CODER_NAME)) {
    registerAdapter(createAdapter as AdapterFactory);
  }
  ensureNodeRuntime('create a Codex coder');
  return createCoder(CODER_NAME, defaults);
}

interface CodexThreadOptions {
  model?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
}

interface CodexThreadState {
  id?: string;
  options: CodexThreadOptions;
  codexExecutablePath?: string;
  currentRun?: ActiveRun | null;
}

interface CodexRunSummary {
  items: any[];
  finalResponse: string;
  structured?: unknown;
  usage?: any;
}

type RunTurnOptions = Pick<TurnOptions, 'outputSchema' | 'signal'>;

interface ActiveRun {
  abortController: AbortController;
  stopExternal: () => void;
  aborted: boolean;
  abortReason?: string;
}

export class CodexAdapter implements HeadlessCoder {
  constructor(private readonly defaultOpts?: StartOpts) {}

  async startThread(opts?: StartOpts): Promise<ThreadHandle> {
    const merged = this.mergeStartOpts(opts);
    const state: CodexThreadState = {
      options: this.extractThreadOptions(merged),
      codexExecutablePath: merged.codexExecutablePath,
    };
    return this.createThreadHandle(state);
  }

  async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
    const merged = this.mergeStartOpts(opts);
    const state: CodexThreadState = {
      id: threadId,
      options: this.extractThreadOptions(merged),
      codexExecutablePath: merged.codexExecutablePath,
    };
    return this.createThreadHandle(state);
  }

  private async runInternal(handle: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
    ensureNodeRuntime('call Codex');
    const state = handle.internal as CodexThreadState;
    this.assertIdle(state);
    const normalizedInput = normalizeInput(input);
    const abortController = new AbortController();
    const stopExternal = linkSignal(opts?.signal, reason => {
      this.abortCurrentRun(state, reason ?? 'Interrupted');
    });
    const active: ActiveRun = {
      abortController,
      stopExternal,
      aborted: false,
    };
    state.currentRun = active;

    try {
      const thread = await this.createThread(state);
      const summary = await collectRunSummary(thread, normalizedInput, {
        outputSchema: opts?.outputSchema,
        signal: abortController.signal,
      });
      const threadId = thread.id ?? undefined;
      if (threadId) {
        state.id = threadId;
        handle.id = threadId;
      }
      return this.mapRunResult(summary, threadId);
    } catch (error) {
      if (isAbortError(error)) {
        const reason =
          active.abortReason ??
          reasonToString(abortController.signal.reason) ??
          (error instanceof Error ? error.message : undefined);
        throw createAbortError(reason);
      }
      throw error;
    } finally {
      stopExternal();
      if (state.currentRun === active) {
        state.currentRun = null;
      }
    }
  }

  private runStreamedInternal(handle: ThreadHandle, input: PromptInput, opts?: RunOpts): EventIterator {
    ensureNodeRuntime('stream Codex events');
    const state = handle.internal as CodexThreadState;
    this.assertIdle(state);
    const normalizedInput = normalizeInput(input);
    const abortController = new AbortController();
    const stopExternal = linkSignal(opts?.signal, reason => {
      this.abortCurrentRun(state, reason ?? 'Interrupted');
    });
    const active: ActiveRun = {
      abortController,
      stopExternal,
      aborted: false,
    };
    state.currentRun = active;

    const adapter = this;
    const iterator = {
      async *[Symbol.asyncIterator]() {
        let completed = false;
        let threw = false;
        try {
          const thread = await adapter.createThread(state);
          const run = await thread.runStreamed(normalizedInput, {
            outputSchema: opts?.outputSchema,
            signal: abortController.signal,
          });
          const threadId = thread.id ?? undefined;
          if (threadId) {
            state.id = threadId;
            handle.id = threadId;
          }
          for await (const event of run.events) {
            for (const normalized of normalizeCodexEvent(event)) {
              yield normalized;
            }
          }
          completed = true;
        } catch (error) {
          threw = true;
          if (isAbortError(error)) {
            const reason =
              active.abortReason ??
              reasonToString(abortController.signal.reason) ??
              (error instanceof Error ? error.message : undefined) ??
              'Interrupted';
            yield createCancelledEvent(reason);
            yield createInterruptedErrorEvent(reason);
            return;
          }
          throw error;
        } finally {
          if (!completed && !abortController.signal.aborted && !threw) {
            adapter.abortCurrentRun(state, 'Stream closed');
          }
          stopExternal();
          if (state.currentRun === active) {
            state.currentRun = null;
          }
        }
      },
    };

    return iterator;
  }

  getThreadId(thread: ThreadHandle): string | undefined {
    const state = thread.internal as CodexThreadState;
    return state.id;
  }

  private createThreadHandle(state: CodexThreadState): ThreadHandle {
    const handle: ThreadHandle = {
      provider: CODER_NAME,
      internal: state,
      id: state.id,
      run: (input, opts) => this.runInternal(handle, input, opts),
      runStreamed: (input, opts) => this.runStreamedInternal(handle, input, opts),
      interrupt: async reason => {
        this.abortCurrentRun(state, reason ?? 'Interrupted');
      },
    };
    return handle;
  }

  private mergeStartOpts(opts?: StartOpts): StartOpts {
    return { ...this.defaultOpts, ...opts };
  }

  private extractThreadOptions(opts: StartOpts): CodexThreadOptions {
    return {
      model: opts.model,
      sandboxMode: opts.sandboxMode,
      workingDirectory: opts.workingDirectory,
      skipGitRepoCheck: opts.skipGitRepoCheck,
    };
  }

  private async createThread(state: CodexThreadState): Promise<Thread> {
    const { Codex } = await loadCodexModule();
    const codex = new Codex(
      state.codexExecutablePath ? { codexPathOverride: state.codexExecutablePath } : undefined,
    );
    return state.id ? codex.resumeThread(state.id, state.options) : codex.startThread(state.options);
  }

  private mapRunResult(summary: CodexRunSummary, threadId?: string): RunResult {
    const finalResponse = summary.finalResponse ?? '';
    const structured =
      summary.structured === undefined ? extractJsonPayload(finalResponse) : summary.structured;
    return {
      threadId,
      text: finalResponse || undefined,
      json: structured,
      usage: summary.usage,
      raw: summary,
    };
  }

  private assertIdle(state: CodexThreadState): void {
    if (state.currentRun) {
      throw new Error('Codex adapter only supports one in-flight run per thread.');
    }
  }

  private abortCurrentRun(state: CodexThreadState, reason?: string): void {
    const active = state.currentRun;
    if (!active) return;
    if (!active.abortController.signal.aborted) {
      active.abortReason = reason ?? 'Interrupted';
      active.aborted = true;
      active.abortController.abort(active.abortReason);
    }
  }
}

function normalizeInput(input: PromptInput): string {
  if (typeof input === 'string') return input;
  return input.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n');
}

async function collectRunSummary(
  thread: Thread,
  input: string,
  options: RunTurnOptions,
): Promise<CodexRunSummary> {
  const run = await thread.runStreamed(input, options);
  const items: any[] = [];
  let finalResponse = '';
  let usage: any = undefined;
  let structured: unknown = undefined;

  for await (const event of run.events) {
    if (event.type === 'item.completed') {
      const item = event.item;
      items.push(item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        finalResponse = item.text;
      }
      if (structured === undefined) {
        structured = extractStructuredFromItem(item);
      }
    } else if (event.type === 'turn.completed') {
      usage = event.usage;
      if (structured === undefined) {
        structured = extractStructuredFromTurn(event);
      }
    } else if (event.type === 'turn.failed') {
      const message = event.error?.message ?? 'Codex turn failed';
      throw new Error(message);
    }
  }

  if (options.outputSchema && structured === undefined) {
    structured = extractJsonPayload(finalResponse);
  }

  return { items, finalResponse, structured, usage };
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

function extractStructuredFromItem(item: any): unknown {
  if (!item) return undefined;
  return firstStructured([
    item.output_json,
    item.json,
    item.output,
    item.response_json,
    item.structured,
    item.data,
  ]);
}

function extractStructuredFromTurn(event: any): unknown {
  if (!event) return undefined;
  return firstStructured([event.output_json, event.json, event.result, event.output, event.response_json]);
}

function firstStructured(candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
  }
  return undefined;
}

function normalizeCodexEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = CODER_NAME;
  const ev = event ?? {};
  const type = ev?.type;
  const normalized: CoderStreamEvent[] = [];

  if (type === 'thread.started') {
    normalized.push({ type: 'init', provider, threadId: ev.thread_id, ts, originalItem: ev });
    return normalized;
  }

  if (type === 'turn.started') {
    normalized.push({ type: 'progress', provider, label: 'turn.started', ts, originalItem: ev });
    return normalized;
  }

  if (typeof type === 'string' && type.startsWith('permission.')) {
    const decision = type.endsWith('granted') ? 'granted' : type.endsWith('denied') ? 'denied' : undefined;
    normalized.push({
      type: 'permission',
      provider,
      request: ev.permission ?? ev.request,
      decision,
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'item.delta') {
    const item = ev.item ?? {};
    if (item.type === 'agent_message') {
      normalized.push({
        type: 'message',
        provider,
        role: 'assistant',
        text: ev.delta ?? item.text,
        delta: true,
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    normalized.push({
      type: 'progress',
      provider,
      label: `item.delta:${item.type ?? 'event'}`,
      detail: typeof ev.delta === 'string' ? ev.delta : undefined,
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'item.completed') {
    const item = ev.item ?? {};
    if (item.type === 'agent_message') {
      normalized.push({
        type: 'message',
        provider,
        role: 'assistant',
        text: item.text,
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    normalized.push({
      type: 'progress',
      provider,
      label: `item.completed:${item.type ?? 'event'}`,
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'tool_use') {
    normalized.push({
      type: 'tool_use',
      provider,
      name: ev.item?.name ?? 'tool',
      callId: ev.item?.id,
      args: ev.item?.input,
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'tool_result') {
    normalized.push({
      type: 'tool_result',
      provider,
      name: ev.item?.name ?? 'tool',
      callId: ev.item?.id,
      result: ev.item?.output,
      exitCode: ev.item?.exit_code ?? null,
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'turn.completed') {
    normalized.push({
      type: 'usage',
      provider,
      stats: ev.usage,
      ts,
      originalItem: ev,
    });
    normalized.push({ type: 'done', provider, ts, originalItem: ev });
    return normalized;
  }

  if (type === 'turn.failed') {
    normalized.push({
      type: 'error',
      provider,
      code: 'turn.failed',
      message: ev.error?.message ?? 'Codex turn failed',
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  normalized.push({
    type: 'progress',
    provider,
    label: type ?? 'codex.event',
    ts,
    originalItem: ev,
  });
  return normalized;
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as any).code === 'interrupted')
  );
}

function createInterruptedErrorEvent(reason?: string): CoderStreamEvent {
  return {
    type: 'error',
    provider: CODER_NAME,
    code: 'interrupted',
    message: reason ?? 'Operation was interrupted',
    ts: now(),
    originalItem: { reason },
  };
}

function reasonToString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return undefined;
}

function createCancelledEvent(reason: string): CoderStreamEvent {
  return {
    type: 'cancelled',
    provider: CODER_NAME,
    ts: now(),
    originalItem: { reason },
  };
}

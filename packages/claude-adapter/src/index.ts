/**
 * @fileoverview Claude Agent SDK adapter implementing the HeadlessCoder interface.
 */

import {
  query,
  type SDKMessage,
  type Options,
  type Query as ClaudeQuery,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
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

export const CODER_NAME: Provider = 'claude';

export function createAdapter(defaults?: StartOpts): HeadlessCoder {
  return new ClaudeAdapter(defaults);
}
(createAdapter as AdapterFactory).coderName = CODER_NAME;

const isNodeRuntime = typeof process !== 'undefined' && !!process.versions?.node;

export function createHeadlessClaude(defaults?: StartOpts): HeadlessCoder {
  ensureNodeRuntime('create a Claude coder');
  if (!getAdapterFactory(CODER_NAME)) {
    registerAdapter(createAdapter as AdapterFactory);
  }
  return createCoder(CODER_NAME, defaults);
}

interface ClaudeThreadState {
  sessionId: string;
  opts: StartOpts;
  resume: boolean;
  currentRun?: ActiveClaudeRun | null;
}

interface ActiveClaudeRun {
  generator: ClaudeQuery;
  abortController: AbortController;
  stopExternal: () => void;
  aborted: boolean;
  abortReason?: string;
}

function ensureNodeRuntime(action: string): void {
  if (!isNodeRuntime) {
    throw new Error(`@headless-coder-sdk/claude-adapter can only ${action} inside Node.js.`);
  }
}

function shouldUseNativeStructuredOutput(schema?: object): boolean {
  return !!schema;
}

function extractNativeStructuredOutput(result: any): unknown | undefined {
  if (!result) return undefined;
  if (Object.prototype.hasOwnProperty.call(result, 'structured_output')) {
    return (result as any).structured_output;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'structuredOutput')) {
    return (result as any).structuredOutput;
  }
  return undefined;
}

/**
 * Normalises prompt input into Claude's string format.
 *
 * Args:
 *   input: Prompt payload from caller.
 *
 * Returns:
 *   String prompt for Claude agent SDK.
 */
function toPrompt(input: PromptInput): string {
  if (typeof input === 'string') return input;
  return input.map(message => `${message.role}: ${message.content}`).join('\n');
}

/**
 * Adapter bridging Claude Agent SDK into the HeadlessCoder abstraction.
 *
 * Args:
 *   defaultOpts: Options applied to every operation when omitted by the caller.
 */
export class ClaudeAdapter implements HeadlessCoder {
  /**
   * Creates a new Claude adapter instance.
   *
   * Args:
   *   defaultOpts: Options applied to every operation when omitted by the caller.
   */
  constructor(private readonly defaultOpts?: StartOpts) {}

  /**
   * Starts a Claude session represented by a thread handle.
   *
   * Args:
   *   opts: Optional overrides for session creation.
   *
   * Returns:
   *   Thread handle tracking the Claude session.
   */
  async startThread(opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    const id = options.resume ?? randomUUID();
    const state: ClaudeThreadState = {
      sessionId: id,
      opts: options,
      resume: false,
    };
    return this.createThreadHandle(state);
  }

  /**
   * Reuses an existing Claude session identifier.
   *
   * Args:
   *   threadId: Claude session identifier.
   *   opts: Optional overrides for the upcoming runs.
   *
   * Returns:
   *   Thread handle referencing the resumed session.
   */
  async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    const state: ClaudeThreadState = {
      sessionId: threadId,
      opts: options,
      resume: true,
    };
    return this.createThreadHandle(state);
  }

  /**
   * Builds Claude Agent SDK options from a thread handle.
   *
   * Args:
   *   handle: Thread handle provided by start/resume operations.
   *   runOpts: Call-time run options.
   *
   * Returns:
   *   Options ready for the Claude Agent SDK.
   */
  private buildOptions(state: ClaudeThreadState, runOpts?: RunOpts, useNativeStructuredOutput?: boolean): Options {
    const startOpts = state.opts ?? {};
    const resumeId = state.resume ? state.sessionId : undefined;
    const permissionMode: PermissionMode | undefined =
      (startOpts.permissionMode as PermissionMode | undefined) ?? (startOpts.yolo ? 'bypassPermissions' : undefined);
    const outputFormat =
      useNativeStructuredOutput && runOpts?.outputSchema
        ? {
            type: 'json_schema' as const,
            schema: runOpts.outputSchema as Record<string, unknown>,
          }
        : undefined;
    return {
      cwd: startOpts.workingDirectory,
      allowedTools: startOpts.allowedTools,
      mcpServers: startOpts.mcpServers as any,
      continue: !!startOpts.continue,
      resume: resumeId,
      forkSession: startOpts.forkSession,
      includePartialMessages: !!runOpts?.streamPartialMessages,
      model: startOpts.model,
      permissionMode,
      permissionPromptToolName: startOpts.permissionPromptToolName,
      outputFormat,
    };
  }

  /**
   * Runs Claude to completion and returns the final assistant message.
   *
   * Args:
     *   thread: Thread handle.
     *   input: Prompt payload.
     *   runOpts: Run-level options.
   *
   * Returns:
     *   Run result with the final assistant message.
   *
   * Raises:
   *   Error: Propagated when the Claude Agent SDK surfaces a failure event.
  */
 private async runInternal(thread: ThreadHandle, input: PromptInput, runOpts?: RunOpts): Promise<RunResult> {
    ensureNodeRuntime('run Claude');
    const state = thread.internal as ClaudeThreadState;
    this.assertIdle(state);
    const useNativeStructuredOutput = shouldUseNativeStructuredOutput(runOpts?.outputSchema);
    const prompt = toPrompt(input);
    const options = this.buildOptions(state, runOpts, useNativeStructuredOutput);
    const generator = query({ prompt, options });
    const active = this.registerRun(state, generator, runOpts?.signal);
    let lastAssistant = '';
    let finalResult: any;
    try {
      for await (const message of generator as AsyncGenerator<SDKMessage, void, void>) {
        this.captureSessionId(state, thread, message);
        if (active.abortController.signal.aborted) {
          throw createAbortError(active.abortReason);
        }
        const type = (message as any)?.type?.toLowerCase?.();
        if (!type) continue;
        if (type.includes('result')) {
          finalResult = message;
          continue;
        }
        if (type.includes('assistant')) {
          lastAssistant = extractClaudeAssistantText(message);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (finalResult && claudeResultIndicatesError(finalResult)) {
        throw new Error(buildClaudeResultErrorMessage(finalResult), {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw error;
    } finally {
      this.cleanupRun(state, active);
    }
    if (active.abortController.signal.aborted) {
      throw createAbortError(active.abortReason);
    }
    if (finalResult && claudeResultIndicatesError(finalResult)) {
      throw new Error(buildClaudeResultErrorMessage(finalResult));
    }
    const structured = runOpts?.outputSchema ? extractNativeStructuredOutput(finalResult) : undefined;
    return { threadId: state.sessionId, text: lastAssistant, raw: finalResult, json: structured };
  }

  /**
   * Streams Claude responses while mapping them into shared stream events.
   *
   * Args:
     *   thread: Thread handle to execute against.
     *   input: Prompt payload.
     *   runOpts: Run-level modifiers.
   *
   * Returns:
     *   Async iterator yielding normalised stream events.
   *
   * Raises:
   *   Error: Propagated when the Claude Agent SDK terminates with an error.
  */
 private runStreamedInternal(
   thread: ThreadHandle,
   input: PromptInput,
   runOpts?: RunOpts,
 ): EventIterator {
    ensureNodeRuntime('stream Claude events');
    const state = thread.internal as ClaudeThreadState;
    this.assertIdle(state);
    const useNativeStructuredOutput = shouldUseNativeStructuredOutput(runOpts?.outputSchema);
    const prompt = toPrompt(input);
    const options = this.buildOptions(state, runOpts, useNativeStructuredOutput);
    const generator = query({ prompt, options });
    const adapter = this;

    return {
      async *[Symbol.asyncIterator]() {
        const active = adapter.registerRun(state, generator, runOpts?.signal);
        let sawDone = false;
        try {
          for await (const message of generator as AsyncGenerator<SDKMessage, void, void>) {
            adapter.captureSessionId(state, thread, message);
            if (active.abortController.signal.aborted) {
              throw createAbortError(active.abortReason);
            }
            const events = normalizeClaudeStreamMessage(message, state.sessionId);
            for (const event of events) {
              if (event.type === 'error') {
                yield event;
                return;
              }
              if (event.type === 'done') {
                sawDone = true;
              }
              yield event;
            }
          }
          if (!sawDone) {
            yield { type: 'done', provider: CODER_NAME, ts: now(), originalItem: { reason: 'completed' } };
          }
        } catch (error) {
          if (isAbortError(error)) {
            const reason = active.abortReason ?? (error as Error).message ?? 'Interrupted';
            yield {
              type: 'cancelled',
              provider: CODER_NAME,
              ts: now(),
              originalItem: { reason },
            };
            yield {
              type: 'error',
              provider: CODER_NAME,
              code: 'interrupted',
              message: reason,
              ts: now(),
              originalItem: { reason },
            };
            return;
          }
          throw error;
        } finally {
          adapter.cleanupRun(state, active);
        }
      },
    };
  }

  /**
   * Returns the identifier associated with the Claude thread.
   *
   * Args:
   *   thread: Thread handle.
   *
   * Returns:
   *   Thread identifier if present.
   */
  getThreadId(thread: ThreadHandle): string | undefined {
    const state = thread.internal as ClaudeThreadState;
    return state.sessionId;
  }

  private createThreadHandle(state: ClaudeThreadState): ThreadHandle {
    const handle: ThreadHandle = {
      provider: CODER_NAME,
      id: state.sessionId,
      internal: state,
      run: (input, runOpts) => this.runInternal(handle, input, runOpts),
      runStreamed: (input, runOpts) => this.runStreamedInternal(handle, input, runOpts),
      interrupt: async reason => {
        this.abortCurrentRun(state, reason ?? 'Interrupted');
      },
    };
    return handle;
  }

  private registerRun(state: ClaudeThreadState, generator: ClaudeQuery, signal?: AbortSignal): ActiveClaudeRun {
    const abortController = new AbortController();
    const stopExternal = linkSignal(signal, reason => this.abortCurrentRun(state, reason));
    const active: ActiveClaudeRun = {
      generator,
      abortController,
      stopExternal,
      aborted: false,
    };
    state.currentRun = active;
    return active;
  }

  private cleanupRun(state: ClaudeThreadState, active: ActiveClaudeRun): void {
    active.stopExternal();
    if (state.currentRun === active) {
      state.currentRun = null;
    }
  }

  private abortCurrentRun(state: ClaudeThreadState, reason?: string): void {
    const active = state.currentRun;
    if (!active || active.aborted) return;
    active.aborted = true;
    active.abortReason = reason ?? 'Interrupted';
    if (!active.abortController.signal.aborted) {
      active.abortController.abort(active.abortReason);
    }
    if (typeof active.generator.interrupt === 'function') {
      void active.generator.interrupt().catch(() => {});
    }
  }

  private assertIdle(state: ClaudeThreadState): void {
    if (state.currentRun) {
      throw new Error('Claude adapter only supports one in-flight run per thread.');
    }
  }

  private captureSessionId(state: ClaudeThreadState, handle: ThreadHandle, message: SDKMessage): void {
    const sessionId = (message as any)?.session_id;
    if (sessionId && sessionId !== state.sessionId) {
      state.sessionId = sessionId;
      state.resume = true;
      handle.id = sessionId;
    }
  }
}

function normalizeClaudeStreamMessage(message: any, threadId?: string): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = CODER_NAME;
  const events: CoderStreamEvent[] = [];
  const typeValue = message?.type ?? message?.label ?? '';
  const typeText = typeof typeValue === 'string' ? typeValue : String(typeValue ?? '');
  const typeLower = typeText.toLowerCase();
  const includes = (token: string) => typeLower.includes(token);

  if (typeLower === 'sdkinit' || typeLower === 'system' || message?.session_id) {
    return [
      {
        type: 'init',
        provider,
        threadId: message?.session_id ?? threadId,
        model: message?.model,
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('partial')) {
    return [
      {
        type: 'message',
        provider,
        role: 'assistant',
        text: (message as any).text ?? (message as any).content ?? extractClaudeAssistantText(message),
        delta: true,
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('assistant')) {
    return [
      {
        type: 'message',
        provider,
        role: 'assistant',
        text: extractClaudeAssistantText(message),
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('tool_use') || includes('tooluse')) {
    return [
      {
        type: 'tool_use',
        provider,
        name: (message as any).name ?? (message as any).tool_name ?? (message as any).tool,
        callId: (message as any).id,
        args: (message as any).input,
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('tool-result') || includes('toolresult')) {
    return [
      {
        type: 'tool_result',
        provider,
        name: (message as any).name ?? (message as any).tool_name ?? (message as any).tool,
        callId: (message as any).tool_use_id ?? (message as any).id,
        result: (message as any).output,
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('permission')) {
    return [
      {
        type: 'permission',
        provider,
        request: (message as any).request,
        decision: (message as any).decision,
        ts,
        originalItem: message,
      },
    ];
  }

  if (includes('result')) {
    if (claudeResultIndicatesError(message)) {
      return [
        {
          type: 'error',
          provider,
          message: buildClaudeResultErrorMessage(message),
          ts,
          originalItem: message,
        },
      ];
    }
    if (message?.usage) {
      events.push({ type: 'usage', provider, stats: message.usage, ts, originalItem: message });
    }
    events.push({ type: 'done', provider, ts, originalItem: message });
    return events;
  }

  if (includes('completed') || includes('final')) {
    if (message?.usage) {
      events.push({ type: 'usage', provider, stats: message.usage, ts, originalItem: message });
    }
    events.push({ type: 'done', provider, ts, originalItem: message });
    return events;
  }

  return [
    {
      type: 'progress',
      provider,
      label: typeText || 'claude.event',
      ts,
      originalItem: message,
    },
  ];
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
  return error instanceof Error && ((error as any).code === 'interrupted' || error.name === 'AbortError');
}

function reasonToString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return undefined;
}

function extractClaudeAssistantText(message: any): string {
  if (!message) return '';

  const tryExtract = (candidate: any): string => {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate)) {
      return candidate
        .map(item => (typeof item?.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (candidate && typeof candidate === 'object' && typeof candidate.text === 'string') {
      return candidate.text;
    }
    return '';
  };

  const direct = tryExtract(message.text ?? message.content);
  if (direct) return direct;

  const nested = tryExtract(message.message?.text ?? message.message?.content);
  if (nested) return nested;

  const alternative = tryExtract(message.delta ?? message.partial);
  return alternative;
}

function claudeResultIndicatesError(result: any): boolean {
  return Boolean(result?.is_error || String(result?.subtype ?? '').startsWith('error'));
}

function buildClaudeResultErrorMessage(result: any): string {
  const summary =
    result?.result ??
    (Array.isArray(result?.errors) ? result.errors.join(', ') : undefined) ??
    'Claude run failed';
  return `Claude run failed: ${summary}`;
}

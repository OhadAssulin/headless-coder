/**
 * @fileoverview Codex adapter that conforms to the HeadlessCoderSdk interface.
 */

import { Codex, type Thread as CodexThread } from '@openai/codex-sdk';
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

export const CODER_NAME: Provider = 'codex';

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
 * Normalises prompt input into a string accepted by the Codex SDK.
 *
 * Args:
 *   input: Prompt payload from the caller.
 *
 * Returns:
 *   Prompt string for the Codex SDK.
 */
function normalizeInput(input: PromptInput): string {
  if (typeof input === 'string') return input;
  return input.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n');
}

/**
 * Adapter that wraps the Codex SDK with the shared HeadlessCoderSdk interface.
 *
 * Args:
 *   defaultOpts: Options applied to every thread operation unless overridden.
 */
export class CodexAdapter implements HeadlessCoderSdk {
  private client: Codex;

  /**
   * Creates a new Codex adapter instance.
   *
   * Args:
   *   defaultOpts: Options applied to every thread operation unless overridden.
   */
  constructor(private readonly defaultOpts?: StartOpts) {
    const config = this.defaultOpts?.codexExecutablePath
      ? { executablePath: this.defaultOpts.codexExecutablePath }
      : {};
    this.client = new Codex(config as any);
  }

  /**
   * Starts a new Codex thread.
   *
   * Args:
   *   opts: Provider-specific overrides.
   *
   * Returns:
   *   Handle describing the new thread.
   */
  async startThread(opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    const thread: CodexThread = this.client.startThread({
      model: options.model,
      sandboxMode: options.sandboxMode,
      skipGitRepoCheck: options.skipGitRepoCheck,
      workingDirectory: options.workingDirectory,
    });
    return this.createThreadHandle(thread);
  }

  /**
   * Resumes a Codex thread by identifier.
   *
   * Args:
   *   threadId: Codex thread identifier.
   *   opts: Provider-specific overrides.
   *
   * Returns:
   *   Thread handle aligned with the HeadlessCoderSdk contract.
   */
  async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    const thread = this.client.resumeThread(threadId, {
      model: options.model,
      sandboxMode: options.sandboxMode,
      skipGitRepoCheck: options.skipGitRepoCheck,
      workingDirectory: options.workingDirectory,
    });
    return this.createThreadHandle(thread);
  }

  /**
   * Executes a run on an existing Codex thread.
   *
   * Args:
   *   thread: Thread handle created via start/resume.
   *   input: Prompt payload.
   *   opts: Run-level overrides (e.g., structured output schema).
   *
   * Returns:
   *   Run result mapped into the shared shape.
   *
   * Raises:
   *   Error: Propagated when the Codex SDK fails to complete the run.
   */
  private async runInternal(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
    const result = await (thread.internal as CodexThread).run(normalizeInput(input), {
      outputSchema: opts?.outputSchema,
    });
    const threadId = (thread.internal as CodexThread).id ?? undefined;
    const finalResponse = (result as any)?.finalResponse ?? (result as any)?.text ?? result;
    const structured =
      (result as any)?.parsedResponse ??
      (result as any)?.json ??
      (typeof finalResponse === 'string' ? extractJsonPayload(finalResponse) : undefined);
    return {
      threadId,
      text: typeof finalResponse === 'string' ? finalResponse : undefined,
      json: structured,
      raw: result,
    };
  }

  /**
   * Executes a streamed run, yielding progress events.
   *
   * Args:
     *   thread: Thread handle to execute against.
     *   input: Prompt payload.
     *   opts: Run-level overrides (currently unused).
   *
   * Returns:
     *   Async iterator of stream events.
   *
   * Raises:
   *   Error: Propagated when the Codex SDK streaming call fails.
   */
  private async *runStreamedInternal(
    thread: ThreadHandle,
    input: PromptInput,
    opts?: RunOpts,
  ): EventIterator {
    void opts;
    const runStream = await (thread.internal as CodexThread).runStreamed(normalizeInput(input));
    const asyncEvents = (runStream as any)?.events ?? runStream;
    if (!asyncEvents || typeof (asyncEvents as any)[Symbol.asyncIterator] !== 'function') {
      throw new Error('Codex streaming API did not return an async iterator.');
    }

    for await (const event of asyncEvents as AsyncIterable<any>) {
      for (const normalized of normalizeCodexEvent(event)) {
        yield normalized;
      }
    }
  }

  /**
   * Retrieves the thread identifier managed by Codex.
   *
   * Args:
   *   thread: Thread handle.
   *
   * Returns:
   *   Thread identifier when available.
   */
  getThreadId(thread: ThreadHandle): string | undefined {
    const threadId = (thread.internal as CodexThread).id;
    return threadId === null ? undefined : threadId;
  }

  private createThreadHandle(thread: CodexThread): ThreadHandle {
    const handle: ThreadHandle = {
      provider: 'codex',
      internal: thread,
      id: (thread as CodexThread).id ?? undefined,
      run: (input, opts) => this.runInternal(handle, input, opts),
      runStreamed: (input, opts) => this.runStreamedInternal(handle, input, opts),
    };
    return handle;
  }
}

function normalizeCodexEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = 'codex';
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

  if (type === 'item.started' || type === 'item.completed') {
    const item = ev.item ?? {};
    if (item.type === 'agent_message') {
      normalized.push({
        type: 'message',
        provider,
        role: 'assistant',
        text: item.text,
        delta: type === 'item.started',
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    if (item.type === 'reasoning') {
      normalized.push({
        type: 'progress',
        provider,
        label: 'reasoning',
        detail: item.text,
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    if (item.type === 'command_execution') {
      if (type === 'item.started') {
        normalized.push({
          type: 'tool_use',
          provider,
          name: 'command',
          callId: item.id,
          args: { command: item.command },
          ts,
          originalItem: ev,
        });
      } else {
        normalized.push({
          type: 'tool_result',
          provider,
          name: 'command',
          callId: item.id,
          result: item.aggregated_output ?? item.text,
          exitCode: item.exit_code ?? null,
          ts,
          originalItem: ev,
        });
      }
      return normalized;
    }

    if (item.type === 'file_change') {
      normalized.push({
        type: 'file_change',
        provider,
        path: item.path,
        op: item.op,
        patch: item.patch,
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    if (item.type === 'plan_update') {
      normalized.push({
        type: 'plan_update',
        provider,
        text: item.text,
        ts,
        originalItem: ev,
      });
      return normalized;
    }

    normalized.push({
      type: 'progress',
      provider,
      label: item.type ?? 'item',
      detail: item.text ?? '',
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  if (type === 'turn.completed') {
    if (ev.usage) {
      normalized.push({ type: 'usage', provider, stats: ev.usage, ts, originalItem: ev });
    }
    normalized.push({ type: 'done', provider, ts, originalItem: ev });
    return normalized;
  }

  if (type === 'error') {
    normalized.push({
      type: 'error',
      provider,
      message: ev.message ?? 'codex error',
      ts,
      originalItem: ev,
    });
    return normalized;
  }

  normalized.push({
    type: 'progress',
    provider,
    label: typeof type === 'string' ? type : 'codex.event',
    ts,
    originalItem: ev,
  });
  return normalized;
}

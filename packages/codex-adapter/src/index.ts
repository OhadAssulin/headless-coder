/**
 * @fileoverview Codex adapter that conforms to the HeadlessCoder interface.
 */

import { Codex, type Thread as CodexThread } from '@openai/codex-sdk';
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
 * Adapter that wraps the Codex SDK with the shared HeadlessCoder interface.
 *
 * Args:
 *   defaultOpts: Options applied to every thread operation unless overridden.
 */
export class CodexAdapter implements HeadlessCoder {
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
    return { provider: 'codex', internal: thread, id: (thread as any).id ?? undefined };
  }

  /**
   * Resumes a Codex thread by identifier.
   *
   * Args:
   *   threadId: Codex thread identifier.
   *   opts: Provider-specific overrides.
   *
   * Returns:
   *   Thread handle aligned with the HeadlessCoder contract.
   */
  async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
    const options = { ...this.defaultOpts, ...opts };
    const thread = this.client.resumeThread(threadId, {
      model: options.model,
      sandboxMode: options.sandboxMode,
      skipGitRepoCheck: options.skipGitRepoCheck,
      workingDirectory: options.workingDirectory,
    });
    return { provider: 'codex', internal: thread, id: threadId ?? undefined };
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
  async run(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult> {
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
  async *runStreamed(
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
}

function normalizeCodexEvent(event: any): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = 'codex';
  const type = event?.type;
  const normalized: CoderStreamEvent[] = [];

  if (type === 'thread.started') {
    normalized.push({ type: 'init', provider, threadId: event.thread_id, raw: event, ts });
    return normalized;
  }

  if (type === 'turn.started') {
    normalized.push({ type: 'progress', provider, label: 'turn.started', raw: event, ts });
    return normalized;
  }

  if (type === 'item.started' && event.item?.type === 'command_execution') {
    normalized.push({
      type: 'tool_use',
      provider,
      name: 'command',
      callId: event.item.id,
      args: { command: event.item.command },
      raw: event,
      ts,
    });
    return normalized;
  }

  if (type === 'item.completed' && event.item?.type === 'command_execution') {
    normalized.push({
      type: 'tool_result',
      provider,
      name: 'command',
      callId: event.item.id,
      exitCode: event.item.exit_code ?? null,
      result: event.item.aggregated_output ?? event.item.text,
      raw: event,
      ts,
    });
    return normalized;
  }

  if (type === 'item.delta' && event.item?.type === 'agent_message') {
    normalized.push({
      type: 'message',
      provider,
      role: 'assistant',
      text: event.delta ?? event.item?.text,
      delta: true,
      raw: event,
      ts,
    });
    return normalized;
  }

  if (type === 'item.completed' && event.item?.type === 'agent_message') {
    normalized.push({
      type: 'message',
      provider,
      role: 'assistant',
      text: event.item.text,
      raw: event,
      ts,
    });
    return normalized;
  }

  if (typeof type === 'string' && type.startsWith('permission.')) {
    normalized.push({ type: 'permission', provider, raw: event, ts });
    return normalized;
  }

  if (type === 'turn.completed') {
    if (event.usage) {
      normalized.push({ type: 'usage', provider, stats: event.usage, raw: event, ts });
    }
    normalized.push({ type: 'done', provider, raw: event, ts });
    return normalized;
  }

  normalized.push({
    type: 'progress',
    provider,
    label: typeof type === 'string' ? type : 'codex.event',
    raw: event,
    ts,
  });
  return normalized;
}

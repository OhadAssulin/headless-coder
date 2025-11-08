/**
 * @fileoverview Claude Agent SDK adapter implementing the HeadlessCoderSdk interface.
 */

import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
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

export const CODER_NAME: Provider = 'claude';

const STRUCTURED_OUTPUT_SUFFIX =
  'You must respond with valid JSON that satisfies the provided schema. Do not include prose before or after the JSON.';

function applyOutputSchemaPrompt(input: PromptInput, schema?: object): PromptInput {
  if (!schema) return input;
  const schemaSnippet = JSON.stringify(schema, null, 2);
  const systemPrompt = `${STRUCTURED_OUTPUT_SUFFIX}\nSchema:\n${schemaSnippet}`;
  if (typeof input === 'string') {
    return `${input}\n\n${systemPrompt}`;
  }
  return [
    { role: 'system', content: systemPrompt },
    ...input,
  ];
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
 * Adapter bridging Claude Agent SDK into the HeadlessCoderSdk abstraction.
 *
 * Args:
 *   defaultOpts: Options applied to every operation when omitted by the caller.
 */
export class ClaudeAdapter implements HeadlessCoderSdk {
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
    return this.createThreadHandle(id, options, false);
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
    return this.createThreadHandle(threadId, options, true);
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
  private buildOptions(handle: ThreadHandle, runOpts?: RunOpts): Options {
    const internalState = (handle.internal as any) ?? {};
    const startOpts = (internalState.opts ?? {}) as StartOpts;
    const shouldResume = internalState.resume === true || !!startOpts.resume;
    const resumeId = shouldResume ? (internalState.sessionId ?? handle.id) : undefined;
    return {
      cwd: startOpts.workingDirectory,
      allowedTools: startOpts.allowedTools,
      mcpServers: startOpts.mcpServers as any,
      continue: !!startOpts.continue,
      resume: resumeId,
      forkSession: startOpts.forkSession,
      includePartialMessages: !!runOpts?.streamPartialMessages,
      model: startOpts.model,
      permissionMode: startOpts.permissionMode ?? (startOpts.yolo ? 'bypassPermissions' : undefined),
      permissionPromptToolName: startOpts.permissionPromptToolName,
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
    const structuredPrompt = applyOutputSchemaPrompt(toPrompt(input), runOpts?.outputSchema);
    const options = this.buildOptions(thread, runOpts);
    const generator = query({ prompt: structuredPrompt, options });
    let lastAssistant = '';
    let finalResult: any;
    try {
      for await (const message of generator as AsyncGenerator<SDKMessage, void, void>) {
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
      if (finalResult && claudeResultIndicatesError(finalResult)) {
        throw new Error(buildClaudeResultErrorMessage(finalResult), {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw error;
    }
    if (finalResult && claudeResultIndicatesError(finalResult)) {
      throw new Error(buildClaudeResultErrorMessage(finalResult));
    }
    const structured = runOpts?.outputSchema ? extractJsonPayload(lastAssistant) : undefined;
    return { threadId: thread.id, text: lastAssistant, raw: finalResult, json: structured };
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
  private async *runStreamedInternal(
    thread: ThreadHandle,
    input: PromptInput,
    runOpts?: RunOpts,
  ): EventIterator {
    const structuredPrompt = applyOutputSchemaPrompt(toPrompt(input), runOpts?.outputSchema);
    const options = this.buildOptions(thread, runOpts);
    const generator = query({ prompt: structuredPrompt, options });
    let sawDone = false;
    for await (const message of generator as AsyncGenerator<SDKMessage, void, void>) {
      const events = normalizeClaudeStreamMessage(message, thread.id);
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
      yield { type: 'done', provider: 'claude', ts: now(), originalItem: { reason: 'completed' } };
    }
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
    return thread.id;
  }
  private createThreadHandle(sessionId: string, options: StartOpts, resume: boolean): ThreadHandle {
    const handle: ThreadHandle = {
      provider: 'claude',
      id: sessionId,
      internal: { sessionId, opts: options, resume },
      run: (input, runOpts) => this.runInternal(handle, input, runOpts),
      runStreamed: (input, runOpts) => this.runStreamedInternal(handle, input, runOpts),
    };
    return handle;
  }
}

function normalizeClaudeStreamMessage(message: any, threadId?: string): CoderStreamEvent[] {
  const ts = now();
  const provider: Provider = 'claude';
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

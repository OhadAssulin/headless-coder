/**
 * @fileoverview Claude Agent SDK adapter implementing the HeadlessCoder interface.
 */

import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type {
  HeadlessCoder,
  ThreadHandle,
  PromptInput,
  StartOpts,
  RunOpts,
  RunResult,
  StreamEvent,
} from '@headless-coders/core';

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
    return { provider: 'claude', id, internal: { sessionId: id, opts: options, resume: false } };
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
    return {
      provider: 'claude',
      id: threadId,
      internal: { sessionId: threadId, opts: options, resume: true },
    };
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
  async run(thread: ThreadHandle, input: PromptInput, runOpts?: RunOpts): Promise<RunResult> {
    const options = this.buildOptions(thread, runOpts);
    const generator = query({ prompt: toPrompt(input), options });
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
          lastAssistant = this.extractAssistantText(message);
        }
      }
    } catch (error) {
      if (finalResult && this.resultIndicatesError(finalResult)) {
        throw new Error(this.buildResultErrorMessage(finalResult), {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw error;
    }
    if (finalResult && this.resultIndicatesError(finalResult)) {
      throw new Error(this.buildResultErrorMessage(finalResult));
    }
    return { threadId: thread.id, text: lastAssistant, raw: finalResult };
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
  async *runStreamed(
    thread: ThreadHandle,
    input: PromptInput,
    runOpts?: RunOpts,
  ): AsyncIterable<StreamEvent> {
    yield { type: 'init', provider: 'claude', threadId: thread.id };
    const options = this.buildOptions(thread, runOpts);
    const generator = query({ prompt: toPrompt(input), options });
    for await (const message of generator as AsyncGenerator<SDKMessage, void, void>) {
      const type = (message as any)?.type?.toLowerCase?.();
      if (!type) {
        yield { type: 'progress', raw: message };
        continue;
      }
      if (type.includes('result')) {
        if (this.resultIndicatesError(message)) {
          yield {
            type: 'error',
            error: this.buildResultErrorMessage(message),
            raw: message,
          };
          return;
        }
        yield { type: 'progress', raw: message };
        continue;
      }
      if (type.includes('partial')) {
        yield {
          type: 'message',
          role: 'assistant',
          delta: true,
          text: (message as any).text ?? (message as any).content,
          raw: message,
        };
      } else if (type.includes('assistant')) {
        yield {
          type: 'message',
          role: 'assistant',
          text: this.extractAssistantText(message),
          raw: message,
        };
      } else if (type.includes('tool_use') || type.includes('tool-result')) {
        const eventType = type.includes('tool_use') ? 'tool_use' : 'tool_result';
        yield {
          type: eventType as 'tool_use' | 'tool_result',
          name: (message as any).tool_name,
          payload: message,
          raw: message,
        };
      } else {
        yield { type: 'progress', raw: message };
      }
    }
    yield { type: 'done' };
  }

  /**
   * Extracts assistant-visible text from Claude SDK message payloads.
   *
   * Args:
   *   message: SDK message containing possible assistant text.
   *
   * Returns:
   *   Plain text content when available, otherwise an empty string.
   */
  private extractAssistantText(message: any): string {
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

  /**
   * Determines whether a Claude result message represents an error.
   *
   * Args:
   *   result: Result payload emitted by the Claude Agent SDK.
   *
   * Returns:
   *   Boolean flag indicating if the result denotes a failure.
   */
  private resultIndicatesError(result: any): boolean {
    return Boolean(result?.is_error || String(result?.subtype ?? '').startsWith('error'));
  }

  /**
   * Builds a user-friendly error message for a failed Claude result.
   *
   * Args:
   *   result: Result payload emitted by the Claude Agent SDK.
   *
   * Returns:
   *   String error message containing the reported failure reason.
   */
  private buildResultErrorMessage(result: any): string {
    const summary =
      result?.result ??
      (Array.isArray(result?.errors) ? result.errors.join(', ') : undefined) ??
      'Claude run failed';
    return `Claude run failed: ${summary}`;
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
}

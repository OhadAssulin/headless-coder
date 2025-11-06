/**
 * @fileoverview Shared type definitions for Headless Coder adapters.
 */

/**
 * Provider discriminant used for selecting a headless coder implementation.
 */
export type Provider = 'codex' | 'claude' | 'gemini';

/**
 * Input accepted by coders when executing a run.
 */
export type PromptInput =
  | string
  | Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;

/**
 * Options for starting or resuming a thread across providers.
 */
export interface StartOpts {
  model?: string;
  workingDirectory?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  skipGitRepoCheck?: boolean;
  codexExecutablePath?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  geminiBinaryPath?: string;
  includeDirectories?: string[];
  yolo?: boolean;
  permissionMode?: string;
  permissionPromptToolName?: string;
}

/**
 * Run-time modifiers that tweak how execution is performed.
 */
export interface RunOpts {
  outputSchema?: object;
  streamPartialMessages?: boolean;
  extraEnv?: Record<string, string>;
}

/**
 * Handle returned by provider-specific threads.
 */
export interface ThreadHandle {
  provider: Provider;
  internal: unknown;
  id?: string;
}

/**
 * Streaming events emitted by adapters during live runs.
 */
export type StreamEvent =
  | { type: 'init'; provider: Provider; threadId?: string; raw?: any }
  | {
      type: 'message';
      role: 'assistant' | 'user' | 'system';
      text?: string;
      delta?: boolean;
      raw?: any;
    }
  | {
      type: 'tool_use' | 'tool_result';
      name?: string;
      payload?: any;
      raw?: any;
    }
  | { type: 'progress'; message?: string; raw?: any }
  | { type: 'error'; error: Error | string; raw?: any }
  | { type: 'done'; raw?: any };

/**
 * Result returned after a run completes.
 */
export interface RunResult {
  threadId?: string;
  text?: string;
  json?: unknown;
  usage?: any;
  raw?: any;
}

/**
 * Interface implemented by all headless coder adapters.
 */
export interface HeadlessCoder {
  startThread(opts?: StartOpts): Promise<ThreadHandle>;
  resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle>;
  run(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): Promise<RunResult>;
  runStreamed(
    thread: ThreadHandle,
    input: PromptInput,
    opts?: RunOpts,
  ): AsyncIterable<StreamEvent>;
  getThreadId(thread: ThreadHandle): string | undefined;
  close?(thread: ThreadHandle): Promise<void>;
}

/**
 * @fileoverview Shared type definitions for Headless Coder adapters.
 */

/**
 * Canonical identifiers for the supported headless coder providers.
 */
export const CODER_TYPES = {
  CODEX: 'codex',
  CLAUDE_CODE: 'claude',
  GEMINI: 'gemini',
} as const;

/**
 * Provider discriminant used for selecting a headless coder implementation.
 */
export type Provider = (typeof CODER_TYPES)[keyof typeof CODER_TYPES];

/**
 * Alias exposed for developer ergonomics when referring to provider identifiers.
 */
export type CoderType = Provider;

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
export type CoderStreamEvent =
  | { type: 'init'; provider: Provider; threadId?: string; model?: string; raw?: any; ts: number }
  | {
      type: 'message';
      provider: Provider;
      role: 'assistant' | 'user' | 'system';
      text?: string;
      delta?: boolean;
      raw?: any;
      ts: number;
    }
  | {
      type: 'tool_use';
      provider: Provider;
      name: string;
      callId?: string;
      args?: any;
      raw?: any;
      ts: number;
    }
  | {
      type: 'tool_result';
      provider: Provider;
      name: string;
      callId?: string;
      result?: any;
      exitCode?: number | null;
      raw?: any;
      ts: number;
    }
  | {
      type: 'progress';
      provider: Provider;
      label?: string;
      detail?: string;
      raw?: any;
      ts: number;
    }
  | {
      type: 'permission';
      provider: Provider;
      request?: any;
      decision?: 'granted' | 'denied' | 'auto';
      raw?: any;
      ts: number;
    }
  | {
      type: 'usage';
      provider: Provider;
      stats?: { inputTokens?: number; outputTokens?: number; [k: string]: any };
      raw?: any;
      ts: number;
    }
  | {
      type: 'error';
      provider: Provider;
      code?: string;
      message: string;
      raw?: any;
      ts: number;
    }
  | {
      type: 'done';
      provider: Provider;
      raw?: any;
      ts: number;
    };

export type EventIterator = AsyncIterable<CoderStreamEvent>;

export const now = () => Date.now();

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
  runStreamed(thread: ThreadHandle, input: PromptInput, opts?: RunOpts): EventIterator;
  getThreadId(thread: ThreadHandle): string | undefined;
  close?(thread: ThreadHandle): Promise<void>;
}

/**
 * @fileoverview Shared type definitions for headless-coder-sdk adapters.
 */

/**
 * Canonical identifiers for the supported headless-coder-sdk providers.
 */
export const CODER_TYPES = {
  CODEX: 'codex',
  CLAUDE_CODE: 'claude',
  GEMINI: 'gemini',
} as const;

/**
 * Provider discriminant used for selecting a headless-coder-sdk implementation.
 */
export type Provider = 'codex' | 'gemini' | 'claude';

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
 * Handle returned by provider-specific threads, exposing execution helpers.
 */
export interface ThreadHandle {
  provider: Provider;
  internal: unknown;
  id?: string;
  run(input: PromptInput, opts?: RunOpts): Promise<RunResult>;
  runStreamed(input: PromptInput, opts?: RunOpts): EventIterator;
  close?(): Promise<void>;
}

/**
 * Streaming events emitted by adapters during live runs.
 */
export type CoderStreamEvent =
  | { type: 'init'; provider: Provider; threadId?: string; model?: string; ts: number; originalItem?: any }
  | {
      type: 'message';
      provider: Provider;
      role: 'assistant' | 'user' | 'system';
      text?: string;
      delta?: boolean;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'tool_use';
      provider: Provider;
      name: string;
      callId?: string;
      args?: any;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'tool_result';
      provider: Provider;
      name: string;
      callId?: string;
      result?: any;
      exitCode?: number | null;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'progress';
      provider: Provider;
      label?: string;
      detail?: string;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'permission';
      provider: Provider;
      request?: any;
      decision?: 'granted' | 'denied' | 'auto';
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'file_change';
      provider: Provider;
      path?: string;
      op?: 'create' | 'modify' | 'delete' | 'rename';
      patch?: string;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'plan_update';
      provider: Provider;
      text?: string;
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'usage';
      provider: Provider;
      stats?: { inputTokens?: number; outputTokens?: number; [k: string]: any };
      ts: number;
      originalItem?: any;
    }
  | {
      type: 'error';
      provider: Provider;
      code?: string;
      message: string;
      ts: number;
      originalItem?: any;
    }
  | { type: 'done'; provider: Provider; ts: number; originalItem?: any };

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
 * Interface implemented by all headless-coder-sdk adapters.
 */
export interface HeadlessCoderSdk {
  startThread(opts?: StartOpts): Promise<ThreadHandle>;
  resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle>;
  getThreadId(thread: ThreadHandle): string | undefined;
  close?(thread: ThreadHandle): Promise<void>;
}

import type { Provider, StartOpts } from '@headless-coder-sdk/core';

export type ProviderId = Extract<Provider, 'codex' | 'claude' | 'gemini'>;

export interface AcpDefaults {
  workingDirectory: string;
  model: string | null;
  sandboxMode?: StartOpts['sandboxMode'];
}

export interface AcpConfig {
  enabledAgents: ProviderId[];
  defaults: AcpDefaults;
}

export interface SessionRecord {
  provider: ProviderId;
  threadId?: string;
}

import { registerAdapter } from '@headless-coder-sdk/core/factory';
import { createAdapter as createCodex } from '@headless-coder-sdk/codex-adapter';
import { createAdapter as createClaude } from '@headless-coder-sdk/claude-adapter';
import { createAdapter as createGemini } from '@headless-coder-sdk/gemini-adapter';
import type { AcpConfig, ProviderId } from './types';

const factories: Record<ProviderId, typeof createCodex> = {
  codex: createCodex,
  claude: createClaude,
  gemini: createGemini,
};

const registered = new Set<ProviderId>();

export async function ensureAdaptersRegistered(config: AcpConfig): Promise<void> {
  for (const provider of config.enabledAgents) {
    if (registered.has(provider)) continue;
    const factory = factories[provider];
    if (!factory) {
      throw new Error(`No adapter factory found for provider ${provider}`);
    }
    registerAdapter(factory);
    registered.add(provider);
  }
}

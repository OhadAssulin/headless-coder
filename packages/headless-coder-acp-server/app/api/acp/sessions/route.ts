export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createCoder } from '@headless-coder-sdk/core';
import { loadConfig } from '@/acp/config';
import { ensureAdaptersRegistered } from '@/acp/registry';
import { sessions, buildSessionId } from '@/acp/store';
import { verifyRequestAuth } from '@/acp/auth';
import type { ProviderId } from '@/acp/types';

export async function POST(request: NextRequest) {
  const authError = verifyRequestAuth(request);
  if (authError) return authError;

  const cfg = loadConfig();
  await ensureAdaptersRegistered(cfg);

  const body = (await request.json()) as {
    provider?: ProviderId;
    model?: string | null;
    workingDirectory?: string;
  };

  const provider = body.provider ?? cfg.enabledAgents[0];
  if (!cfg.enabledAgents.includes(provider)) {
    return new NextResponse('Provider not enabled', { status: 400 });
  }

  const coder = createCoder(provider, {
    model: body.model ?? cfg.defaults.model ?? undefined,
    workingDirectory: body.workingDirectory ?? cfg.defaults.workingDirectory,
    sandboxMode: cfg.defaults.sandboxMode,
  });

  const thread = await coder.startThread();
  const sessionId = buildSessionId(provider, thread.id);
  sessions.set(sessionId, { provider, threadId: thread.id });

  return NextResponse.json({ sessionId, provider, threadId: thread.id });
}

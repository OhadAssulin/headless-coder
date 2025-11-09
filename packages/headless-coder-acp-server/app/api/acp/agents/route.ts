export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { AcpAgent } from '@i-am-bee/acp-sdk';
import { loadConfig } from '@/acp/config';
import { ensureAdaptersRegistered } from '@/acp/registry';
import { verifyRequestAuth } from '@/acp/auth';

export async function GET(request: NextRequest) {
  const authError = verifyRequestAuth(request);
  if (authError) return authError;

  const cfg = loadConfig();
  await ensureAdaptersRegistered(cfg);

  const agents: AcpAgent[] = cfg.enabledAgents.map(id => ({
    id,
    name: id.toUpperCase(),
    description: `Headless Coder adapter for ${id}`,
    capabilities: {
      streaming: true,
      structuredOutput: true,
      sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    },
  }));

  return NextResponse.json({ agents });
}

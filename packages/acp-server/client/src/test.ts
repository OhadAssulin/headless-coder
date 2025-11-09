import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.ACP_BASE_URL ?? 'http://localhost:8000';
const token = process.env.ACP_TOKEN;
const STREAM_DIR = '/tmp/headless-coder-sdk';

function buildHeaders(): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function listAgents() {
  const res = await fetch(`${BASE_URL}/api/acp/agents`, { headers: buildHeaders() });
  assert(res.ok, `Failed to fetch agents: ${res.status}`);
  const payload = (await res.json()) as { agents: Array<{ id: string }> };
  assert(payload.agents.length > 0, 'No agents returned');
  console.log(`ACP client: discovered ${payload.agents.length} agent(s).`);
  return payload.agents[0].id;
}

async function createSession(provider: string) {
  const res = await fetch(`${BASE_URL}/api/acp/sessions`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ provider }),
  });
  assert(res.ok, `Failed to create session: ${res.status}`);
  const body = (await res.json()) as { sessionId: string };
  assert(body.sessionId, 'Missing sessionId');
  return body.sessionId;
}

async function streamMessage(sessionId: string): Promise<string> {
  await mkdir(STREAM_DIR, { recursive: true });
  const outPath = path.join(STREAM_DIR, `stream-${Date.now()}.ndjson`);
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['summary', 'risks'],
  } as const;

  const response = await fetch(`${BASE_URL}/api/acp/messages?stream=true`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      sessionId,
      content: 'Review the repository and return a JSON summary plus key risks.',
      outputSchema: schema,
    }),
  });
  assert(response.ok && response.body, `Streaming request failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const file = await open(outPath, 'w');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(decoder.decode(value));
    }
  } finally {
    await file.close();
  }

  const info = await stat(outPath);
  assert(info.size > 0, 'Stream file is empty');
  console.log(`ACP client: streamed frames saved to ${outPath}`);
  return outPath;
}

async function main(): Promise<void> {
  const provider = await listAgents();
  const sessionId = await createSession(provider);
  await streamMessage(sessionId);
  console.log('ACP client tests passed');
}

main().catch(err => {
  console.error('ACP client tests failed:', err);
  process.exitCode = 1;
});

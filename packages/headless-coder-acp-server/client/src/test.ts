const BASE_URL = process.env.ACP_BASE_URL ?? 'http://localhost:8000';
const token = process.env.ACP_TOKEN;

function buildHeaders(): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function assert(cond: unknown, message: string): Promise<void> {
  if (!cond) throw new Error(message);
}

async function testAgentsEndpoint(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/acp/agents`, {
    headers: buildHeaders(),
  });
  await assert(res.ok, `Failed to fetch agents: ${res.status}`);
  const data = (await res.json()) as { agents: Array<{ id: string }> };
  await assert(Array.isArray(data.agents) && data.agents.length > 0, 'No agents returned');
  console.log(`ACP client: discovered ${data.agents.length} agent(s).`);
}

async function main(): Promise<void> {
  await testAgentsEndpoint();
  console.log('ACP client tests passed');
}

main().catch(err => {
  console.error('ACP client tests failed:', err);
  process.exitCode = 1;
});

# ACP Next.js Server

This Next.js 15 application exposes the Headless Coder SDK through the [Agent Communication Protocol](https://agentcommunicationprotocol.dev/introduction/welcome) (ACP). It loads adapter availability from `acp.config.json`, registers the requested providers (Codex, Claude, Gemini), and serves ACP-compatible endpoints under `/api/acp/*` with NDJSON streaming support.

## Prerequisites
- Node.js 20+
- The Headless Coder workspace dependencies installed (`pnpm install` or `npm install` at repo root)
- Optional: `ACP_TOKEN` environment variable to require bearer authentication
- Provider-specific credentials (Codex CLI, Claude agent, Gemini CLI) available to the underlying adapters

## Configuration
1. Review `packages/headless-coder-acp-server/acp.config.json` to enable/disable adapters and adjust default model/working directory/sandbox options. The file is validated against `acp.config.schema.json` at runtime.
2. Set `ACP_TOKEN` in `.env.local` (see `.env.local.example`) if you want the API to enforce authentication.

## Running the server
From the monorepo root:
```bash
# Start the ACP server on port 8000
yarn workspace packages/headless-coder-acp-server dev   # or npm/pnpm equivalent
```
The API now serves:
- `GET /api/acp/agents` – returns enabled agents
- `POST /api/acp/sessions` – creates a new session/thread
- `POST /api/acp/messages?stream=true` – streams Headless Coder events as NDJSON frames

## Building the server
```bash
yarn workspace packages/headless-coder-acp-server build
```
Then deploy with `yarn workspace packages/headless-coder-acp-server start` (or npm analog) pointing at the same configuration/credentials.

## Example client
A simple TypeScript client lives in `packages/headless-coder-acp-server/client`. It can be used as a template for your own integrations.

```bash
# Run the ACP server first (see above)
# In a second terminal, execute the client tests
npm run acp:e2e
```
The e2e script launches the server, waits for readiness, then runs `client/src/test.ts` inside this package which:
1. Calls `GET /api/acp/agents`
2. Validates that at least one agent is available

Feel free to expand the client to create sessions, send prompts, and consume streamed NDJSON frames using the same APIs demonstrated in the script.

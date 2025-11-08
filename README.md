# headless-coder-sdk  
> Unified SDK for headless AI coders (Codex, Claude, Gemini)

[![npm version](https://img.shields.io/npm/v/@headless-coder-sdk/core.svg)](https://www.npmjs.com/package/@headless-coder-sdk/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build Status](https://github.com/OhadAssulin/headless-coder-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/OhadAssulin/headless-coder-sdk/actions)

---

**Headless Coder SDK** unifies multiple *headless AI-coder SDKs* - OpenAI Codex, Anthropic Claude Agent, and Google Gemini CLI - under one consistent interface.  
It standardizes threads, streaming, structured outputs, permissions, and sandboxing, allowing you to build AI coding tools or autonomous agents that switch backends with a single line of code.

---

## 🚀 Why use it?
- Avoid vendor lock-in between AI-coder SDKs  
- Unified threads and streaming API  
- Structured output and sandbox enforcement  
- Works in Node, Electron, or CI pipelines  
- Extensible - add your own adapters easily  

---

## 📦 Packages

- `@headless-coder-sdk/core` – Shared types and the `createCoder` factory  
- `@headless-coder-sdk/codex-adapter` – Wraps the OpenAI Codex SDK  
- `@headless-coder-sdk/claude-adapter` – Wraps Anthropic Claude Agent SDK  
- `@headless-coder-sdk/gemini-adapter` – Invokes the Gemini CLI (headless mode)  
- `@headless-coder-sdk/examples` – Example scripts demonstrating runtime wiring  

---

## 🧭 Quickstart

```bash
npm i @headless-coder-sdk/core @headless-coder-sdk/codex-adapter
```

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core';
import { CODER_NAME as CODEX, createAdapter as createCodex } from '@headless-coder-sdk/codex-adapter';

registerAdapter(CODEX, createCodex);

const coder = createCoder(CODEX);
const thread = await coder.startThread();
const result = await thread.run('Write a hello world script');
console.log(result.text);
```

---

## ▶️ Basic Run (Codex)

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as CODEX_CODER, createAdapter as createCodexAdapter } from '@headless-coder-sdk/codex-adapter';

registerAdapter(CODEX_CODER, createCodexAdapter);

const coder = createCoder(CODEX_CODER, { workingDirectory: process.cwd() });
const thread = await coder.startThread();
const result = await thread.run('Generate a test plan for the API gateway.');
console.log(result.text);
```

---

## 🌊 Streaming Example (Claude)

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as CLAUDE_CODER, createAdapter as createClaudeAdapter } from '@headless-coder-sdk/claude-adapter';

registerAdapter(CLAUDE_CODER, createClaudeAdapter);

const claude = createCoder(CLAUDE_CODER, {
  workingDirectory: process.cwd(),
  permissionMode: 'bypassPermissions',
});

const thread = await claude.startThread();
for await (const event of thread.runStreamed('Plan end-to-end tests')) {
  if (event.type === 'message' && event.role === 'assistant') {
    process.stdout.write(event.delta ? event.text ?? '' : `\n${event.text}\n`);
  }
}

const resumed = await claude.resumeThread(thread.id!);
const followUp = await resumed.run('Summarise the agreed test plan.');
console.log(followUp.text);
```

---

## 🧩 Structured Output Example (Gemini)

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as GEMINI_CODER, createAdapter as createGeminiAdapter } from '@headless-coder-sdk/gemini-adapter';

registerAdapter(GEMINI_CODER, createGeminiAdapter);

const gemini = createCoder(GEMINI_CODER, {
  workingDirectory: process.cwd(),
  includeDirectories: [process.cwd()],
});

const thread = await gemini.startThread();
const turn = await thread.run('Summarise the repo in JSON', {
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      components: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'components'],
  },
});

console.log(turn.json);
```

> ⚠️ Gemini CLI resume support is pending upstream ([PR #10719](https://github.com/google-gemini/gemini-cli/pull/10719)).

---

## 🔁 Resume Example (Codex)

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_NAME as CODEX_CODER, createAdapter as createCodexAdapter } from '@headless-coder-sdk/codex-adapter';

registerAdapter(CODEX_CODER, createCodexAdapter);

const codex = createCoder(CODEX_CODER, {
  workingDirectory: process.cwd(),
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
});

const session = await codex.startThread({ model: 'gpt-5-codex' });
await session.run('Draft a CLI plan.');

const resumed = await codex.resumeThread(session.id!);
const followUp = await resumed.run('Continue with implementation details.');
console.log(followUp.text);
```

---

## 🔄 Multi-Provider Workflow

For a full multi-coder workflow (Codex + Claude + Gemini), see [examples/multi-provider.ts](packages/examples/src/multi-provider.ts).

---

## ⚙️ Development

**Install**
```bash
pnpm install
```

**Build**
```bash
pnpm build
```

**Test**
```bash
pnpm test
```

**Run examples**
```bash
pnpm run examples
```

---

## ⏹️ Handling Interrupts

All adapters support cooperative cancellation via `RunOpts.signal` or thread-level interrupts:

```ts
import { AbortController } from 'node-abort-controller';

const coder = createCoder(CODEX_CODER, { workingDirectory: process.cwd() });
const controller = new AbortController();
const thread = await coder.startThread();
const runPromise = thread.run('Generate a summary of CONTRIBUTING.md', { signal: controller.signal });

setTimeout(() => controller.abort('User cancelled'), 2000);
```

When aborted, streams emit a `cancelled` event and async runs throw an `AbortError` (`code: 'interrupted'`).

---

## 🧱 Build Your Own Adapter

Want to support another provider?  
Follow the [Create Your Own Adapter guide](docs/create-your-own-adapter.md) - it covers exports, registry usage, event mapping, and sandbox permissions.

---

## 💬 Feedback & Contributing

Contributions welcome!  
Open an [issue](https://github.com/OhadAssulin/headless-coder-sdk/issues) or submit a PR.

---

© 2025 Ohad Assulin - MIT License

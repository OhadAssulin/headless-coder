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
import { createHeadlessCodex } from '@headless-coder-sdk/codex-adapter';

const coder = createHeadlessCodex({ workingDirectory: process.cwd() });
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
import { createHeadlessClaude } from '@headless-coder-sdk/claude-adapter';

const claude = createHeadlessClaude({
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
import { createHeadlessGemini } from '@headless-coder-sdk/gemini-adapter';

const gemini = createHeadlessGemini({
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

```ts
import { createHeadlessCodex } from '@headless-coder-sdk/codex-adapter';
import { createHeadlessClaude } from '@headless-coder-sdk/claude-adapter';
import { createHeadlessGemini } from '@headless-coder-sdk/gemini-adapter';

const codex = createHeadlessCodex();
const claude = createHeadlessClaude();
const gemini = createHeadlessGemini({ workingDirectory: process.cwd() });

// 1) Claude + Codex perform code review concurrently and emit structured findings.
const reviewSchema = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['file', 'description', 'severity'],
      },
    },
  },
  required: ['issues'],
} as const;

async function runMultiProviderReview(commitHash: string) {
  const [claudeThread, codexThread] = await Promise.all([
    claude.startThread(),
    codex.startThread(),
  ]);

  const reviewPrompt = (name: string) =>
    `Review commit ${commitHash} and provide structured findings as ${name}. Focus on regressions, tests, and security.`;

  const [claudeReview, codexReview] = await Promise.all([
    claudeThread.run(reviewPrompt('Claude'), { outputSchema: reviewSchema }),
    codexThread.run(reviewPrompt('Codex'), { outputSchema: reviewSchema }),
  ]);

  const combinedIssues = [
    ...(claudeReview.json?.issues ?? []),
    ...(codexReview.json?.issues ?? []),
  ];

  // 2) Gemini waits for both reviewers, then fixes each issue sequentially.
  const geminiThread = await gemini.startThread();

  for (const issue of combinedIssues) {
    await geminiThread.run([
      {
        role: 'system',
        content: 'You fix code review issues one at a time. Apply patches directly when possible.',
      },
      {
        role: 'user',
        content: `Commit: ${commitHash}\nFile: ${issue.file}\nSeverity: ${issue.severity}\nIssue: ${issue.description}\nPlease fix this issue and describe the change.`,
      },
    ]);
  }

  await Promise.all([
    claude.close?.(claudeThread),
    codex.close?.(codexThread),
    gemini.close?.(geminiThread),
  ]);
}
```

In this workflow two reviewers (Claude, Codex) analyze the same commit in parallel and emit structured findings. Gemini then waits until both reviews finish and applies fixes issue-by-issue using the shared structured payload.

---

## ⚠️ Codex Adapter Runtime

- The Codex adapter forks worker processes via Node’s `child_process` API and **must run on the server**. It is safe to import in build tooling, but gate runtime usage to environments where `process.versions.node` exists.
- A convenience helper, `createHeadlessCodex`, registers the adapter and returns a coder in one call:

  ```ts
  import { createHeadlessCodex } from '@headless-coder-sdk/codex-adapter';

  if (typeof window !== 'undefined') {
    throw new Error('Codex adapter is server-only');
  }

  const codex = createHeadlessCodex({ workingDirectory: process.cwd() });
  ```

- In frameworks like Next.js, lazy-load the helper inside server components or API routes to avoid bundling it client-side:

  ```ts
  export async function POST() {
    if (typeof window !== 'undefined') {
      throw new Error('Codex must run on the server');
    }
    const { createHeadlessCodex } = await import('@headless-coder-sdk/codex-adapter');
    const coder = createHeadlessCodex({ workingDirectory: process.cwd() });
    const thread = await coder.startThread();
    const result = await thread.run('List recent commits');
    return Response.json({ text: result.text });
  }
  ```

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

## 📦 Distribution Notes

- Every workspace now emits flattened entry points at `dist/*.js` (ESM) and `dist/*.cjs` (CommonJS), with `.d.ts` files sitting beside them for better editor support.
- You can import `createCoder` or helper utilities directly from `@headless-coder-sdk/core` and `@headless-coder-sdk/codex-adapter` without deep `dist/*/src` paths—the `main`/`module` fields now point at those root files.
- Helper factories (`createHeadlessCodex/Claude/Gemini`) register adapters and return coders in one call, making server-only integrations simpler.
- `package.json` is exposed via the exports map (`import '@headless-coder-sdk/core/package.json'`) for tooling that needs to inspect versions at runtime.
- `@headless-coder-sdk/codex-adapter` forks a worker via `fileURLToPath(new URL('./worker.js', import.meta.url))`; keep `dist/worker.js` adjacent when rebundling so that child processes can spawn correctly.

---

## ✅ Smoke Tests

- `npm run smoke` builds every workspace, packs the publishable tarballs, installs them in a throwaway project, and exercises both CommonJS and ESM entry points.
- Set `HEADLESS_CODER_KEEP_SMOKE_TMP=1 npm run smoke` if you want to inspect the generated smoke project instead of deleting it.

---

© 2025 Ohad Assulin - MIT License

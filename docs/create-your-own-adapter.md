## 🧩 Create Your Own Adapter

You can add support for any headless AI-coder by writing a tiny adapter package that implements the Headless Coder SDK interfaces and exports its own adapter name constant.

---

### 1️⃣ Prerequisites

- Node 18+ and TypeScript.
- Install the SDK types as a dev dependency:
  ```bash
  npm i -D @headless-coder-sdk/core
  ```
- (Optional) Install your provider’s SDK / CLI.

---

### 2️⃣ Minimal Package Structure

```
my-cool-coder-adapter/
├─ package.json
├─ tsconfig.json
└─ src/
   └─ index.ts
```

**package.json**
```json
{
  "name": "@acme/my-cool-coder-adapter",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "peerDependencies": { "@headless-coder-sdk/core": "^0.1.0" }
}
```

---

### 3️⃣ Implement the Adapter

Your adapter must export:
- `CODER_NAME`: a unique constant (string literal)  
- `createAdapter(defaults?)`: a factory returning the unified `HeadlessCoder` implementation, **and** assign `createAdapter.coderName = CODER_NAME` so the registry can auto-detect your adapter.

```ts
// src/index.ts
import type {
  AdapterFactory,
  HeadlessCoder,
  ThreadHandle,
  PromptInput,
  RunOpts,
  RunResult,
  CoderStreamEvent,
} from '@headless-coder-sdk/core';

export const CODER_NAME = 'my-cool-coder' as const;

type StartOpts = {
  model?: string;
  workingDirectory?: string;
};

function normalizeInput(input: PromptInput): string {
  return typeof input === 'string'
    ? input
    : input.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
}

function createAbortError(reason?: unknown): Error {
  const message =
    typeof reason === 'string'
      ? reason
      : reason instanceof Error && reason.message
        ? reason.message
        : 'Operation interrupted';
  const error = new Error(message);
  error.name = 'AbortError';
  (error as any).code = 'interrupted';
  return error;
}

export function createAdapter(defaults?: StartOpts): HeadlessCoder {
  return {
    async startThread(opts?: StartOpts): Promise<ThreadHandle> {
      const config = { ...defaults, ...opts };
      const internal = { sessionId: undefined as string | undefined, config };
      return { provider: CODER_NAME, internal, id: internal.sessionId };
    },

    async resumeThread(threadId: string, opts?: StartOpts): Promise<ThreadHandle> {
      const config = { ...defaults, ...opts };
      const internal = { sessionId: threadId, config };
      return { provider: CODER_NAME, internal, id: threadId };
    },

    async run(thread: ThreadHandle, input: PromptInput, runOpts?: RunOpts): Promise<RunResult> {
      const prompt = normalizeInput(input);
      if (runOpts?.signal?.aborted) {
        throw createAbortError(runOpts.signal.reason);
      }
      const abortHandler = () => {
        throw createAbortError(runOpts?.signal?.reason);
      };
      runOpts?.signal?.addEventListener('abort', abortHandler, { once: true });
      const text = `(demo) my-cool-coder response to: ${prompt}`;
      runOpts?.signal?.removeEventListener('abort', abortHandler);
      return { threadId: thread.id, text, raw: { demo: true } };
    },

    async *runStreamed(
      thread: ThreadHandle,
      input: PromptInput,
      runOpts?: RunOpts,
    ): AsyncIterable<CoderStreamEvent> {
      const ts = Date.now();
      yield { type: 'init', provider: CODER_NAME, threadId: thread.id, ts, originalItem: { demo: true } };
      yield {
        type: 'message',
        provider: CODER_NAME,
        role: 'assistant',
        text: `(demo stream) responding to ${normalizeInput(input)}`,
        ts,
        originalItem: null,
      };
      yield { type: 'done', provider: CODER_NAME, ts, originalItem: null };
    },

    getThreadId(thread: ThreadHandle) {
      return thread.id;
    },
    interrupt: async reason => {
      /* abort in-flight requests here */
      void reason;
    },
  };
}
(createAdapter as AdapterFactory).coderName = CODER_NAME;
```

> 💡 Always include the provider’s raw event in `originalItem` for debugging and auditing.

---

### 4️⃣ Map Provider Events → Unified Stream

Implement these normalized event types:

| Event | Description |
|--------|--------------|
| `init` | Thread/session started |
| `message` | Assistant/user/system text (`delta: true` for partials) |
| `tool_use` / `tool_result` | Tools / commands invoked |
| `progress` | Intermediate reasoning or planning |
| `permission` | Approval requests (fs/exec/net/tool) |
| `file_change` | File edits |
| `plan_update` | High-level plan text |
| `usage` | Token / tool stats |
| `error` | Recoverable error |
| `done` | Turn completed |

At minimum, implement `init`, `message`, and `done`.

---

### 5️⃣ Sandbox & Permissions (optional but recommended)

Adapters can emit `permission` events whenever a tool is about to run (filesystem, exec, etc.).
Honor the caller’s `StartOpts` (e.g., `sandboxMode`, allow/deny lists) and only proceed after emitting a `permission` event with the decision.

---

### 6️⃣ Support Cancellation & Interrupts

- Create an `AbortController` for every run/runStreamed invocation.
- Link `RunOpts.signal` to your controller and stop work immediately when it fires.
- Expose `thread.interrupt(reason?)` by storing the controller (or equivalent) on your thread state and aborting the in-flight run when called.
- Emit a `cancelled` stream event (or an `error` with `code: 'interrupted'`) before ending iteration.
- Reject `run()` with an `AbortError` (set `error.name = 'AbortError'` and `code = 'interrupted'`).

### 7️⃣ Register & Use Your Adapter

```ts
import { registerAdapter, createCoder } from '@headless-coder-sdk/core';
import { CODER_NAME as COOL, createAdapter as createCool } from '@acme/my-cool-coder-adapter';

registerAdapter(createCool);

const coder = createCoder(COOL, { model: 'my-cool-model' });
const thread = await coder.startThread();
for await (const ev of thread.runStreamed('Hello')) {
  console.log(ev.type, ev.text);
}
```

---

### 8️⃣ Test Locally

- Unit tests: verify provider events → `CoderStreamEvent` mapping.
- Integration tests: run a short prompt and expect the sequence `init → message → done`.

---

### 9️⃣ Publish

```bash
npm run build
npm publish --access public
```

In your README:
- Document provider credentials / binaries.
- List supported sandbox levels and enforced permissions.
- Document any provider-specific `StartOpts`.

---

✅ **That’s it!**
Creating a new adapter is as simple as exporting a `CODER_NAME` constant and a `createAdapter()` function that implements the unified Headless Coder SDK interface.

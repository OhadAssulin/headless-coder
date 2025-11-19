# @headless-coder-sdk/codex-adapter

Adapter that bridges the OpenAI Codex CLI/SDK into the Headless Coder SDK interface.

## Installation

```bash
npm install @headless-coder-sdk/core @headless-coder-sdk/codex-adapter
```

## Usage

```ts
import { createHeadlessCodex } from '@headless-coder-sdk/codex-adapter';

if (typeof window !== 'undefined') {
  throw new Error('Codex adapter is server-only');
}

const coder = createHeadlessCodex({ workingDirectory: process.cwd() });
const thread = await coder.startThread();
const turn = await thread.run('Write unit tests for the git helper.');
console.log(turn.text);
```

`createHeadlessCodex` registers the adapter (if necessary) and returns a coder in one call so you no longer have to wire up `registerAdapter` manually.

## Next.js / server frameworks

The adapter interacts with the Codex CLI via Node APIs, so keep it on the server:

```ts
export async function POST() {
  if (typeof window !== 'undefined') {
    throw new Error('Codex adapter must run on the server');
  }
  const { createHeadlessCodex } = await import('@headless-coder-sdk/codex-adapter');
  const coder = createHeadlessCodex({ workingDirectory: process.cwd() });
  const thread = await coder.startThread();
  const result = await thread.run('List open pull requests');
  return Response.json({ text: result.text });
}
```

The adapter is server-only because it shells out to the Codex executable and depends on the Node.js runtime.

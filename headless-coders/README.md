# Headless Coders Monorepo

This workspace hosts the shared headless coder abstraction together with provider-specific adapters.

## Packages

- `@headless-coders/core` – Shared types and the `createCoder` factory.
- `@headless-coders/codex-adapter` – Adapter wrapping `@openai/codex-sdk`.
- `@headless-coders/claude-adapter` – Adapter wrapping `@anthropic-ai/claude-agent-sdk`.
- `@headless-coders/gemini-adapter` – Adapter invoking the Gemini CLI in headless mode.
- `@headless-coders/examples` – Sample usage scripts demonstrating runtime wiring.

## Basic Usage

```ts
import { createCoder } from '@headless-coders/core/factory';

const coder = createCoder('codex', { workingDirectory: process.cwd() });
const thread = await coder.startThread();
const result = await coder.run(thread, 'Generate a test plan for the API gateway.');
console.log(result.text);
```

## Development

- Install dependencies with your preferred package manager:
  - `npm install`
  - or `pnpm install`
- Run workspace builds: `npm run build` or `pnpm run build`
- Execute tests across packages: `npm run test` or `pnpm run test`


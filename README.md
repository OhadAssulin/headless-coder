# Headless Coders

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
import { CODER_TYPES } from '@headless-coders/core';

const coder = createCoder(CODER_TYPES.CODEX, { workingDirectory: process.cwd() });
const thread = await coder.startThread();
const result = await coder.run(thread, 'Generate a test plan for the API gateway.');
console.log(result.text);
```

## Streaming Example (Claude)

```ts
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const claude = createCoder(CODER_TYPES.CLAUDE_CODE, {
  workingDirectory: process.cwd(),
  permissionMode: 'bypassPermissions',
});
const thread = await claude.startThread();
for await (const event of claude.runStreamed(thread, 'Plan end-to-end tests')) {
  if (event.type === 'message' && event.role === 'assistant') {
    process.stdout.write(event.delta ? event.text ?? '' : `\n${event.text}\n`);
  }
}

// Later you can resume the same Claude session and continue a conversation.
const resumed = await claude.resumeThread(thread.id!);
const followUp = await claude.run(resumed, 'Summarise the agreed test plan.');
console.log(followUp.text);
```

## Structured Output Example (Gemini)

```ts
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const gemini = createCoder(CODER_TYPES.GEMINI, {
  workingDirectory: process.cwd(),
  includeDirectories: [process.cwd()],
});

const turn = await gemini.run(
  await gemini.startThread(),
  'Summarise the repo in JSON',
  {
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        components: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['summary', 'components'],
    },
  },
);

console.log(turn.json); // Parsed object based on the schema above

// Gemini CLI resume support is pending (https://github.com/google-gemini/gemini-cli/pull/10719).
// Once merged upstream, a resume example will be added here.

## Resume Example (Codex)

```ts
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const codex = createCoder(CODER_TYPES.CODEX, {
  workingDirectory: process.cwd(),
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
});

const session = await codex.startThread({ model: 'gpt-5-codex' });
await codex.run(session, 'Draft a CLI plan.');

// pause... later
const resumedSession = await codex.resumeThread(session.id!);
const followUp = await codex.run(resumedSession, 'Continue with implementation details.');
console.log(followUp.text);
```

## Multi-Provider Workflow Example

```ts
import { createCoder } from '@headless-coders/core/factory';
import { CODER_TYPES } from '@headless-coders/core';

const codex = createCoder(CODER_TYPES.CODEX, {
  workingDirectory: process.cwd(),
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
});
const claude = createCoder(CODER_TYPES.CLAUDE_CODE, {
  workingDirectory: process.cwd(),
  permissionMode: 'bypassPermissions',
  allowedTools: ['Write', 'Read', 'Edit', 'NotebookEdit'],
});
const gemini = createCoder(CODER_TYPES.GEMINI, {
  workingDirectory: process.cwd(),
  includeDirectories: [process.cwd()],
});

const buildThread = await codex.startThread();
const buildResult = await codex.run(
  buildThread,
  'Implement a CLI tool that prints release notes from CHANGELOG.md.',
);
console.log(buildResult.text);

// Ask Claude to run tests with structured output
const testThread = await claude.startThread();
const testResult = await claude.run(
  testThread,
  'Run npm test and return structured results.',
  {
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        failingTests: { type: 'array', items: { type: 'string' } },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
);

if (testResult.json && (testResult.json as any).status !== 'passed') {
  await codex.run(buildThread, `Tests failed: ${(testResult.json as any).failingTests?.join(', ')}. Please fix.`);
}

// In parallel ask Gemini to review code with structured output
const reviewThread = await gemini.startThread();
const reviewResult = await gemini.run(
  reviewThread,
  'Code review the latest changes. Output issues as JSON.',
  {
    outputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              concern: { type: 'string' },
            },
            required: ['file', 'concern'],
            additionalProperties: false,
          },
        },
      },
      required: ['issues'],
      additionalProperties: false,
    },
  },
);

const reviewIssues = (reviewResult.json as any)?.issues ?? [];
if (Array.isArray(reviewIssues) && reviewIssues.length > 0) {
  await codex.run(
    buildThread,
    `Gemini review found issues: ${JSON.stringify(reviewIssues, null, 2)}. Address them and respond with fixes.`,
  );
}
```
```

## Development

- Install dependencies with your preferred package manager:
  - `npm install`
  - or `pnpm install`
- Run workspace builds: `npm run build` or `pnpm run build`
- Execute tests across packages: `npm run test` or `pnpm run test`
- Execute the end-to-end examples suite: `npm run test -- --workspace @headless-coder/examples-tests`

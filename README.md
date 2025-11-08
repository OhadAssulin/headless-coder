# headless-coder-sdk

Headless Coder SDK is an open-source framework that unifies multiple headless AI-coder SDKs — including the OpenAI Codex SDK, Anthropic Claude Agent SDK, and Google Gemini CLI (headless) — into one consistent developer interface. It standardizes how these SDKs handle threads, streaming, structured outputs, permissions, and sandboxing, allowing developers to work with any AI-coder backend through a single, cohesive API. In short, it’s a unified layer that bridges the fragmented world of headless AI-coding environments.

## Packages

- `@headless-coder-sdk/core` – Shared types and the `createCoder` factory.
- `@headless-coder-sdk/codex-adapter` – Adapter wrapping `@openai/codex-sdk`.
- `@headless-coder-sdk/claude-adapter` – Adapter wrapping `@anthropic-ai/claude-agent-sdk`.
- `@headless-coder-sdk/gemini-adapter` – Adapter invoking the Gemini CLI in headless mode.
- `@headless-coder-sdk/examples` – Sample usage scripts demonstrating runtime wiring.

## Adapter Event Mappings

- [Codex stream mapping](packages/codex-adapter/MAPPING.md)
- [Claude stream mapping](packages/claude-adapter/MAPPING.md)
- [Gemini stream mapping](packages/gemini-adapter/MAPPING.md)

## Basic Usage

```ts
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

const coder = createCoder(CODER_TYPES.CODEX, { workingDirectory: process.cwd() });
const thread = await coder.startThread();
const result = await thread.run('Generate a test plan for the API gateway.');
console.log(result.text);
```

## Streaming Example (Claude)

```ts
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

const claude = createCoder(CODER_TYPES.CLAUDE_CODE, {
  workingDirectory: process.cwd(),
  permissionMode: 'bypassPermissions',
});
const thread = await claude.startThread();
for await (const event of thread.runStreamed('Plan end-to-end tests')) {
  if (event.type === 'message' && event.role === 'assistant') {
    process.stdout.write(event.delta ? event.text ?? '' : `\n${event.text}\n`);
  }
}

// Later you can resume the same Claude session and continue a conversation.
const resumed = await claude.resumeThread(thread.id!);
const followUp = await resumed.run('Summarise the agreed test plan.');
console.log(followUp.text);
```

## Structured Output Example (Gemini)

```ts
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

const gemini = createCoder(CODER_TYPES.GEMINI, {
  workingDirectory: process.cwd(),
  includeDirectories: [process.cwd()],
});

const geminiThread = await gemini.startThread();
const turn = await geminiThread.run(
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
// Until then, each Gemini run effectively starts a fresh context even if you reuse a thread handle.

## Resume Example (Codex)

```ts
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

const codex = createCoder(CODER_TYPES.CODEX, {
  workingDirectory: process.cwd(),
  sandboxMode: 'workspace-write',
  skipGitRepoCheck: true,
});

const session = await codex.startThread({ model: 'gpt-5-codex' });
await session.run('Draft a CLI plan.');

// pause... later
const resumedSession = await codex.resumeThread(session.id!);
const followUp = await resumedSession.run('Continue with implementation details.');
console.log(followUp.text);
```

## Multi-Provider Workflow Example

```ts
import { createCoder } from '@headless-coder-sdk/core/factory';
import { CODER_TYPES } from '@headless-coder-sdk/core';

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
const buildResult = await buildThread.run(
  'Implement a CLI tool that prints release notes from CHANGELOG.md.',
);
console.log(buildResult.text);

// Ask Claude to run tests with structured output
const testThread = await claude.startThread();
const testResult = await testThread.run(
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
  await buildThread.run(`Tests failed: ${(testResult.json as any).failingTests?.join(', ')}. Please fix.`);
}

// In parallel ask Gemini to review code with structured output
const reviewThread = await gemini.startThread();
const reviewResult = await reviewThread.run(
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
  await buildThread.run(
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
- Execute the end-to-end examples suite: `npm run test -- --workspace @headless-coder-sdk/examples-tests`

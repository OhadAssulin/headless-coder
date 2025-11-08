# Claude Adapter → `CoderStreamEvent` Mapping

`packages/claude-adapter/src/index.ts` consumes messages from `@anthropic-ai/claude-agent-sdk` and normalises them via `normalizeClaudeStreamMessage`. The mapping below lists every branch the adapter emits. All events include:

- `provider: 'claude'`
- `ts`: timestamp captured during normalization
- `originalItem`: the untouched `SDKMessage`

| Claude SDK message | Detection logic | Emitted `CoderStreamEvent` | Notes |
| --- | --- | --- | --- |
| `SDKInit` / `System` / any payload containing `session_id` | `message.type` equals/contains those tokens, or `message.session_id` is present | `init` with `threadId = message.session_id ?? (thread id passed in)`, `model = message.model` | Fired for the first message in a session and whenever Claude replays session metadata. |
| Partial assistant tokens | `type` contains `'partial'` | `message` with `role: 'assistant'`, `delta: true`, `text` pulled from `message.text`, `message.content`, or extracted fallback | Mirrors Claude’s streaming deltas. |
| Assistant completions | `type` contains `'assistant'` (non‑partial) | `message` with `role: 'assistant'`, `text = extractClaudeAssistantText(message)` | Covers final assistant turns. |
| Tool invocation | `type` contains `'tool_use'` / `'tooluse'` | `tool_use` with `name = message.name ?? message.tool_name ?? message.tool`, `callId = message.id`, `args = message.input` | Supports both modern and legacy field names. |
| Tool response | `type` contains `'tool-result'` / `'toolresult'` | `tool_result` with `name` like above, `callId = message.tool_use_id ?? message.id`, `result = message.output` | When Claude proxies shell commands, `output` contains stdout/stderr aggregates. |
| Permission prompts/results | `type` contains `'permission'` | `permission` with `request = message.request`, `decision = message.decision` | Allows UIs to surface Claude interactive approvals. |
| Completion with usage metadata | `type` contains `'result'` | If `claudeResultIndicatesError(message)` is true, emit `error` with `message = buildClaudeResultErrorMessage(message)`. Otherwise emit `usage` (when `message.usage` exists) followed by `done`. | Claude sometimes emits multiple `result` blocks; consumers should treat `done` as terminal. |
| Completion markers without explicit `result` | `type` contains `'completed'` or `'final'` | `usage` (when present) and `done` | Handles SDKs that emit `Completed`/`FinalMessage` instead of `Result`. |
| Any other message | Default branch | `progress` with `label = message.type ?? 'claude.event'` | Preserves forward compatibility with future message kinds. |

Additional behavior:

- `Claude` thread handles ensure a trailing `done` event (with `originalItem: { reason: 'completed' }`) if the SDK stream terminates without emitting one of the completion branches.
- Because every event carries `originalItem`, downstream tooling can still access the raw SDK fields (e.g., `usage.input_tokens`) without re-fetching the stream.

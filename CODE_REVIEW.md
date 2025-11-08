# Code Review – `feature/interrupt-support` vs `main`

## Findings

1. **Gemini stream close handler swallows CLI exit failures (packages/gemini-adapter/src/index.ts:250-285)**  
   The new `handleClose` marks the stream as `finished` and enqueues `DONE` as soon as `readline` closes. Because the `child.once('exit', …)` handler bails out when `finished` is set, any subsequent non-zero exit status (or signal) is never surfaced to the iterator. As a result, Gemini CLI crashes now look like successful completions: consumers get `DONE` with no `error`, and the underlying process may continue running until the cleanup logic eventually sends SIGTERM. Please defer setting `finished` until the `exit` event runs (or forward the exit status through the close handler) so that we still emit the `Error` event when the CLI fails.

2. **Codex adapter mislabels worker crashes as user cancellations (packages/codex-adapter/src/index.ts:373-399)**  
   The worker exit handler now emits `createCancelledEvent(...)` for every unexpected exit path (signal, exit code 0 without `streamDone`, and non-zero exit codes) before pushing the error event. This means front-ends will always see a `cancelled` event even when the worker crashed or timed out, making it impossible to distinguish real user-initiated interrupts from infrastructure failures. Only emit the `cancelled` event when `active.aborted` is true; for other exit paths, emit the error event (and possibly `done`) without asserting `cancelled`.


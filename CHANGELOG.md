# Changelog

## [0.22.0] - 2025-11-20
### 🛠 Codex SDK Update
- Bumped `@openai/codex-sdk` to `0.60.1` so the Codex adapter stays current with the latest CLI fixes and streaming improvements.

## [0.21.0] - 2025-11-20
### ⚡ Codex Adapter Direct Execution
- `@headless-coder-sdk/codex-adapter` now targets `@openai/codex-sdk@0.59.0` and calls the SDK directly instead of spawning worker processes. Cancellation flows through the SDK’s native `AbortSignal` support, so both `RunOpts.signal` and `thread.interrupt()` stop Codex turns immediately with no worker fallback.
- Removed the worker entry/export, simplified the tsup build, and refreshed smoke tests to reflect the single-entry bundle layout.

### 📚 Documentation
- Root and core READMEs now describe the server-only Codex requirement without mentioning worker placement, since bundlers no longer need to keep extra assets adjacent to the entry point.
- Core README is synced with the repository README for every release.

## [0.20.0] - 2025-11-19
### ♻️ Gemini Resume Support
- `@headless-coder-sdk/gemini-adapter` now captures CLI session ids/indexes and forwards `--resume` for every subsequent run, so both repeated thread runs and explicit `resumeThread()` flows continue the same workspace.
- Added `examples/src/gemini-resume.test.ts` to cover back-to-back runs and the resumeThread path, skipping automatically when the Gemini CLI is unavailable.

### 📚 Documentation & Versioning
- README now documents that Gemini sessions are resumable, and the updated content is mirrored to the core package README.
- Bumped every package to `0.20.0` to release the Gemini resume support and documentation updates.

## [0.19.0] - 2025-11-19
### ✨ Claude Native Structured Outputs
- `@headless-coder-sdk/claude-adapter` now relies entirely on Claude Agent SDK's native `structured_output`, removing the legacy prompt-based JSON parsing fallback so schemas are enforced by Claude itself.
- Claude structured output example asserts that `structured_output` is returned, ensuring future regressions are caught by CI.

### 📦 Versioning
- Bumped every package to `0.19.0` to publish the native structured output change and keep dependencies aligned.

## [0.18.0] - 2025-11-14
### 🚀 Codex & Model Updates
- Codex adapter is now built against `@openai/codex-sdk@0.58.0`, unlocking GPT-5.1 Codex and GPT-5.1 Modals support out of the box.

### 📦 Packaging
- Bumped `@headless-coder-sdk/core`, Codex, Claude, and Gemini adapters to `0.18.0`, updating every adapter peer dependency to `@headless-coder-sdk/core@^0.18.0`.
- Root README no longer includes the CI badge and is copied directly into the core package so npm consumers see the refreshed docs.

## [0.17.0] - 2025-11-10
### 🧱 Dependency Cleanup
- Removed the temporary dependency from `@headless-coder-sdk/core` → Gemini adapter to keep the core package lightweight again.
- All adapters now declare a peer dependency on `@headless-coder-sdk/core@^0.17.0` so consumers upgrade in lockstep.

### 📦 Publishing
- Bumped `@headless-coder-sdk/core` and `@headless-coder-sdk/gemini-adapter` to `0.17.0` for npm release, keeping changelog/README references in sync.

## [0.16.0] - 2025-11-10
### ✨ Gemini Tool Mapping
- Gemini adapter now emits richer `tool_use`/`tool_result` frames (name/callId/args/output/exitCode/error) so downstream ACP clients and SDK consumers can rely on structured metadata without inspecting `originalItem`.

### 📚 Documentation
- Updated the repo and core README multi-provider sections to use the canonical `registerAdapter` + `createCoder` flow, keeping the examples accurate for all environments.

### 📦 Packaging
- Bumped `@headless-coder-sdk/core` and `@headless-coder-sdk/gemini-adapter` to `0.16.0`; the core package now lists the Gemini adapter as a direct dependency, ensuring the richer tool events are always available.

## [0.15.0] - 2025-11-10
### 🗂 Documentation & Helpers
- Core package now ships the monorepo README directly (`packages/core/README.md`) so npm consumers see the same getting-started guides without visiting GitHub.
- Helper APIs (`createHeadlessCodex/Claude/Gemini`) are now the recommended path throughout the docs and multi-provider examples, keeping server-only usage explicit.

### 🧪 Tooling
- Smoke tests assert the presence of the helper factories across all adapters to prevent regressions.

## [0.14.1] - 2025-11-10
### ✨ Helper APIs
- Added `createHeadlessClaude()` and `createHeadlessGemini()` convenience helpers, mirroring the Codex helper so consumers can get a coder without calling `registerAdapter` manually.
- Both adapters now guard their runtime entry points to ensure they only execute on the server (Node) and emit clearer errors when imported in browser builds.
- Documentation and smoke tests now demonstrate the helper-based workflows, keeping framework examples (Next.js, etc.) concise.

## [0.14.0] - 2025-11-10
### 🚀 Enhancements
- Added `createHeadlessCodex()` helper that auto-registers the adapter and returns a coder, reducing the boilerplate needed in most server runtimes.
- Codex adapter now enforces a Node-only runtime, guards worker spawns, and exposes the worker path via `new URL('./worker.js', import.meta.url)` so bundlers have a deterministic asset to copy.
- README docs call out the server-only requirement and provide lazy-loading snippets for frameworks like Next.js.

### 🛠 DX
- Added runtime guards/warnings that keep browser bundlers from crashing by tree-shaking the `child_process` fork when it’s unreachable.

## [0.13.1] - 2025-11-10
### ✨ Packaging & DX
- Core and every adapter now emit real entry points via `tsup`, producing both ESM (`dist/*.js`) and CommonJS (`dist/*.cjs`) bundles with colocated typings, so downstream apps can import the declared exports without diving into `dist/*/src` internals.
- Updated exports maps to expose `factory`, `types`, adapter workers, and `package.json`, unlocking better metadata discovery and `require()` support.
- Codex adapter gained a README that documents the worker co-location requirement, plus LICENSE files were added to every publishable package for npm completeness.
- Bumped `@openai/codex-sdk` to `0.57.0` and refreshed peer dependency ranges to `^0.14.0` across the adapters.

### 🧪 Tooling
- Added `npm run smoke`, which builds, packs, and installs the tarballs into a throwaway project to verify both CommonJS and ESM consumers and assert that the Codex worker ships beside the entry point.
- README now documents the new distribution layout and smoke test workflow so consumers understand the worker requirement and validation steps.

## [0.11.0] - 2025-11-09
### ✨ Highlights
- Worker-based Codex adapter now propagates structured output schemas, captures stderr on failures, and exposes deterministic cancellation/error events for `run` and `runStreamed`.
- Claude adapter gains proper cooperative cancellation, session tracking, and stream interrupt events, plus a new integration test that verifies cancellation metadata.
- Gemini adapter now mirrors the same cancellation semantics, streams close gracefully, and the interrupt/structured output tests cover the updated flows.
- Added a full examples test suite (Codex, Claude, Gemini) that can run under five minutes with per-provider workspaces and environment overrides.
- Publishing prep: adapters now list `@headless-coder-sdk/core` as a peer dependency, while core no longer depends on adapters, and `CHANGELOG.md` documents the release history.
- Added a `packages/*/dist/` gitignore rule plus clean `npm run build --workspace <pkg>` outputs, making the core + adapters ready for npm/pnpm publication.

### 🧪 Testing & Tooling
- Added interrupt tests for each provider plus structured-output coverage for Gemini and Codex.
- Ensured examples/internal packages stay `"private": true` to prevent accidental publishes.
- Introduced `before-interrupt` git tag and release tag flow (`v0.1.0`, `v0.11.0`).

### ⚙️ Breaking Changes
- None. Existing APIs remain compatible; only internal adapter behaviors improved.

## [0.1.0] - 2025-11-08
### 🎉 First Public Release

This is the first public release of **Headless Coder SDK**, an open-source framework that unifies multiple headless AI-coder SDKs — **OpenAI Codex**, **Anthropic Claude Agent SDK**, and **Google Gemini CLI (headless)** — under one consistent developer interface.

### 🚀 Highlights
- Unified `createCoder()` and thread API across Codex, Claude, and Gemini.
- Standardized streaming via `runStreamed()` and structured output via `outputSchema`.
- Shared permission + sandbox model (`read-only`, `workspace-write`, `danger-full-access`).
- Thread resume support for Codex and Claude adapters.
- Cooperative cancellation using `RunOpts.signal` or `thread.interrupt()`.
- Modular adapter registration pattern:
  ```ts
  registerAdapter(CODEX_CODER, createCodexAdapter);
  ```
- Initial permission and sandbox enforcement layer.
- Example suite for multi-provider workflows and structured output validation.

### 📦 Packages included
- `@headless-coder-sdk/core`  
- `@headless-coder-sdk/codex-adapter`  
- `@headless-coder-sdk/claude-adapter`  
- `@headless-coder-sdk/gemini-adapter`  
- `@headless-coder-sdk/examples`

### 🧩 Developer Docs
- [README](https://github.com/OhadAssulin/headless-coder-sdk#readme)
- [Create Your Own Adapter guide](https://github.com/OhadAssulin/headless-coder-sdk/blob/main/docs/create-your-own-adapter.md)

### 🧠 Notes
This release establishes the unified adapter interface, event model, and sandboxing foundation for future integrations and features — such as structured streaming, granular permissions, and new AI-coder backends.

---

_© 2025 Ohad Assulin — MIT License_

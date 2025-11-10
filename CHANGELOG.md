# Changelog

## [0.13.1] - 2025-11-10
### ✨ Packaging & DX
- Core and every adapter now emit real entry points via `tsup`, producing both ESM (`dist/*.js`) and CommonJS (`dist/*.cjs`) bundles with colocated typings, so downstream apps can import the declared exports without diving into `dist/*/src` internals.
- Updated exports maps to expose `factory`, `types`, adapter workers, and `package.json`, unlocking better metadata discovery and `require()` support.
- Codex adapter gained a README that documents the worker co-location requirement, plus LICENSE files were added to every publishable package for npm completeness.
- Bumped `@openai/codex-sdk` to `0.57.0` and refreshed peer dependency ranges to `^0.13.0` across the adapters.

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

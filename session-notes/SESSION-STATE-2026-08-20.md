# Session State — 2026-08-20 (fix/silent-sse-close-7699 shipped)

**Date**: 2026-08-20 11:00
**Severity**: Medium (2 production bug fixes, shipped)
**Component**: open-sse SSE streaming + compression engine
**Status**: Resolved (2 commits on `fix/silent-sse-close-7699`, worktree `.claude/worktrees/silent-sse-close-7699`)

## What Happened

Two production fixes shipped on branch `fix/silent-sse-close-7699`, cut from `release/v3.8.50`:

1. **e8dcea8b6** `fix(sse): emit graceful max_tokens truncation on silent mid-stream close (#7699)`
   - `open-sse/utils/streamHandler.ts` — `createDisconnectAwareStream` reworked to distinguish **graceful truncation** (partial content already reached client → emit clean Claude `message_stop`, NO `event: error`) from **real empty-content failure** (#8649 → still emits 502 error, no fake `max_tokens`).
   - User-visible: empty-content Claude error message intentionally changed from `"Upstream stream ended without a terminal marker"` → `"Provider returned empty content"`.
   - Tests: `tests/unit/silent-sse-close-7699.test.ts` updated/added (6 tests).

2. **da182efff** `fix(compression): only explicit boolean compressToolResults overrides step config`
   - `open-sse/services/compression/engines/cavemanAdapter.ts` `liteEngine` — `stepConfig` is `Record<string, unknown>`, so a malformed `compressToolResults` value could leak through the `??` chain as `{}`. Now guarded with `typeof === "boolean"`; falls through to `config.lite` then default `true`.
   - Tests: `tests/unit/compression/lite.test.ts` additions (29 tests total).

## The Brutal Truth

The compression bug is the kind of thing that makes you want to scream: `Record<string, unknown>` is TypeScript telling you the value is untrusted, and the `??` chain happily promoted a garbage `{}` into production config. One wrong env/DB value and `compressToolResults` silently stops compressing — no error, no log, just slower responses. The SSE one is subtler and more expensive: silently closing a stream mid-token when the client already has content was indistinguishable from a real failure, so clients got a spurious `event: error` and (worse) a fake `max_tokens` truncation that lied about _why_ the stream ended. Both are "quiet corruption" class bugs — the kind that don't page anyone but erode trust and cost tokens.

## Verification

- 35/35 in changed test files (`silent-sse-close-7699.test.ts` + `compression/lite.test.ts`) ✅
- 33/33 in pre-existing blast-radius guards (`empty-stream-no-content-8649.test.ts`, `stream-handler.test.ts`) ✅
- **68/68 pass total**
- `typecheck:core` clean; `eslint` clean on the 4 files
- `code-reviewer` subagent verdict: **PASS**

## Workflow Notes

- Changes moved from shared checkout into new worktree via `git diff HEAD` patch (**no stash**, per repo Rule #22); `node_modules` hardlinked with `cp -al`.
- Shared checkout returned to clean state on `release/v3.8.50`.
- Both commits have **no AI attribution** (repo Rule #16). Author: `minhlongs`.
- Local tip `2f5eca2b5`, **22 commits ahead** of `origin/release/v3.8.50`.

## Known Pre-Existing Issue (base-red — NOT part of this fix, do not fix here)

Migration version collision `v139` → `[ccr_blocks, job_registry]` in the `callLogs` test artifact rotation path.

## Next Steps

- Push `fix/silent-sse-close-7699` and open PR against `release/v3.8.50` (or next active release branch per Rule #21 freeze check).
- Base-red warning annotation in PR body if base not green.
- Follow-up candidate (separate task): harden `cavemanAdapter` step-config parsing with a Zod schema instead of per-field `typeof` guards.

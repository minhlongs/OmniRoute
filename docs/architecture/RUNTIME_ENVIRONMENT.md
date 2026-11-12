---
title: "Runtime Environment & Toolchain"
version: 3.8.50
lastUpdated: 2026-11-12
---

# Runtime Environment & Toolchain

Runtime, package-manager and toolchain boundaries. The short version (supported Node range, port,
aliases, env vars) stays in [`AGENTS.md`](../../AGENTS.md#environment); this page keeps the full
rationale for the Node-only support matrix and for the narrow, allow-listed use of Bun.

## Runtime and toolchain policy

- **Runtime**: Node.js ≥22.0.0 <23 || ≥24.0.0 <27, ES Modules. This is the **only supported** runtime for the published `omniroute` CLI, the server, and the test suites (`node:test` + vitest) — `engines.node` is authoritative and end users never need Bun. A **best-effort `bun:sqlite` compatibility path** exists so a global Bun install (`bun install -g omniroute`) can start without `better-sqlite3` (driver adapter + Bun-aware process spawning); it is **not** a supported runtime — no support guarantees — and every Bun-specific runtime change MUST preserve the Node driver/fallback chain and ship a Bun test (`test:bun:db`) or an explicit reason why the path is Node-only.
- **Bun (build/dev script runner + compatibility smoke only)**: Bun `1.3.14` is pinned as an **exact devDependency** (provisioned through the existing `npm ci` via the lockfile's `@oven/bun-*` platform binaries — no `setup-bun`/ad-hoc install). It is used **only** to execute a small, allow-listed set of TypeScript **gate/generator scripts** (replacing `node --import tsx` for startup speed): the CI checks `check:provider-consistency`, `check:compression-budget`, `check:known-symbols`, and the non-CI `gen:provider-reference`, `bench:compression` — plus the focused `test:bun:db` compatibility smoke suite for the best-effort `bun:sqlite` path. **Do NOT** widen Bun to `npm install`, the build (`build:cli*`), `check:pack-artifact`, the supported published runtime, or the main test runners — those stay on Node. Any new Bun-invoking gate/generator script must be validated byte-identical against its `node --import tsx` output first. After pulling the lockfile change, run `npm install` so `bun` resolves locally (a stale `node_modules` will fail those scripts with `bun: not found`).
- **TypeScript**: 6.0+, target ES2022, module esnext, resolution bundler
- **Path aliases**: `@/*` → `src/`, `@omniroute/open-sse` → `open-sse/`, `@omniroute/open-sse/*` → `open-sse/*`
- **Default port**: 20128 (API + dashboard on same port)
- **Data directory**: `DATA_DIR` env var, defaults to `~/.omniroute/`
- **Key env vars**: `PORT`, `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, `REQUIRE_API_KEY`, `APP_LOG_LEVEL`
- Setup: `cp .env.example .env` then generate `JWT_SECRET` (`openssl rand -base64 48`) and `API_KEY_SECRET` (`openssl rand -hex 32`)

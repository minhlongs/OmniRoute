# OmniRoute agent guide

> **Single source of truth.** This file is the operative contract for every AI assistant working
> this repository (Claude Code, Gemini, Codex, Copilot, and any other agent). `CLAUDE.md` and
> `GEMINI.md` only add assistant-specific deltas and point back here. When a rule needs to change,
> change it HERE — never re-fork it into an assistant-specific file.
>
> **Progressive disclosure.** Long reference material lives in linked docs, not here. Always in
> force: the **Hard Rules** (23, below), **File placement**, **Security** conventions and the
> **test-in-the-same-PR rule**; everything else is reference. Deep dives:
> [HARD_RULES](docs/architecture/HARD_RULES.md) (full text + precedents),
> [AGENT_WORKFLOW](docs/architecture/AGENT_WORKFLOW.md) (worktree, base-green, TDD/VPS gate),
> [MODIFICATION_SCENARIOS](docs/architecture/MODIFICATION_SCENARIOS.md),
> [RUNTIME_ENVIRONMENT](docs/architecture/RUNTIME_ENVIRONMENT.md),
> [`RESILIENCE_GUIDE`](docs/architecture/RESILIENCE_GUIDE.md),
> [PII_STREAM_LEARNINGS](docs/security/PII_STREAM_LEARNINGS.md), [`docs/README.md`](docs/README.md).
> Root size is capped at 30 KB by `node scripts/check/check-agent-rules.mjs` — put new detail in a
> linked doc instead of growing this contract.

---

## Context & retrieval discipline (mandatory)

Every session pays for what it loads. Retrieve the smallest thing that answers the question and
cite `path:line` — never "I read the repo".

**Order of attack — stop at the first step that answers it:**

1. **Index / memory first.** With a codebase-memory MCP index attached, query it (semantic search /
   symbol lookup) before opening files. Indexing skips generated trees via `.cbmignore`.
2. **Search for the symbol, not the feature.** One targeted ripgrep —
   `rg -n "<symbol|route|env var>" src/ open-sse/ bin/` (or the harness search tool) costs a few
   lines; a speculative full-file read costs thousands.
3. **OmniRoute MCP retrieval tools (read-only).** The OmniRoute MCP server
   ([`docs/frameworks/MCP-SERVER.md`](docs/frameworks/MCP-SERVER.md)) exposes read-only retrieval
   tools (memory, skills, context). Prefer them when they fit; discover the live tool list from the
   server instead of guessing names, and never call a mutating tool for a read task.
4. **Targeted read of one range** — `offset`/`limit` around the hit (default ≤ 200 lines), not the
   whole file — or a **docs deep-dive** when the question is "how does this work", not "where".

**Context caps:**

- Never `cat` a file, never dump a whole file into a message or subagent prompt, never read "the
  whole project". Quote only the lines that justify the change (`path/to/file.ts:120-134`).
- Size before reading: `wc -lc <file>`. Above ~1,000 lines build an outline first
  (`rg -n '^(export )?(async )?(function|class|const)' <file>`) and read only the hit range.
- Cap a single file read at ~200 lines (page with `offset`); cap an investigation at ~8-10 targeted
  reads. Needing more means the search term is wrong — re-grep sharper, or ask which module owns it.
- Never load whole: `CHANGELOG.md`, `README.md`, `docs/i18n/**`, `docs/superpowers/**`,
  `docs/openapi.yaml`, `package-lock.json`, `.env.example`, `llm.txt`.
- **Prefer summaries** — keep a 5-line summary (purpose, entry point, owner) instead of excerpts, and
  when delegating hand over the file list + symbol names, never "read the repo and report".

**Ignore lists:** `.claudeignore` (retrieval tools) and `.cbmignore` (codebase-memory) exclude
generated/build/vendor/artifact trees on purpose. Never widen them to hide source — `tests/`,
`docs/**` (except translations), `scripts/`, and every `src/`, `open-sse/`, `bin/` file must stay
searchable.

**Anti-patterns:** reading `README.md`/`CHANGELOG.md` "to get context"; re-reading a file you already
summarized; pasting generated OpenAPI/JSON; `ls -R` dumps; a subagent sent to "review the repo".

---

## Quick Start

```bash
npm install                    # auto-generates .env from .env.example
npm run dev                    # dev server at http://localhost:20128
npm run build                  # production build (Next.js 16 standalone)
npm run lint                   # 0 errors expected; warnings are pre-existing
npm run typecheck:core         # should be clean
npm run typecheck:noimplicit:core  # strict, no implicit any
npm run test:coverage          # unit tests + coverage gate (60/60/60/60)
npm run check                  # lint + test
npm run check:cycles           # circular dependencies
npm run check:docs-all         # after changing documentation
```

Run the most focused test first — see [Testing](#testing) for the runner split. Matrix:
`CONTRIBUTING.md` → "Running Tests".

---

## Architecture at a glance

**OmniRoute** — unified AI proxy/router. One endpoint, 352 LLM providers, auto-fallback.

Layers: `src/app/api/v1/` API routes → `open-sse/handlers/` request processing →
`open-sse/executors/` provider HTTP dispatch → `open-sse/translator/` format conversion
(OpenAI↔Claude↔Gemini) → `open-sse/transformer/` Responses API ↔ Chat Completions. Shared:
`open-sse/services/` (combo routing, rate limits, caching), `src/lib/db/` (SQLite domain modules,
159 migrations), `src/domain/` (policy engine, cost rules, fallback), `src/lib/a2a/` (JSON-RPC 2.0
agent protocol), `src/lib/skills/`, `src/lib/memory/`, and `open-sse/mcp-server/` (MCP server: 110
tools, 3 transports — stdio/SSE/Streamable HTTP — 33 scopes).

Monorepo: `src/` (Next.js 16 app), `open-sse/` (streaming engine workspace), `electron/` (desktop
app), `tests/`, `bin/` (CLI entry point).

API routes follow one pattern: `Route → CORS preflight → Zod body validation → optional auth
(extractApiKey/isValidApiKey) → API key policy enforcement → handler delegation (open-sse)`. No
global middleware — interception is route-specific. Full pipeline, step by step:
[`ARCHITECTURE`](docs/architecture/ARCHITECTURE.md) and
[`CODEBASE_DOCUMENTATION`](docs/architecture/CODEBASE_DOCUMENTATION.md) §9.

**Combo routing** (`open-sse/services/combo.ts`): 19 strategies; each target calls
`handleSingleModel()` (wraps `handleChatCore()` with per-target errors + breaker checks); `fusion`
fans out to a panel, then a judge model synthesizes. Table + 14-factor scoring:
[`docs/routing/AUTO-COMBO.md`](docs/routing/AUTO-COMBO.md). **Temporary-failure state** has three
scopes — provider circuit breaker (whole provider), connection cooldown (one key), model lockout
(provider+connection+model). States, trip codes, lazy recovery, debugging tree:
[`docs/architecture/RESILIENCE_GUIDE.md`](docs/architecture/RESILIENCE_GUIDE.md).

**Breaker defaults** (`open-sse/config/constants.ts` → `PROVIDER_PROFILES`). Two thresholds live
side by side — never confuse them:

| Profile | `providerFailureThreshold` | `providerCooldownMs` | `circuitBreakerThreshold` | `circuitBreakerReset` |
| ------- | -------------------------: | -------------------: | ------------------------: | --------------------: |
| OAuth   |                       `10` |               `5min` |                       `8` |                 `60s` |
| API key |                       `15` |              `10min` |                      `12` |                 `30s` |
| Local   |                        `2` |               `1min` |                       `2` |                 `15s` |

Provider-level thresholds were scaled up for deployments with 500+ connections (OAuth was `3`, API
key was `5`); every default is overridable via `OMNIROUTE_PROVIDER_BREAKER_*` and
`OMNIROUTE_CIRCUIT_BREAKER_*`. Only `[408, 500, 502, 503, 504]` trip the provider breaker.

---

## Repository map

Read the nearest area `AGENTS.md` (in `open-sse/services/` or `src/lib/db/`) and the linked
deep-dive before a non-trivial change. Full index: [`docs/README.md`](docs/README.md).

- **API routes / handlers** `src/app/api/v1/`, `open-sse/handlers/` → [`ARCHITECTURE`](docs/architecture/ARCHITECTURE.md)
- **Executors / translators** `open-sse/executors/`, `open-sse/translator/` → [`CODEBASE_DOCUMENTATION`](docs/architecture/CODEBASE_DOCUMENTATION.md)
- **Routing / resilience** `open-sse/services/` → [`open-sse/services/AGENTS.md`](open-sse/services/AGENTS.md), [`AUTO-COMBO`](docs/routing/AUTO-COMBO.md)
- **Database** `src/lib/db/`, `db/migrations/` → [`src/lib/db/AGENTS.md`](src/lib/db/AGENTS.md)
- **MCP / A2A / agent features** `open-sse/mcp-server/`, `src/lib/a2a/`, `src/lib/{acp,memory,skills,cloudAgent}/` → [`MCP-SERVER`](docs/frameworks/MCP-SERVER.md), [`A2A-SERVER`](docs/frameworks/A2A-SERVER.md)
- **Security / authz** `src/lib/{guardrails,compliance}/`, `src/server/authz/` → [`GUARDRAILS`](docs/security/GUARDRAILS.md), [`AUTHZ_GUIDE`](docs/architecture/AUTHZ_GUIDE.md)
- **Ops / quality** `src/mitm/`, `electron/`, `scripts/check/` → [TUNNELS_GUIDE](docs/ops/TUNNELS_GUIDE.md), [QUALITY_GATES](docs/architecture/QUALITY_GATES.md)

Also worth knowing: `docs/reference/{API_REFERENCE,PROVIDER_REFERENCE,ENVIRONMENT}.md`,
`docs/openapi.yaml`, `docs/ops/RELEASE_CHECKLIST.md`, `docs/guides/VSCODE-COPILOT.md`.

---

## File placement & repo-root hygiene

- **Test files**: ALL unit, integration, ecosystem and Vitest tests MUST live under `tests/`
  (`tests/unit/`, `tests/integration/`, …). NEVER create test files in the project root (`/`).
- **Scripts and utilities**: ALL maintenance, debugging, generation or experimental scripts
  (`.cjs`, `.mjs`, `.js`, `.ts`) MUST live in an existing `scripts/` subfolder (`ls scripts/` —
  `build/`, `dev/`, `check/`, `docs/`, `i18n/`, `quality/`, `release/`, `ad-hoc/`, …). One-shot or
  experimental code goes to `scripts/ad-hoc/`. NEVER dump loose scripts in the project root or the
  top-level `scripts/` folder.

**The project root MUST ONLY contain:** config files (`vitest.config.ts`, `next.config.mjs`,
`eslint.config.mjs`, `tsconfig*.json`, `playwright.config.ts`, `prettier.config.mjs`,
`postcss.config.mjs`, `sonar-project.properties`, `fly.toml`, `docker-compose*.yml`, `Dockerfile`);
dependency files (`package.json`, `package-lock.json`); docs (`README.md`, `CHANGELOG.md`,
`ROADMAP.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, `PROVIDER_REFERENCE.md`, `THIRD_PARTY_NOTICES.md`, `llm.txt`); ignore/CI
definitions (`.gitignore`, `.claudeignore`, `.cbmignore`, `.dockerignore`, `.npmignore`, `.npmrc`,
`.node-version`, `.nvmrc`, `.env.example`). One-off tests/scripts go to `scripts/ad-hoc/` or
`tests/unit/`.

**Root `_*` paths are private, untracked content** (today: `_tasks/`, the planning repo). `.gitignore`
anchors `/_*/` and `/_*`; they are never staged — not with `git add -f`, not as a symlink. Removing
one that was accidentally tracked means `git rm --cached <path>` plus an ignore review, never a
delete. `npm run check:tracked-artifacts` (a pre-commit hook) fails on ANY tracked root path
starting with `_`. See Hard Rule #23 for the `_tasks` specifics.

---

## Key Conventions

### Code Style

- **2 spaces**, semicolons, double quotes, 100 char width, es5 trailing commas (lint-staged via
  Prettier) — run Prettier on changed files
- **Imports**: external → internal (`@/`, `@omniroute/open-sse`) → relative
- **Naming**: files=camelCase/kebab, components=PascalCase, constants=UPPER_SNAKE
- **ESLint**: `no-eval`, `no-implied-eval`, `no-new-func` = error everywhere; `no-explicit-any` =
  **error** in `open-sse/` and `tests/` (pre-existing violations frozen in
  `config/quality/eslint-suppressions.json`; new ones must be fixed; `npm run lint` applies the
  suppressions and is what CI runs)
- **TypeScript**: `strict: false`, target ES2022, module esnext, resolution bundler; prefer
  explicit types

### Database

- **Always** go through `src/lib/db/` domain modules — **never** write raw SQL in routes or handlers
- **Never** add logic to `src/lib/localDb.ts` (re-export layer only); **never** barrel-import from
  it — import the specific `db/` module
- DB singleton: `getDbInstance()` from `src/lib/db/core.ts` (WAL journaling)
- Migrations: `src/lib/db/migrations/` — versioned SQL files, idempotent, run in transactions

### Error Handling

- try/catch with specific error types, log with pino context
- Never swallow errors in SSE streams — use abort signals for cleanup
- Return proper HTTP status codes (4xx/5xx)

### Security

- **Never** use `eval()`, `new Function()`, or implied eval; validate all inputs with Zod schemas;
  sanitize user HTML with DOMPurify; encrypt credentials at rest (AES-256-GCM) and never log SQLite
  encryption keys
- Upstream header denylist: `src/shared/constants/upstreamHeaders.ts` — keep sanitize, Zod schemas
  and unit tests aligned when editing
- Public upstream credentials, error sanitization and shell-command interpolation are Hard Rules
  #11/#12/#13 — the detail lives in `docs/security/PUBLIC_CREDS.md`,
  `docs/security/ERROR_SANITIZATION.md`, and `src/mitm/cert/install.ts::updateNssDatabases`.
- **Secure-by-default libraries** ([awesome-secure-defaults](https://github.com/tldrsec/awesome-secure-defaults)):
  prefer Helmet.js, DOMPurify, ssrf-req-filter, safe-regex, Google Tink over custom code.

---

## Documentation accuracy

Documentation must describe verified behavior, not plausible behavior.

1. Before documenting an API name, endpoint, path, CLI command or env var, search for it:
   `rg -n "name" src/ open-sse/ bin/`. No source match → do not document it.
2. Measure mutable counts instead of writing them from memory (`wc -l <file>` or a directory count).
3. Copy code examples from working usage or run them; prefer `path/to/file.ts:line` to an invented
   signature.
4. Run `npm run check:docs-all` for edits under `docs/` (it includes the fabricated-docs validation)
   and `node scripts/check/check-agent-rules.mjs` when editing `AGENTS.md` or a
   `docs/architecture/AGENT_*` / `docs/architecture/HARD_RULES.md` page.

---

## Common modification scenarios

Per-change recipes — read only yours:
[`docs/architecture/MODIFICATION_SCENARIOS.md`](docs/architecture/MODIFICATION_SCENARIOS.md).

- New provider → `src/shared/constants/providers.ts` → executor/translator → `providerRegistry.ts`
- New API route → `src/app/api/v1/<route>/route.ts` → handler in `open-sse/handlers/`
- New DB module → `src/lib/db/<module>.ts` → migration → re-export list only
- New MCP tool → `open-sse/mcp-server/tools/` → tool set → scope assignment
- New A2A skill / cloud agent → `src/lib/a2a/skills/` / `src/lib/cloudAgent/agents/` → registry
- New embedded service → `src/lib/services/installers/` → bootstrap → API routes → UI tab
- Guardrail / eval / webhook → `src/lib/{guardrails,evals}/`, `src/lib/webhookDispatcher.ts`

---

## Testing

| What                           | Command                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Unit tests                     | `npm run test:unit`                                                           |
| Single file                    | `node --import tsx/esm --test tests/unit/your-file.test.ts`                   |
| Vitest (MCP server, autoCombo) | `npm run test:vitest`                                                         |
| Protocol E2E (MCP + A2A)       | `npm run test:protocols:e2e` (CI job `test-protocols-e2e`, advisory — #10049) |
| Ecosystem                      | `npm run test:ecosystem` (CI job `test-ecosystem`, blocking)                  |
| Coverage gate                  | `npm run test:coverage` (60/60/60/60 — statements/lines/functions/branches)   |
| Coverage report                | `npm run coverage:report`                                                     |

**PR rule**: changing production code in `src/`, `open-sse/`, `electron/` or `bin/` requires
included/updated tests in the same PR (unit → integration → e2e preference). **Both runners must
pass** on their non-overlapping files: `npm run test:unit` (Node native) AND `npm run test:vitest`
(MCP server, autoCombo, cache) — both blocking CI jobs.

**Bug fix / issue triage (Hard Rule #18)**: every fix for a reported issue needs a failing-then-
passing test (TDD) or a documented live test on the production VPS (`root@192.168.0.15`) — "it
worked locally" is not a fix. Decision tree:
[`docs/architecture/AGENT_WORKFLOW.md`](docs/architecture/AGENT_WORKFLOW.md#testing-policy-detail).

---

## Review focus

- Keep database operations in `src/lib/db/`; no raw SQL from routes.
- Send provider requests through `open-sse/handlers/`; keep MCP and A2A pages as tabs inside
  `/dashboard/endpoint`.
- Preserve SSE cleanup, rate-limit header parsing, Zod validation and provider-schema validation.
- Treat Memory and Skills as cross-cutting changes (MCP tools, request pipeline, A2A skills).
- Do not close a contributor PR after using its code; merge it through GitHub so the contributor
  receives credit.

---

## Planning & research artifacts

`_tasks/` is a **separate, isolated git repository**, gitignored by the main repo. It is the
canonical home for plans, specs/designs, research and hand-offs.

**Never write planning/research output under `docs/` or the repo root.** Any plan/spec/research
generator (superpowers or otherwise) saves and commits inside `_tasks/` (`git -C _tasks …`), never
in the main repo: plans `_tasks/superpowers/plans/YYYY-MM-DD-<feature>.md`, specs
`_tasks/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, research `_tasks/research/…`, hand-offs
`_tasks/hands-off/<YYYY-MM-DD>_<branch>_v<versão>_sess-<id>/`.

---

## Git Workflow

**Branch prefixes**: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`. **Commit format**
(Conventional Commits): `feat(db): add circuit breaker` — scopes: `db`, `sse`, `oauth`,
`dashboard`, `api`, `cli`, `docker`, `ci`, `mcp`, `a2a`, `memory`, `skills`. Never commit to `main`.

**Husky hooks**: pre-commit = lint-staged + `check-docs-sync` + `check:any-budget:t11` +
`check:tracked-artifacts`; pre-push = PATH/npm sanity only (CI enforces both).

### Worktree isolation (MANDATORY for every development task)

Never develop on the shared main checkout — a `git checkout` there silently discards another
session's uncommitted work. Every task gets its own worktree under `.claude/worktrees/` on its own
branch, cut from the base branch the operator confirms (never assume `main`):

```bash
git worktree add ".claude/worktrees/<task>" -b "<task>" "origin/$BASE_BRANCH"
cp -al <main_checkout>/node_modules node_modules   # HARD LINKS, never `ln -s`
```

`.claude/worktrees/` is the only canonical path (gitignored, excluded from
`tsconfig.json`/`.dockerignore`); anywhere else poisons `next build`. Never `ln -s` node_modules —
Turbopack rejects it while typecheck/lint/tests stay green. Tear down only your own worktree +
branch, leave other sessions' alone, and end on the branch you started on.

### Base-green check (PRs must not be born red)

Before cutting a branch or opening a PR, check the base tip for an open `base-red` issue:

```bash
gh issue list --repo diegosouzapw/OmniRoute --state open \
  --search "Release branch not green: <base> in:title"
```

If the base is red: never treat inherited failures as your branch's defect, never "fix" them inside a
feature branch, and add `⚠️ base-red inherited: #<issue>` to the PR body.

Full protocol + incident rationales: [AGENT_WORKFLOW](docs/architecture/AGENT_WORKFLOW.md).

---

## Upstream contributions

This checkout is a fork of `diegosouzapw/OmniRoute`; keep fork-only deployment and personal
automation changes out of upstream PRs. Start from the active upstream default branch, not `main`:

```bash
git fetch upstream
git switch -c <branch-name> upstream/<default-branch>
```

Target that release branch in the PR, stage only the intended files, run the focused checks and use
a Conventional Commit message. Full rules:
[`docs/architecture/AGENT_WORKFLOW.md`](docs/architecture/AGENT_WORKFLOW.md).

---

## Environment

- **Runtime**: Node.js ≥22.0.0 <23 || ≥24.0.0 <27, ES Modules — the **only supported** runtime for
  the published CLI, server and test suites (`node:test` + vitest); `engines.node` is authoritative.
  The best-effort `bun:sqlite` path has no support guarantee, and any Bun-specific change MUST
  preserve the Node driver/fallback chain.
- **Bun** (pinned exact devDependency) runs **only** an allow-listed set of gate/generator scripts
  and the `test:bun:db` smoke — never `npm install`, the build, `check:pack-artifact` or the main
  test runners. Rationales: [RUNTIME_ENVIRONMENT](docs/architecture/RUNTIME_ENVIRONMENT.md).
- **Toolchain**: TypeScript 6.0+, target ES2022, module esnext, resolution bundler. Path aliases:
  `@/*` → `src/`, `@omniroute/open-sse` → `open-sse/`, `@omniroute/open-sse/*` → `open-sse/*`.
- **Runtime config**: default port 20128 (API + dashboard) · data dir `DATA_DIR`, default
  `~/.omniroute/` · key env vars `PORT`, `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`,
  `REQUIRE_API_KEY`, `APP_LOG_LEVEL` · setup `cp .env.example .env`, then `openssl rand -base64 48`
  for `JWT_SECRET` and `openssl rand -hex 32` for `API_KEY_SECRET`.

---

## Quality gates & ratchets

**~80 quality-gate scripts** (`scripts/check/` + `scripts/quality/`) run across the gate-running
jobs in `.github/workflows/ci.yml` (`lint`, `quality-gate`, `quality-extended`, `docs-sync-strict`,
`i18n-ui-coverage`, `i18n`, `pr-test-policy`, `test-vitest`, `sonarqube`), plus the `quality.yml`
fast gates and 3 nightly workflows — inventory:
[`docs/architecture/QUALITY_GATES.md`](docs/architecture/QUALITY_GATES.md).

- `lint` + `docs-sync-strict` are **pass/fail policy gates** — fix the violation or add an allowlist
  entry with a justification comment + tracking issue.
- `quality-gate` is a **ratchet** — ESLint warnings, coverage, duplication and complexity must not
  regress vs `quality-baseline.json`; `npm run quality:ratchet -- --update` only on real gains.
  `test-vitest` (MCP tools, autoCombo, cache) is blocking.
- **Allowlist policy:** fix the cause; allowlist only pre-existing violations you cannot fix in the
  same PR, with a justification comment + issue number — stale entries are flagged automatically.

---

## Hard Rules

Full normative text, precedents and dismissal criteria:
[`docs/architecture/HARD_RULES.md`](docs/architecture/HARD_RULES.md). The obligations below are the
contract.

1. Never commit secrets or credentials.
2. Never add logic to `localDb.ts` (re-export layer only).
3. Never use `eval()` / `new Function()` / implied eval.
4. Never commit directly to `main`.
5. Never write raw SQL in routes — use `src/lib/db/` modules.
6. Never silently swallow errors in SSE streams.
7. Always validate inputs with Zod schemas.
8. Always include tests when changing production code.
9. Coverage must not regress below the `quality-baseline.json` ratchet; absolute floor 60%
   statements/lines/functions/branches. `npm run quality:ratchet -- --update` only on real gains.
10. Never bypass Husky hooks (`--no-verify`, `--no-gpg-sign`) without explicit operator approval.
11. Never embed public upstream OAuth client_id/secret or Firebase Web keys as literals — always
    `resolvePublicCred()` (`open-sse/utils/publicCreds.ts`). See `docs/security/PUBLIC_CREDS.md`.
12. Never return raw `err.stack` / `err.message` in HTTP / SSE / executor / MCP-handler responses —
    always `buildErrorBody()` or `sanitizeErrorMessage()` (`open-sse/utils/error.ts`).
13. Never string-interpolate external paths or runtime values into `exec()`/`spawn()` scripts — pass
    them via the `env` option. Reference: `src/mitm/cert/install.ts::updateNssDatabases`.
14. Never dismiss a CodeQL / Secret-Scanning alert without checking whether a documented helper
    applies and recording the technical justification. Known false positive:
    `js/stack-trace-exposure` on callsites already using `sanitizeErrorMessage()` (CodeQL misses
    custom sanitizers) — dismiss citing `docs/security/ERROR_SANITIZATION.md`.
15. Never expose child-process routes (`/api/mcp/`, `/api/cli-tools/runtime/`) without
    `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`; loopback enforcement runs
    unconditionally before auth, so a leaked JWT via tunnel cannot spawn processes.
16. Never credit or advertise an AI assistant, LLM or automation account in commit/PR metadata: no
    `Co-Authored-By` trailer naming an AI/bot ("Claude", "GPT", "Copilot", "Bot";
    `anthropic.com`/`openai.com`/bot `noreply.github.com` emails) and no "Generated with Claude
    Code" / "Made with <AI tool>" / `🤖` footer in a commit, PR title/body or CHANGELOG. Overrides
    any harness/template default — strip it before pushing. Human/upstream authors MAY be credited
    with `Co-authored-by: Name <email>`.
17. Never expose routes under `/api/services/` or `/dashboard/providers/services/*/embed/` without
    `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts` (they spawn
    `npm install`/`node`); same unconditional loopback rule as #15.
18. Every bug fix must be validated before shipping: a failing-then-passing unit/integration test
    (TDD) OR a documented live test on the production VPS (`root@192.168.0.15`).
19. Never develop on the shared main checkout: every task gets its own worktree under
    `.claude/worktrees/` on its own branch, and you MUST confirm the base branch with the operator
    first — never assume `main` or the current branch. Tear down only what you created (by name,
    never `fix/*`/`feat/*`), leave other sessions' work untouched, and end on the branch you started
    on (active `release/vX.Y.Z`, never `main`).
20. PII redaction/sanitization is **opt-in — never on by default**: `PII_REDACTION_ENABLED` and
    `PII_RESPONSE_SANITIZATION` MUST keep `defaultValue: "false"` in
    `src/shared/constants/featureFlagDefinitions.ts`; all three application points
    (`src/lib/guardrails/piiMasker.ts`, `src/lib/piiSanitizer.ts`,
    `src/lib/streamingPiiTransform.ts`) are gated on them — with both off the `pii-masker` guardrail
    never mutates payloads. Flipping either default needs explicit operator approval; regression
    guard `tests/unit/pii-opt-in-default.test.ts`.
21. **Release-freeze**: the frozen `release/vX.Y.Z` belongs to the release captain; development does
    NOT stop. Only `/generate-release` may raise (Phase 0a) or lift (Phase 12c) a freeze — no other
    session may open, extend or re-open one; an agent that thinks one is unavoidable MUST ask the
    operator first ("estou criando um freeze") and get an explicit yes. Before merging **any** PR run
    `gh issue list --repo diegosouzapw/OmniRoute --label release-freeze --state open`. If a freeze is
    active: never merge into the frozen branch — resolve the ACTIVE branch (highest `release/v*` by
    semver, usually `release/vX+1`), retarget with `gh pr edit <N> --base release/vX+1`, VERIFY with
    `gh pr view <N> --json baseRefName` (the edit fails silently), merge there. HOLD only when the
    highest release branch IS the frozen one; never close an active freeze to unblock merges.
22. **Cross-session safety**: (a) never `git stash` / `git stash pop` — ANYWHERE, including a
    worktree and any subagent you dispatch; stash touches the shared object store and can clobber
    another session's uncommitted work (2026-07-02: `#5923` leaked into `#2296` via a global
    `stash pop`). Use `git show <ref>:<path>` / `git diff <ref> -- <path>` instead, and put this ban
    verbatim in every git-touching subagent prompt. (b) never merge, push, rebase or force-push a
    PR/branch/worktree another session is working on — before merging or pushing a PR you did not
    create _this_ session, run `git worktree list` and re-check
    `gh pr view <N> --json state,headRefOid`; let the owning session merge. Reinforces #19.
23. **`_tasks/` is INTOCÁVEL as a structure — create and edit files inside it, nothing else**: it is
    a separate git repository (private remote `_tasks_omniroute`) that the main repo never tracks,
    so `git -C _tasks add -A && git -C _tasks commit && git -C _tasks push` is the real backup —
    push often. (a) NEVER move, rename, delete, empty or symlink `_tasks`; only create or edit files
    inside it. (b) NEVER track `_tasks` in the main repo, not even as a symlink — a tracked symlink
    plus `git reset --hard` materialized over the real directory and git deleted every ignored file:
    that wiped it twice (2026-08-08 and 2026-08-10). (c) after any relevant write run the backup
    command above. (d) repeat this prohibition VERBATIM in every git-touching subagent prompt.
    (e) if `_tasks` is a broken symlink, commit nothing — restore it from the remote first and alert
    the operator. `npm run check:tracked-artifacts` blocks it in any form.

Full normative text, precedents and dismissal criteria for every rule:
[`docs/architecture/HARD_RULES.md`](docs/architecture/HARD_RULES.md).

---

## PII & stream sanitization learnings

Regex bounds (ReDoS), SSE final-snapshot handling, DB-handle cleanup in tests: read
[PII_STREAM_LEARNINGS](docs/security/PII_STREAM_LEARNINGS.md) before touching PII masking,
`src/lib/piiSanitizer.ts` or the streaming sanitizer.

---

## Local development access

Dashboard: operator's URL/port (default `http://localhost:20128`). Credentials are operator-specific:

- **Initial admin password** comes from `INITIAL_PASSWORD` on first install (`.env.example` defaults
  to `CHANGEME`; rotate after first login).
- **Local VPS / shared dev**: ask the operator for URL + credentials — they live in their vault,
  NOT in this repo.

> Any credential observed in a previous version of this file was a non-production demo value; treat
> it as compromised and do not reuse it.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your
training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.
Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

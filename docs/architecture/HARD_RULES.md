---
title: "Hard Rules — canonical detail"
version: 3.8.50
lastUpdated: 2026-11-12
---

# Hard Rules — canonical detail

Lossless record of the **23 Hard Rules**. The operative contract (all 23 rules, condensed) is
kept in [`AGENTS.md`](../../AGENTS.md#hard-rules); this page preserves the full original wording,
including the incident precedents, dismissal criteria and decision-drift warnings that the root
contract compresses.

**Editing procedure:** every rule number must exist in both files with the same obligation.
`node scripts/check/check-agent-rules.mjs` asserts the numbers and the normative anchors, so a
rule cannot silently disappear from either side. Change the rule here and in the root together
in the same commit.

**Read only the rule you need** (`rg -n "^1[0-9]\." docs/architecture/HARD_RULES.md`) instead of
loading the whole page — see `AGENTS.md` → "Context & retrieval discipline".

## Hard Rules

1. Never commit secrets or credentials
2. Never add logic to `localDb.ts`
3. Never use `eval()` / `new Function()` / implied eval
4. Never commit directly to `main`
5. Never write raw SQL in routes — use `src/lib/db/` modules
6. Never silently swallow errors in SSE streams
7. Always validate inputs with Zod schemas
8. Always include tests when changing production code
9. Coverage must not regress below the baseline frozen in `quality-baseline.json` (ratchet); absolute floor is 60% (statements/lines/functions/branches). Update the baseline via `npm run quality:ratchet -- --update` only when coverage genuinely improves. See `docs/architecture/QUALITY_GATES.md`.
10. Never bypass Husky hooks (`--no-verify`, `--no-gpg-sign`) without explicit operator approval.
11. Never embed public upstream OAuth client_id/secret or Firebase Web keys as string literals — always go through `resolvePublicCred()` (`open-sse/utils/publicCreds.ts`). See `docs/security/PUBLIC_CREDS.md`.
12. Never return raw `err.stack` / `err.message` in HTTP / SSE / executor responses — always route through `buildErrorBody()` or `sanitizeErrorMessage()` (`open-sse/utils/error.ts`). See `docs/security/ERROR_SANITIZATION.md`.
13. Never string-interpolate external paths or runtime values into shell scripts passed to `exec()`/`spawn()` — pass via the `env` option instead. Reference: `src/mitm/cert/install.ts::updateNssDatabases`.
14. Never dismiss a CodeQL / Secret-Scanning alert without (a) first checking the pattern docs above to see if the helper applies, and (b) recording the technical justification in the dismissal comment. Precedent: `js/stack-trace-exposure` raised on callsites that already route through `sanitizeErrorMessage()` is a known CodeQL limitation (custom sanitizers not recognized) — dismiss as `false positive` referencing `docs/security/ERROR_SANITIZATION.md`.
15. Never expose routes that spawn child processes (`/api/mcp/`, `/api/cli-tools/runtime/`) without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. Loopback enforcement happens unconditionally before any auth check — leaked JWT via tunnel cannot trigger process spawning. See `docs/security/ROUTE_GUARD_TIERS.md`.
16. Never credit or advertise an AI assistant, LLM, or automation account in any commit/PR metadata. Two forbidden forms, both equivalent — they route attribution to a bot account (or advertise AI authorship) and hide the real author (`diegosouzapw`): **(a)** `Co-Authored-By` trailers naming an AI/bot (e.g. names containing "Claude", "GPT", "Copilot", "Bot"; emails at `anthropic.com` / `openai.com` / bot-owned `noreply.github.com` addresses); **(b)** AI-generation footers or descriptions anywhere in a commit message, PR title/body, or CHANGELOG — e.g. `🤖 Generated with [Claude Code]`, "Generated with Claude Code", "Made with <AI tool>", or any `Co-authored-by: Claude/GPT/Copilot` line. This **overrides any harness, template, or tool default that auto-appends such a footer** — strip it before pushing; do not let it reach a commit, PR, or CHANGELOG. Human collaborators — including upstream PR authors and issue reporters being ported into OmniRoute — MAY and SHOULD be credited with standard `Co-authored-by: Name <email>` trailers; the upstream-port workflows (`/port-upstream-features`, `/port-upstream-issues`) depend on this.
17. Never expose routes under `/api/services/` or `/dashboard/providers/services/*/embed/` without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. These routes can spawn child processes (`npm install`, `node`). Loopback enforcement happens unconditionally before any auth check — a leaked JWT via tunnel cannot trigger process spawning. See `docs/security/ROUTE_GUARD_TIERS.md`.
18. Every bug fix must be validated before shipping: a failing-then-passing unit/integration test (TDD) OR a documented live test on the production VPS (192.168.0.15). A fix without either is not merged. See Testing → "Bug fix / issue triage protocol" for the full decision tree.
19. Never develop on the shared main checkout. Every development task runs in its own git worktree on its own dedicated branch, and you MUST confirm the base branch with the operator before creating the worktree/branch — never assume `main` or the currently checked-out branch. A `git checkout` in the shared checkout silently destroys other sessions' uncommitted work. Tear down only the worktrees/branches you created (by name, never `fix/*`/`feat/*` wildcards), leave other sessions' worktrees untouched, and end on the branch you started on (the active `release/vX.Y.Z`, never `main`). See Git Workflow → "Worktree isolation".
20. PII redaction/sanitization is **opt-in — never on by default**. OmniRoute proxies for self-hosted/local LLMs where the operator owns the data, so mutating request/response payloads by default would silently corrupt legitimate traffic. The two data-mutating PII feature flags **MUST** keep `defaultValue: "false"` in `src/shared/constants/featureFlagDefinitions.ts`: `PII_REDACTION_ENABLED` (request-side) and `PII_RESPONSE_SANITIZATION` (response + streaming). All three application points — `src/lib/guardrails/piiMasker.ts` (request guardrail), `src/lib/piiSanitizer.ts` (response), `src/lib/streamingPiiTransform.ts` (SSE) — are gated on these flags; with both off the `pii-masker` guardrail still runs but never mutates payloads (data passes through untouched). Flipping either default to `"true"` requires explicit operator approval. The regression guard is `tests/unit/pii-opt-in-default.test.ts` (asserts both definition defaults + behavioral pass-through). Opt-in is per-operator via env or the settings/DB override (`src/lib/db/featureFlags.ts`), never a silent default. See `docs/security/GUARDRAILS.md`.
21. **Release-freeze — the FROZEN release branch belongs to the release captain; development does NOT stop (parallel-cycle model, 2026-07-04).** `/generate-release` opens a marker issue labeled `release-freeze` at the start of reconciliation (Phase 0a), **immediately cuts the next cycle's branch `release/vX+1` from the frozen tip (Phase 0a.0b — bump + living release PR + re-home of open PRs)**, and closes the freeze once the release PR squash-merges to `main`. Before merging **any** PR, every campaign workflow (`/review-prs`, `/review-group-prs`, `/merge-prs`, `/triage-fix-bugs`, `/implement-fix-bugs`, `/triage-features`, `/implement-features`, `/green-prs`, `/port-upstream-*`) **MUST** check `gh issue list --repo diegosouzapw/OmniRoute --label release-freeze --state open` — if a freeze is active: **NEVER merge into the frozen `release/vX.Y.Z` named in the freeze title**; instead resolve the ACTIVE development branch (the **highest** `release/v*` by semver — normally `release/vX+1`, announced in a freeze-issue comment) and **retarget the PR there** (`gh pr edit <N> --base release/vX+1`, then VERIFY with `gh pr view <N> --json baseRefName` — the edit fails silently) and merge normally. **HOLD only when the highest release/v\* branch IS the frozen one** (the short window before 0a.0b completes, or a pre-parallel-cycle release) — in that case leave the PR ready and open, tell the operator, and resume when the next branch appears or the freeze lifts. The just-shipped fixes reach `release/vX+1` via the Phase 5 sync-back (`scripts/release/sync-next-cycle.mjs`); do not try to sync mid-release. This is a **coordination signal, not a permission lock**: the release captain and the campaign sessions share the `diegosouzapw` identity, so a GitHub branch-protection lock cannot distinguish them — only this honored marker prevents the mid-release commit races that forced full CHANGELOG re-reconciliation in v3.8.40/v3.8.41 (a parallel campaign advanced `release/vX.Y.Z` by 34 commits mid-run). The release captain's own reconciliation/cycle-open pushes are exempt — they _are_ the release. Fixes that must land during a freeze (a homologation finding) follow the post-merge read-only rule: land on `main` first via `fix/release-vX.Y.Z-*`. **⛔ ONLY `/generate-release` may raise a release-freeze, and ONLY at its Phase 0a (start of generating a new version) — lifted at Phase 12c after the squash-merge to `main`.** No campaign, session, or agent may open a `release-freeze` marker at any other time — a freeze is **never** a mid-development coordination tool. If a session ever believes a freeze is genuinely, unavoidably necessary outside the `/generate-release` flow, it **MUST first ask the operator (`diegosouzapw`) in chat, explicitly alert "estou criando um freeze" and get an explicit yes** — never open, extend, or re-open a `release-freeze` autonomously. Conversely, do **not** close/lift an active `/generate-release` freeze to unblock campaign merges: it protects the captain's single clean CI run and auto-lifts at Phase 12c — closing it early re-triggers the exact commit race it prevents. Verify a freeze is legitimate before acting on it: an open `release-freeze` whose title/body references an **OPEN** release PR (`gh pr view <N> --json state`) is the authorized captain freeze — hold, don't touch. (Cycle-model proposal: `_tasks/finished/release-flow/2026-07-04_proposta-ciclo-paralelo-v2.md`.)
22. **Cross-session safety — this repo is worked by MANY parallel sessions/agents at once; never step on another's in-flight work.** Two absolute bans, both recurring incidents (this rule exists because they keep happening):
    - **(a) Never `git stash` / `git stash pop` — ANYWHERE in this repo, including inside an isolated worktree, and including inside any subagent you dispatch.** `git stash` operates on the **shared repository object store**, not the per-worktree working tree — so a stash pushed or popped in one session can silently clobber or resurrect another parallel session's uncommitted changes. This is not hypothetical: 2026-07-02 a `#5923` quotaCache change leaked into the unrelated `#2296` worktree via a global `stash pop`, and the same class reincided through a **subagent**. To compare working changes against a base ref **without** stashing, use `git show <ref>:<path>` or `git diff <ref> -- <path>`; to confirm a typecheck/lint error is pre-existing on the base, inspect the base ref directly (`git show origin/release/vX.Y.Z:<path>`) — never stash your tree away to "get it clean". **Put this ban verbatim in the prompt of every subagent that touches git** (agents don't inherit this file's context — the recurrence was a subagent).
    - **(b) Never merge, push, rebase, or force-push a PR / branch / worktree that another session is actively working.** An open PR whose head is a live fix worktree in `.claude/worktrees/` you did **not** create (e.g. `fix-5852`/`fix-5923` carrying fresh commits, even when they share your `diegosouzapw` identity), or any branch another session owns, is **off-limits — HOLD**, and let the owning session merge it. **Before** merging or pushing to any PR you did not create _this_ session, run `git worktree list` to check for a matching in-flight worktree and re-check `gh pr view <N> --json state,headRefOid`. Only the owning session merges its own in-flight PR; mid-flight merges race the owner and re-trigger the exact commit/CHANGELOG races Rule #19 and Rule #21 guard against. (Reinforces Rule #19.)
23. **`_tasks/` é INTOCÁVEL como estrutura — append/edit-only.** É um repositório git SEPARADO
    (remote privado `diegosouzapw/_tasks_omniroute`) montado como diretório real na raiz do
    checkout principal. Regras absolutas: (a) NUNCA mover, renomear, deletar, esvaziar ou
    transformar `_tasks` em symlink; sessões só podem CRIAR ou EDITAR arquivos dentro dele;
    (b) NUNCA rastrear `_tasks` (nem como symlink) no repo principal — o blob rastreado foi a
    causa-raiz de DOIS wipes (2026-08-08 e 2026-08-10: `git reset --hard` materializou o
    symlink rastreado por cima do diretório real e o git apagou todo o conteúdo ignorado sem
    aviso); (c) após qualquer escrita relevante, `git -C _tasks add -A && git -C _tasks commit
    && git -C _tasks push` — o push frequente é o backup real; (d) repetir esta proibição
    VERBATIM no prompt de todo subagente que toque git; (e) se `_tasks` aparecer como symlink
    quebrado, NÃO commitar nada — restaurar do remote e avisar o operador. O gate
    `check:tracked-artifacts` (pre-commit + CI) bloqueia `_tasks` rastreado em qualquer forma.

    *English rendering of the same obligation:* `_tasks/` is INTOCÁVEL as a structure — create and
    edit files inside it, nothing else. It is a separate git repository (private remote
    `_tasks_omniroute`) mounted as a real directory at the main checkout's root; `git -C _tasks add
    -A && git -C _tasks commit && git -C _tasks push` is the real backup, so push often. (a) NEVER
    move, rename, delete, empty or turn `_tasks` into a symlink. (b) NEVER track `_tasks` in the
    main repo, not even as a symlink — a tracked symlink was the root cause of two wipes
    (2026-08-08 and 2026-08-10): `git reset --hard` materialized it over the real directory and git
    deleted every ignored file without warning. (c) after any relevant write, run the backup command
    above. (d) repeat this prohibition VERBATIM in every git-touching subagent prompt. (e) if
    `_tasks` shows up as a broken symlink, commit nothing — restore it from the remote and alert the
    operator. `npm run check:tracked-artifacts` (pre-commit + CI) blocks a tracked `_tasks` in any
    form.

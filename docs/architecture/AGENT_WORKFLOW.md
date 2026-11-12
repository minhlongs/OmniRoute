---
title: "Agent Workflow & Git Protocol"
version: 3.8.50
lastUpdated: 2026-11-12
---

# Agent Workflow & Git Protocol

Full operational protocol for git work, worktrees, testing gates and upstream contributions.
The root [`AGENTS.md`](../../AGENTS.md) carries the short contract (branch rules, mandatory
worktree path, base-green check); this page is the long form: the incident rationales, the exact
`git worktree` command sequence, the bug-fix validation decision tree and the upstream fork rules.

Read the section for your task only — worktree setup, a red base, a bug fix, or an upstream PR.

## Git Workflow

```bash
# Never commit directly to main
git checkout -b feat/your-feature
git commit -m "feat: describe your change"
git push -u origin feat/your-feature
```

**Branch prefixes**: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`

**Commit format** (Conventional Commits): `feat(db): add circuit breaker` — scopes: `db`, `sse`, `oauth`, `dashboard`, `api`, `cli`, `docker`, `ci`, `mcp`, `a2a`, `memory`, `skills`

**Husky hooks**:

- **pre-commit**: lint-staged + `check-docs-sync` + `check:any-budget:t11` + `check:tracked-artifacts`
- **pre-push**: intentionally light (PATH/npm sanity only). `any-budget` + `tracked-artifacts`
  already run on pre-commit; re-running them on every push was pure double-pay. CI still
  enforces both. (Was Fase 6A.12 full pre-push gate; folded into pre-commit in #6716.)

### Worktree isolation (MANDATORY for every development task)

Multiple sessions/agents work this repo in parallel. The main checkout is **shared**, so a
`git checkout`/branch switch in it silently discards another session's uncommitted work and
yanks the branch out from under whatever else is running (incidents: 2026-06-05, 2026-06-13).

**Rule: never develop on the shared main checkout. Every task gets its own git worktree on its
own dedicated branch, and you MUST confirm the base branch with the operator before creating it.**

1. **Ask first — which base branch?** Before creating anything, ask the operator (unless they
   already told you) from which branch the new worktree/branch should be cut. Do NOT assume
   `main` or "whatever I'm on" — the answer is usually the active `release/vX.Y.Z`, but it can
   be another feature/release branch. Get the base explicitly.
2. **Create an isolated worktree + branch off that base** (never reuse the main checkout).
   **🔴 MANDATORY PATH: every worktree lives under `.claude/worktrees/` — and nowhere else.**
   This is the single canonical location. It is gitignored AND in the `tsconfig.json` /
   `.dockerignore` excludes, so worktrees never leak into the build scope. **Never** use
   `.worktrees/`, repo-root, or any other path — a worktree outside `.claude/worktrees/`
   (a) escapes the build-scope excludes and poisons `next build` (the `tsconfig`
   `include: **/*` globs ~70× the codebase → OOM; incident 2026-06-25) and (b) scatters
   worktrees across two dirs.

   ```bash
   BASE_BRANCH="release/vX.Y.Z"          # ← the branch the operator confirmed in step 1
   TASK="feat/your-feature"               # feat/ fix/ refactor/ docs/ test/ chore/
   git fetch origin "$BASE_BRANCH"
   git worktree add ".claude/worktrees/${TASK##*/}" -b "$TASK" "origin/$BASE_BRANCH"
   cd ".claude/worktrees/${TASK##*/}"
   # Reuse the main checkout's node_modules to skip a per-worktree npm install.
   # HARD LINKS (`cp -al`), never a symlink: ~5s for the whole tree and near-zero extra
   # disk (the inodes are shared), and unlike a symlink it does not break the dev server.
   cp -al "$(git -C <main_checkout> rev-parse --show-toplevel)/node_modules" node_modules
   ```

   **Never `ln -s` node_modules.** Turbopack rejects a symlink that resolves outside the
   project root, so `npm run dev` dies with a FATAL panic (`Symlink [project]/node_modules
is invalid, it points out of the filesystem root`) while typecheck, lint and the test
   runners all keep passing — the error names "filesystem root", not the worktree, so it
   reads like a Next/build bug and costs real time to trace (incident 2026-07-31, #9043).

3. **Work, commit, push, open the PR — all from inside the worktree.** Never `git checkout` a
   different branch inside a worktree another session might share.
4. **Tear down only your own** worktree + branch when done, from the main checkout:
   `git worktree remove .claude/worktrees/<dir>` then `git branch -D <task>`. Never blanket-delete
   `fix/*`/`feat/*` — other sessions keep their own; delete only the branches you created, by name.
5. **Never touch another session's worktree, branch, or uncommitted changes.** If `git worktree
list` shows worktrees you didn't create, leave them alone. End every session with the main
   checkout back on the branch it started on (the active `release/vX.Y.Z`, never `main`).

### Base-green check (PRs must not be born red)

Before cutting a branch, merging the base into a PR branch, mass-retargeting PRs, or opening a
PR: check whether the base tip is green. The `Release-Green (continuous)` workflow
(`.github/workflows/nightly-release-green.yml`) publishes the verdict in a single deduplicated
issue titled `🔴 Release branch not green: <branch>` (label `base-red`). One call replaces any
local suite run for this purpose:

```bash
gh issue list --repo diegosouzapw/OmniRoute --state open \
  --search "Release branch not green: <base> in:title"
```

If the base is red: never treat the inherited failures as your branch's defect; never "fix" them
inside your feature branch (a base-red fix is its own freeze-gated `fix/release-vX.Y.Z-basereds`
PR); and if you must open a PR anyway, add `⚠️ base-red inherited: #<issue>` to the PR body so
reviewers and CI babysitters do not chase ghosts.

---

## Testing policy detail

The rules below are normative. The root contract keeps the test matrix table; the reasoning and
the decision tree live here.

**PR rule**: If you change production code in `src/`, `open-sse/`, `electron/`, or `bin/`, you must include or update tests in the same PR.

**Test layer preference**: unit first → integration (multi-module or DB state) → e2e (UI/workflow only). Encode bug reproductions as automated tests before or alongside the fix.

**Both test runners must pass**: `npm run test:unit` (Node native — most tests) AND `npm run test:vitest` (MCP server, autoCombo, cache) cover **non-overlapping files**. Both are wired in CI (jobs `test-unit` and `test-vitest`) and must be green before merging. A PR where only one suite passes may silently ship broken MCP tools or routing regressions.

**Bug fix / issue triage protocol (Hard Rule #18)**: Every fix for a reported issue must be validated by one of the following — no exceptions:

1. **TDD (preferred)** — write a failing test reproducing the bug → fix it → confirm the test passes. The test becomes the permanent regression guard. Touch only the files the test proves need changing; nothing more.
2. **Real-environment test (when TDD is not possible)** — deploy to the production VPS (`root@192.168.0.15`) and run a documented live test. Record the exact command + result in the PR description. Applies to: OAuth upstream flows, Cloudflare/WS upstream behavior, UI-only regressions, hardware-dependent behavior.
3. "It worked locally without a test" does not count. A fix without a test or a VPS validation record is not a fix — it is a guess.

Why this matters: fixing bug A while opening bug B is worse than not fixing at all. The TDD/VPS gate enforces surgical scope — you touch only what the failing test proves is broken. Examples where this paid off: #3090 (claude-web 403), #3113 (WS HTTP fallback), #3052 (heap-guard auto-calibration).

**Copilot coverage policy**: When a PR changes production code and coverage is below 60% (statements/lines/functions/branches), do not just report — add or update tests, rerun the coverage gate, then ask for confirmation. Include commands run, changed test files, and final coverage result in the PR report.

---

## Upstream contributions

This checkout is a fork of `diegosouzapw/OmniRoute`. Keep fork-only deployment and personal
automation changes out of upstream PRs.

Start upstream work from the active upstream default branch, not `main`:

```bash
git fetch upstream
git switch -c <branch-name> upstream/<default-branch>
```

Target that same release branch in the pull request. Stage only the intended files, run the
focused checks, and use a Conventional Commit message (for example, `docs: slim AGENTS.md`).

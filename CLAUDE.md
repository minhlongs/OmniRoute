# CLAUDE.md

@AGENTS.md

**All project rules live in [`AGENTS.md`](AGENTS.md)** — the single source of truth for every AI
assistant (architecture, conventions, testing, quality gates, git workflow, the 23 Hard Rules,
PII learnings). Read it in full; do not re-add project rules here. Everything below applies ONLY
to Claude Code — operational refinements of rules already defined in `AGENTS.md`.

## Context & retrieval — Claude Code specifics

The retrieval contract is `AGENTS.md` → "Context & retrieval discipline". Claude Code specifics:

- Prefer harness-native tools over shell dumps: `Grep` for symbols, `Glob` for paths, `Read` with
  `offset`/`limit` for ranges. Never `cat` a file or paste a whole file into context.
- When a codebase-memory MCP index is attached, query it (semantic search / symbol lookup) before
  broad greps. Prefer the OmniRoute MCP server's read-only retrieval tools over shell dumps — never
  invent tool names; inspect the connected server's live tool list.
- After `/compact`, a resume or a fork, re-read only the section you need. `AGENTS.md` is capped at
  30 KB by `scripts/check/check-agent-rules.mjs`; do not re-read the whole contract "to be safe".
- Never load whole: `CHANGELOG.md`, `README.md`, `docs/i18n/**`, `docs/openapi.yaml`,
  `package-lock.json`, `llm.txt`. `.claudeignore` lists the trees excluded from retrieval.

## Worktree isolation — Claude Code specifics

Full protocol: `AGENTS.md` → Git Workflow → "Worktree isolation".

- Confirm the base branch with the operator via `AskUserQuestion` (Hard Rule #19) unless already told.
- Prefer the native `EnterWorktree` tool — it creates worktrees under `.claude/worktrees/` (the
  canonical path). Create it with the documented `git worktree add` command, then call
  `EnterWorktree` with its `path`.
- Never `ln -s` node_modules; hard-link with `cp -al` (Turbopack rejects out-of-root symlinks).

## Cross-session safety — Claude Code specifics

Hard Rules #19/#21/#22 govern parallel sessions. For this harness:

- **Replicate the `git stash` ban verbatim in the prompt of every subagent that touches git**
  (Agent tool / Workflow scripts) — subagents do not inherit this file, and the recorded recurrence
  came through a subagent.
- Before merging or pushing any PR you did not create _this_ session, run `git worktree list` and
  re-check `gh pr view <N> --json state,headRefOid` (Hard Rule #22b).
- End every session with the main checkout on the branch it started on.

## Superpowers / planning artifacts — path overrides

`_tasks/` convention: `AGENTS.md` → "Planning & Research Artifacts". Superpowers skills ship with
`docs/…` defaults — those are **overridden**: plans → `_tasks/superpowers/plans/`, specs →
`_tasks/superpowers/specs/`, research → `_tasks/research/`, hand-offs →
`_tasks/hands-off/<YYYY-MM-DD>_<branch>_v<versão>_sess-<id>/`. Commit them inside the `_tasks/`
repo (`git -C _tasks …`), never in the main repo.

## Scratch / temporary files — use `_artifacts/`, not `/tmp`

This project overrides the harness's default session scratchpad (`/tmp/claude-*/…`). Write
temporary/working files — exports, generated zips, one-off intermediate outputs, anything you'd
otherwise put in `/tmp` — to `_artifacts/` at the checkout root instead.

- `_artifacts/` is a root `_*` path: already gitignored (`AGENTS.md` → "Root `_*` paths"), lives
  on disk only, never tracked.
- Reason: keeping scratch output inside the project (vs `/tmp`) makes it trivial for the operator
  to find and delete everything temporary in one place, instead of hunting across ephemeral
  session-specific `/tmp` directories that vanish or accumulate untracked.
- Do **not** confuse this with `_tasks/` (Hard Rule #23, its own private git repo for durable
  plans/specs/research/hand-offs) — `_artifacts/` is for disposable working files only, nothing
  here needs to survive or be versioned.

## Base-green before opening PRs

Run the base-green check before cutting a branch or opening a PR (`AGENTS.md` → Git Workflow →
"Base-green check"; project skills reference `.agents/skills/_shared/base-green.md`). A PR opened
while the base tip is red must carry `⚠️ base-red inherited: #<issue>` in its body. To drain an
accumulated red state, use the `/sweep-reds` skill.

## User-level policy mirror (never edit `~/.claude` from a repo task)

The matching user-level policy is maintained by the **orchestrator** in `~/.claude/CLAUDE.md`, not
in this repo — repo sessions MUST NOT edit `~/.claude/**`. When the orchestrator applies it, the
user-level file should carry only cross-repo behaviour: retrieval-first (index/search, then a
targeted read), the ≤ 200-line read cap, "summarize, don't paste", read-only by default for MCP
tools, and a pointer that project rules come from each repo's `AGENTS.md`. Project rules (Hard
Rules, gates, worktree protocol) stay here.

#!/usr/bin/env node
/**
 * scripts/check/check-agent-rules.mjs
 *
 * Guards the agent contract: the root `AGENTS.md` must stay a *small* operative contract, and
 * the Hard Rules must survive any restructuring — either verbatim in the root file or
 * preserved in the linked deep-dive page that replaced a long section.
 *
 * Wired into `npm run check:agent-rules` (`check:docs-all`, `.husky/pre-commit`, `run-all-gates.mjs`):
 *   node scripts/check/check-agent-rules.mjs          # check + human summary
 *   node scripts/check/check-agent-rules.mjs --json   # machine-readable result
 *
 * Exit codes: 0 = ok, 1 = contract regression.
 *
 * What it enforces:
 *   1. Root AGENTS.md size budget (<= 30 KB) — progressive disclosure must not silently regrow.
 *   2. All 23 Hard Rules present in the root file, each with its normative anchors.
 *   3. The same 23 rules + anchors preserved in docs/architecture/HARD_RULES.md (full text).
 *   4. Every deep-dive linked from AGENTS.md exists and keeps its own key anchors
 *      (workflow, scenarios, runtime environment, PII learnings, resilience runtime state).
 *   5. The retrieval-discipline section (search-first, read caps, read-only MCP retrieval,
 *      summary preference, no whole-project reads) is present.
 *   6. `.claudeignore` exists, excludes generated/build/vendor trees, and never hides source.
 *   7. New pages stay indexed (docs/README.md + docs/<area>/meta.json), so progressive disclosure
 *      never strands a rule in an unlinked page.
 *   8. CLAUDE.md stays a lean assistant delta and points at AGENTS.md.
 *
 * Why a script: the 2026-11 token audit showed the root file at ~55 KB loaded every session.
 * Slimming it is only safe if a machine re-checks that no rule was dropped, and that the file
 * cannot silently grow back.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const AGENTS_MD = path.join(ROOT, "AGENTS.md");
const CLAUDE_MD = path.join(ROOT, "CLAUDE.md");
const CLAUDE_IGNORE = path.join(ROOT, ".claudeignore");

/** Root contract budget. 30 KiB leaves room for formatting while blocking a 55 KB relapse. */
const AGENTS_MD_MAX_BYTES = 30 * 1024;
const AGENTS_MD_NOTE_BYTES = 30_000;
const CLAUDE_MD_MAX_BYTES = 8 * 1024;

/** Linked deep-dive pages and the key anchors each one must keep. */
const DEEP_DIVES = [
  {
    path: "docs/architecture/HARD_RULES.md",
    label: "Hard Rules (full text + precedents)",
    anchors: ["## Hard Rules", "js/stack-trace-exposure", "Co-authored-by", "release-freeze"],
  },
  {
    path: "docs/architecture/AGENT_WORKFLOW.md",
    label: "Agent workflow & git protocol",
    anchors: [
      "Worktree isolation",
      "Base-green check",
      "Testing policy detail",
      "Upstream contributions",
      ".claude/worktrees/",
      "cp -al",
      "git worktree remove",
      "192.168.0.15",
    ],
  },
  {
    path: "docs/architecture/MODIFICATION_SCENARIOS.md",
    label: "Common modification scenarios",
    anchors: [
      "Adding a New Provider",
      "Adding a New API Route",
      "Adding a New DB Module",
      "Adding a New MCP Tool",
      "Adding a New A2A Skill",
      "Adding a New Cloud Agent",
      "Adding a New Embedded Service",
      "Adding a New Guardrail",
    ],
  },
  {
    path: "docs/architecture/RUNTIME_ENVIRONMENT.md",
    label: "Runtime environment & toolchain",
    anchors: ["bun:sqlite", "1.3.14", "engines.node", "check:pack-artifact"],
  },
  {
    path: "docs/security/PII_STREAM_LEARNINGS.md",
    label: "PII & stream sanitization learnings",
    anchors: ["ReDoS", "final snapshot", "resetDbInstance", "test.after"],
  },
  {
    path: "docs/architecture/RESILIENCE_GUIDE.md",
    label: "Resilience runtime state",
    anchors: [
      "Provider Circuit Breaker",
      "Connection Cooldown",
      "Model Lockout",
      "408, 500, 502, 503, 504",
      "HALF_OPEN",
      "credits_exhausted",
    ],
  },
];

/** Sections the root contract must keep (progressive disclosure may compress, not delete). */
const REQUIRED_ROOT_SECTIONS = [
  "Context & retrieval discipline",
  "Quick Start",
  "Architecture at a glance",
  "Repository map",
  "File placement",
  "Key Conventions",
  "Documentation accuracy",
  "Common modification scenarios",
  "Testing",
  "Review focus",
  "Git Workflow",
  "Worktree isolation",
  "Base-green check",
  "Upstream contributions",
  "Environment",
  "Quality gates",
  "Hard Rules",
  "Local development access",
];

/**
 * Normative anchors per Hard Rule. Each anchor must appear in the root contract AND in the
 * verbatim HARD_RULES.md archive, so a condensed rule cannot lose its obligation.
 */
const HARD_RULE_COUNT = 23;

const RULE_ANCHORS = {
  1: ["Never commit secrets"],
  2: ["localDb.ts"],
  3: ["eval()"],
  4: ["Never commit directly to `main`"],
  5: ["raw SQL"],
  6: ["SSE streams"],
  7: ["Zod"],
  8: ["Always include tests"],
  9: ["quality-baseline.json", "60%"],
  10: ["Husky", "--no-verify"],
  11: ["resolvePublicCred", "PUBLIC_CREDS"],
  12: ["buildErrorBody", "sanitizeErrorMessage", "err.stack"],
  13: ["exec()", "spawn()", "env"],
  14: ["CodeQL", "Secret-Scann"],
  15: ["isLocalOnlyPath", "/api/mcp/"],
  16: ["Co-Authored-By", "Generated with"],
  17: ["isLocalOnlyPath", "/api/services/"],
  18: ["TDD", "192.168.0.15"],
  19: [".claude/worktrees/", "worktree"],
  20: ["PII_REDACTION_ENABLED", "PII_RESPONSE_SANITIZATION", 'defaultValue: "false"'],
  21: ["release-freeze", "release/v", "baseRefName"],
  22: ["git stash", "worktree list"],
  23: ["INTOCÁVEL", "git -C _tasks", "check:tracked-artifacts"],
};

/** Retrieval-discipline contract: these concepts must stay in the root file. */
const RETRIEVAL_ANCHORS = [
  "codebase-memory",
  "read-only retrieval",
  "rg -n",
  "offset",
  "200 lines",
  "whole project",
  "summar",
];

/** Counts also asserted by scripts/check/check-docs-counts-sync.mjs — keep them in the root. */
const ROOT_COUNT_ANCHORS = ["352 LLM providers", "110 tools", "33 scopes"];

/** Paths that must remain readable/searchable; `.claudeignore` may not match them. */
const MUST_STAY_VISIBLE = [
  "src/app/api/v1",
  "src/lib/db/core.ts",
  "src/domain",
  "src/server/authz/routeGuard.ts",
  "src/shared/constants/providers.ts",
  "open-sse/handlers/chatCore.ts",
  "open-sse/translator",
  "open-sse/mcp-server",
  "bin/omniroute.mjs",
  "tests/unit",
  "scripts/check",
  "config/quality",
  "docs/README.md",
  "docs/architecture/RESILIENCE_GUIDE.md",
  "docs/security/PUBLIC_CREDS.md",
  ".github/workflows/ci.yml",
  "package.json",
  "AGENTS.md",
  "CLAUDE.md",
  ".claudeignore",
];

/** Generated/build/vendor trees that `.claudeignore` is expected to exclude. */
const EXPECTED_IGNORES = ["node_modules/", ".next/", "docs/i18n/", "coverage/", ".env"];

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function read(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

/** Extract the numbered top-level rules of a `## Hard Rules` section. */
export function extractHardRuleNumbers(markdown) {
  const start = markdown.indexOf("## Hard Rules");
  if (start === -1) return [];
  const rest = markdown.slice(start + "## Hard Rules".length);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^(\d{1,2})\. /gm)].map((m) => Number(m[1]));
}

/** Minimal gitignore matcher for the subset of patterns this repo's `.claudeignore` uses. */
export function ignorePatternMatches(pattern, target) {
  const normalized = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  const anchored = normalized.includes("/");
  const body = anchored ? `^${escaped}(/|$)` : `(^|/)${escaped}(/|$)`;
  return new RegExp(body).test(target);
}

function checkRulePreservation(rootText, archiveText) {
  const rootRules = extractHardRuleNumbers(rootText);
  const archiveRules = archiveText ? extractHardRuleNumbers(archiveText) : [];

  for (let n = 1; n <= HARD_RULE_COUNT; n++) {
    if (!rootRules.includes(n)) fail(`AGENTS.md is missing Hard Rule #${n}`);
    if (archiveText && !archiveRules.includes(n)) {
      fail(`docs/architecture/HARD_RULES.md is missing Hard Rule #${n} (full-text archive)`);
    }
  }
  for (const n of rootRules) {
    if (n < 1 || n > HARD_RULE_COUNT) {
      fail(`AGENTS.md has an unexpected Hard Rule number: #${n}`);
    }
  }
  for (const n of archiveRules) {
    if (n < 1 || n > HARD_RULE_COUNT) {
      fail(`HARD_RULES.md has an unexpected Hard Rule number: #${n}`);
    }
  }

  const rootFlat = rootText.replace(/\s+/g, " ");
  const archiveFlat = (archiveText ?? "").replace(/\s+/g, " ");
  for (const [rule, anchors] of Object.entries(RULE_ANCHORS)) {
    for (const anchor of anchors) {
      if (!rootFlat.includes(anchor.replace(/\s+/g, " "))) {
        fail(`Hard Rule #${rule} lost its anchor in AGENTS.md: "${anchor}"`);
      }
      if (archiveText && !archiveFlat.includes(anchor.replace(/\s+/g, " "))) {
        fail(`Hard Rule #${rule} lost its anchor in HARD_RULES.md: "${anchor}"`);
      }
    }
  }
}

function checkIgnoreList() {
  if (!fs.existsSync(CLAUDE_IGNORE)) {
    fail(".claudeignore is missing — retrieval hygiene depends on it");
    return;
  }
  const text = read(".claudeignore") ?? "";
  const patterns = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const expected of EXPECTED_IGNORES) {
    if (!patterns.some((pattern) => pattern === expected || pattern === `${expected}*`)) {
      fail(`.claudeignore no longer excludes "${expected}"`);
    }
  }

  const negated = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const positive = patterns.filter((p) => !p.startsWith("!"));

  for (const target of MUST_STAY_VISIBLE) {
    const hiding = positive.find((pattern) => {
      if (!ignorePatternMatches(pattern, target)) return false;
      // A later negation may re-include it (e.g. !.env.example).
      return !negated.some((pattern2) => ignorePatternMatches(pattern2, target));
    });
    if (hiding) {
      fail(`.claudeignore hides required source: "${target}" matches "${hiding}"`);
    }
  }
}

function checkIndexing() {
  const readme = read("docs/README.md") ?? "";
  for (const doc of DEEP_DIVES) {
    const fileName = path.basename(doc.path);
    if (!readme.includes(fileName)) {
      fail(`docs/README.md does not index ${doc.path}`);
    }
  }

  for (const [metaPath, page] of [
    ["docs/architecture/meta.json", "HARD_RULES"],
    ["docs/architecture/meta.json", "AGENT_WORKFLOW"],
    ["docs/architecture/meta.json", "MODIFICATION_SCENARIOS"],
    ["docs/architecture/meta.json", "RUNTIME_ENVIRONMENT"],
    ["docs/security/meta.json", "PII_STREAM_LEARNINGS"],
  ]) {
    const raw = read(metaPath);
    if (!raw) continue;
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      fail(`${metaPath} is not valid JSON`);
      continue;
    }
    if (!Array.isArray(meta.pages) || !meta.pages.includes(page)) {
      fail(`${metaPath} does not list "${page}"`);
    }
  }
}

function checkRetrievalDiscipline(rootText) {
  if (!rootText.includes("## Context & retrieval discipline")) {
    fail('AGENTS.md is missing the "Context & retrieval discipline" section');
  }
  for (const anchor of RETRIEVAL_ANCHORS) {
    if (!rootText.includes(anchor)) {
      fail(`retrieval discipline lost its anchor: "${anchor}"`);
    }
  }
  if (!rootText.includes("docs/frameworks/MCP-SERVER.md")) {
    fail("retrieval discipline no longer points at the MCP server documentation");
  }
  const rootFlat = rootText.replace(/\s+/g, " ");
  for (const countAnchor of ROOT_COUNT_ANCHORS) {
    if (!rootFlat.includes(countAnchor)) {
      fail(`AGENTS.md lost the counted fact "${countAnchor}" (check:docs-counts depends on it)`);
    }
  }
}

function run() {
  const agentsText = read("AGENTS.md");
  if (!agentsText) {
    return { ok: false, failures: ["AGENTS.md is missing"], notes: [] };
  }
  const rootBytes = fs.statSync(AGENTS_MD).size;
  if (rootBytes > AGENTS_MD_MAX_BYTES) {
    fail(
      `AGENTS.md is ${rootBytes} bytes — over the ${AGENTS_MD_MAX_BYTES}-byte contract budget. ` +
        "Move detail into a linked doc (docs/architecture/) instead of growing the root file."
    );
  } else if (rootBytes > AGENTS_MD_NOTE_BYTES) {
    notes.push(
      `AGENTS.md is ${rootBytes} bytes — ${AGENTS_MD_MAX_BYTES - rootBytes} bytes of headroom left.`
    );
  }

  for (const section of REQUIRED_ROOT_SECTIONS) {
    if (!agentsText.toLowerCase().includes(section.toLowerCase())) {
      fail(`AGENTS.md lost its "${section}" section`);
    }
  }

  const archiveText = read("docs/architecture/HARD_RULES.md");
  if (!archiveText) fail("docs/architecture/HARD_RULES.md is missing (full-text rule archive)");

  checkRulePreservation(agentsText, archiveText);

  for (const doc of DEEP_DIVES) {
    const text = read(doc.path);
    if (!text) {
      fail(`${doc.path} is missing — AGENTS.md links to it as "${doc.label}"`);
      continue;
    }
    for (const anchor of doc.anchors) {
      if (!text.includes(anchor)) {
        fail(`${doc.path} lost its anchor: "${anchor}"`);
      }
    }
  }

  checkRetrievalDiscipline(agentsText);
  checkIgnoreList();
  checkIndexing();

  const claudeText = read("CLAUDE.md");
  if (!claudeText) {
    fail("CLAUDE.md is missing");
  } else {
    const claudeBytes = fs.statSync(CLAUDE_MD).size;
    if (claudeBytes > CLAUDE_MD_MAX_BYTES) {
      fail(`CLAUDE.md is ${claudeBytes} bytes — keep it under ${CLAUDE_MD_MAX_BYTES} bytes`);
    }
    if (!claudeText.includes("@AGENTS.md") || !claudeText.includes("AGENTS.md")) {
      fail("CLAUDE.md no longer points at AGENTS.md as the single source of truth");
    }
    if (!claudeText.includes("retrieval")) {
      fail("CLAUDE.md lost its Claude-specific retrieval guidance");
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    rootBytes,
    claudeBytes: fs.statSync(CLAUDE_MD).size,
  };
}

const result = run();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("[agent-rules] root contract: AGENTS.md " + result.rootBytes + " bytes");
  console.log("[agent-rules] assistant delta: CLAUDE.md " + result.claudeBytes + " bytes");
  console.log(
    `[agent-rules] ${HARD_RULE_COUNT} Hard Rules: root + docs/architecture/HARD_RULES.md`
  );
  if (result.notes.length > 0) {
    for (const note of result.notes) console.log(`[agent-rules] note: ${note}`);
  }
  if (result.ok) {
    console.log("[agent-rules] PASS — contract, retrieval discipline and ignore list intact");
  } else {
    for (const failure of result.failures) console.error(`[agent-rules] FAIL — ${failure}`);
  }
}

process.exit(result.ok ? 0 : 1);

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyRtkCompression } from "../../../open-sse/services/compression/index.ts";

const VERBOSE_GIT_STATUS = [
  "On branch main",
  "Your branch is up to date with 'origin/main'.",
  "",
  "Changes not staged for commit:",
  '  (use "git add <file>..." to update what will be committed)',
  '  (use "git restore <file>..." to discard changes in working directory)',
  "\tmodified:   src/app.ts",
  "\tmodified:   src/index.ts",
  "",
  'no changes added to commit (use "git add" and/or "git commit -a")',
].join("\n");

describe("RTK shell tool detection expansion", () => {
  it("detects Anthropic official bash_20241022 tool name and compresses output", () => {
    const body = {
      messages: [
        { role: "user", content: "run git status" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_bash_001",
              name: "bash_20241022",
              input: { command: "git status" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_bash_001",
              content: VERBOSE_GIT_STATUS,
            },
          ],
        },
      ],
    };

    const res = applyRtkCompression(body, {
      config: { enabled: true, intensity: "standard" },
    });

    assert.equal(res.compressed, true);
    assert.ok(res.stats?.techniquesUsed?.includes("rtk-filter"));
    assert.ok(res.stats?.rulesApplied?.includes("git-status:strip"));
  });

  it("detects Google/Antigravity run_command with CommandLine argument", () => {
    const body = {
      messages: [
        { role: "user", content: "check status" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_agy_001",
              name: "run_command",
              input: { CommandLine: "git status" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_agy_001",
              content: VERBOSE_GIT_STATUS,
            },
          ],
        },
      ],
    };

    const res = applyRtkCompression(body, {
      config: { enabled: true, intensity: "standard" },
    });

    assert.equal(res.compressed, true);
    assert.ok(res.stats?.techniquesUsed?.includes("rtk-filter"));
    assert.ok(res.stats?.rulesApplied?.includes("git-status:strip"));
  });

  it("detects OpenAI-shape tool call with command_line argument", () => {
    const body = {
      messages: [
        { role: "user", content: "check status" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_openai_001",
              type: "function",
              function: {
                name: "execute_command",
                arguments: JSON.stringify({ command_line: "git status" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_openai_001",
          content: VERBOSE_GIT_STATUS,
        },
      ],
    };

    const res = applyRtkCompression(body, {
      config: { enabled: true, intensity: "standard" },
    });

    assert.equal(res.compressed, true);
    assert.ok(res.stats?.techniquesUsed?.includes("rtk-filter"));
  });

  it("filters out pseudo-stage names from enabledFilters so built-in filters remain active", () => {
    const body = {
      messages: [
        { role: "user", content: "check status" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_002",
              name: "bash",
              input: { command: "git status" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_002",
              content: VERBOSE_GIT_STATUS,
            },
          ],
        },
      ],
    };

    // Operator accidentally set pseudo-stage names in enabledFilters
    const res = applyRtkCompression(body, {
      config: {
        enabled: true,
        intensity: "standard",
        enabledFilters: ["dedup", "line-filter", "smart-truncate", "grouping"],
      },
    });

    assert.equal(res.compressed, true);
    assert.ok(res.stats?.techniquesUsed?.includes("rtk-filter"));
    assert.ok(res.stats?.rulesApplied?.includes("git-status:strip"));
  });
});

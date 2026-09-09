import test from "node:test";
import assert from "node:assert/strict";
import { readLifecycleEngine } from "../../../open-sse/services/compression/engines/readLifecycle/index.ts";

test("read-lifecycle: Anthropic tool shapes — collapses earlier read when re-read later", () => {
  const messages = [
    {
      role: "user",
      content: "Can you check src/index.ts?",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_read_1",
          name: "read_file",
          input: { path: "src/index.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_read_1",
          content: "export const version = '1.0.0';\n// 50 lines of initial code...",
        },
      ],
    },
    {
      role: "assistant",
      content: "Let me check again with the updated view.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_read_2",
          name: "read_file",
          input: { path: "src/index.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_read_2",
          content: "export const version = '1.1.0';\n// 50 lines of fresh code...",
        },
      ],
    },
  ];

  const result = readLifecycleEngine.apply({ messages }, { stepConfig: { enabled: true } });
  assert.equal(result.compressed, true);
  const outMsgs = (result.body as { messages: any[] }).messages;

  // Earlier read must be collapsed to stub
  const earlierBlock = outMsgs[2].content[0];
  assert.ok(earlierBlock.content.includes("read superseded"));
  assert.ok(earlierBlock.content.includes("src/index.ts"));

  // Later read must remain completely intact
  const laterBlock = outMsgs[5].content[0];
  assert.equal(laterBlock.content, "export const version = '1.1.0';\n// 50 lines of fresh code...");
});

test("read-lifecycle: Antigravity tool shapes — view_file with AbsolutePath & replace_file_content with TargetFile", () => {
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_view_1",
          type: "function",
          function: {
            name: "view_file",
            arguments: JSON.stringify({ AbsolutePath: "/workspace/server.ts" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_view_1",
      content: "console.log('original server code 2000 chars');",
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_replace_1",
          type: "function",
          function: {
            name: "replace_file_content",
            arguments: JSON.stringify({
              TargetFile: "/workspace/server.ts",
              Instruction: "Fix logging",
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_replace_1",
      content: "Replaced line 1",
    },
  ];

  const result = readLifecycleEngine.apply({ messages }, { stepConfig: { enabled: true } });
  assert.equal(result.compressed, true);
  const outMsgs = (result.body as { messages: any[] }).messages;

  // The earlier view of server.ts was superseded by replace_file_content
  assert.ok(outMsgs[1].content.includes("read superseded"));
  assert.ok(outMsgs[1].content.includes("/workspace/server.ts"));

  // The tool result of replace_file_content is unchanged
  assert.equal(outMsgs[3].content, "Replaced line 1");
});

test("read-lifecycle: preserves un-superseded reads of other files", () => {
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_view_a",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filePath: "fileA.ts" }),
          },
        },
        {
          id: "call_view_b",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filePath: "fileB.ts" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_view_a",
      content: "file A content",
    },
    {
      role: "tool",
      tool_call_id: "call_view_b",
      content: "file B content",
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_edit_a",
          type: "function",
          function: {
            name: "edit_file",
            arguments: JSON.stringify({ filePath: "fileA.ts" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_edit_a",
      content: "file A edited",
    },
  ];

  const result = readLifecycleEngine.apply({ messages }, { stepConfig: {} });
  assert.equal(result.compressed, true);
  const outMsgs = (result.body as { messages: any[] }).messages;

  // fileA view was superseded by edit_file -> collapsed
  assert.ok(outMsgs[1].content.includes("read superseded"));
  // fileB view was NOT modified or re-read -> kept 100% intact
  assert.equal(outMsgs[2].content, "file B content");
});

test("read-lifecycle: default enabled in stacked pipeline when enabled !== false", () => {
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "cat", arguments: JSON.stringify({ file: "app.py" }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "print('hello')",
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: { name: "cat", arguments: JSON.stringify({ file: "app.py" }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_2",
      content: "print('hello world')",
    },
  ];

  // Notice: empty stepConfig ({}) should default to running!
  const result = readLifecycleEngine.apply({ messages }, { stepConfig: {} });
  assert.equal(result.compressed, true);
  const outMsgs = (result.body as { messages: any[] }).messages;
  assert.ok(outMsgs[1].content.includes("read superseded"));
  assert.equal(outMsgs[3].content, "print('hello world')");
});

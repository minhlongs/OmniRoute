import test from "node:test";
import assert from "node:assert/strict";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.ts";
import {
  clearGeminiWebSessionCache,
  GEMINI_WEB_MODEL_SELECTORS,
  resolveGeminiWebModelSelector,
  shouldUseGeminiWebDirectHttp,
} from "../../open-sse/executors/gemini-web/streamGenerateClient.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import {
  startGeminiWebMockServer,
  type GeminiWebMockServer,
} from "../mocks/geminiWebMockServer.ts";

let mockServer: GeminiWebMockServer;

test.before(async () => {
  mockServer = await startGeminiWebMockServer("cumulative_ok");
});

test.after(async () => {
  await mockServer.close();
});

test.beforeEach(() => {
  mockServer.requests.length = 0;
  mockServer.setScenario("cumulative_ok");
  clearGeminiWebSessionCache();
});

test("gemini-web registry entry enables passthroughModels for gemini-4-argon and gemini-3-ultra routing", () => {
  assert.equal(REGISTRY["gemini-web"].passthroughModels, true);
});

test("shouldUseGeminiWebDirectHttp activates for argon/ultra models and explicit http transport while keeping legacy default on Playwright", () => {
  assert.equal(shouldUseGeminiWebDirectHttp("gemini-4-argon", { apiKey: "c=1" }), true);
  assert.equal(shouldUseGeminiWebDirectHttp("gemini-3-ultra", { apiKey: "c=1" }), true);
  assert.equal(shouldUseGeminiWebDirectHttp("gemini-3.1-pro-http", { apiKey: "c=1" }), true);
  assert.equal(
    shouldUseGeminiWebDirectHttp("gemini-3.1-pro", {
      apiKey: "c=1",
      providerSpecificData: { transport: "http" },
    }),
    true
  );
  assert.equal(shouldUseGeminiWebDirectHttp("gemini-3.1-pro", { apiKey: "c=1" }), false);
  assert.equal(
    shouldUseGeminiWebDirectHttp("gemini-4-argon", {
      apiKey: "c=1",
      providerSpecificData: { transport: "playwright" },
    }),
    false
  );
});

test("Direct HTTP bootstraps SNlM0e token from /app and selects gemini-4-argon model header and category", async () => {
  const executor = new GeminiWebExecutor();
  const result = await executor.execute({
    model: "gemini-4-argon",
    body: {
      messages: [{ role: "user", content: "Explain Argon tier routing" }],
      stream: false,
    },
    stream: false,
    credentials: {
      apiKey: "__Secure-1PSID=ultra_acc_1; __Secure-1PSIDTS=ts_1",
      providerSpecificData: { endpointUrl: mockServer.baseUrl },
    },
    signal: AbortSignal.timeout(5000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as {
    model: string;
    choices: Array<{ message: { content: string }; finish_reason: string }>;
  };
  assert.equal(json.model, "gemini-4-argon");
  assert.equal(json.choices[0].message.content, "Hello, world!");
  assert.equal(mockServer.requests.length, 1);

  const req = mockServer.requests[0];
  assert.equal(
    req.headers["x-goog-ext-525001261-jspb"],
    GEMINI_WEB_MODEL_SELECTORS["gemini-4-argon"].header
  );
  assert.equal(req.modelCategory, 1);
  assert.match(req.url, /bl=boq_mock_2026/);
  assert.match(req.url, /f\.sid=-999/);
  assert.match(req.rawBody, /at=mock_at%3A123/);
});

test("Direct HTTP supports custom modelHeader and modelCategory overrides in providerSpecificData", () => {
  const selector = resolveGeminiWebModelSelector("gemini-4-argon", {
    modelHeader: '[1,null,null,null,"custom_argon_id"]',
    modelCategory: 9,
  });
  assert.equal(selector.header, '[1,null,null,null,"custom_argon_id"]');
  assert.equal(selector.category, 9);
});

test("Direct HTTP streams incremental SSE deltas and reasoning_content for gemini-4-argon", async () => {
  mockServer.setScenario("reasoning_and_text");
  const executor = new GeminiWebExecutor();
  const result = await executor.execute({
    model: "gemini-4-argon",
    body: {
      messages: [{ role: "user", content: "Solve this step by step" }],
      stream: true,
    },
    stream: true,
    credentials: {
      apiKey: "__Secure-1PSID=ultra_acc_2; __Secure-1PSIDTS=ts_2",
      providerSpecificData: { endpointUrl: mockServer.baseUrl },
    },
    signal: AbortSignal.timeout(5000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("Content-Type"), "text/event-stream");
  const rawSse = await result.response.text();
  const dataPayloads = rawSse
    .split("\n\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));

  assert.equal(dataPayloads[dataPayloads.length - 1], "[DONE]");
  const chunks = dataPayloads.slice(0, -1).map(
    (payload) =>
      JSON.parse(payload) as {
        choices: Array<{
          delta: { role?: string; content?: string; reasoning_content?: string };
          finish_reason: string | null;
        }>;
      }
  );

  const combinedText = chunks.map((c) => c.choices[0].delta.content || "").join("");
  const combinedThought = chunks.map((c) => c.choices[0].delta.reasoning_content || "").join("");
  assert.equal(combinedText, "Final answer.");
  assert.equal(combinedThought, "Step 1: analyze. Step 2: conclude.");
});

test("Direct HTTP persists rotated __Secure-1PSIDTS cookie via onCredentialsRefreshed (#7676)", async () => {
  mockServer.setScenario("rotated_cookie");
  let refreshedApiKey = "";
  const executor = new GeminiWebExecutor();

  const result = await executor.execute({
    model: "gemini-3-ultra",
    body: {
      messages: [{ role: "user", content: "Ping" }],
      stream: false,
    },
    stream: false,
    credentials: {
      apiKey: "__Secure-1PSID=ultra_acc_3; __Secure-1PSIDTS=old_ts_000",
      providerSpecificData: { endpointUrl: mockServer.baseUrl },
    },
    signal: AbortSignal.timeout(5000),
    log: null,
    onCredentialsRefreshed: async (updated) => {
      refreshedApiKey = String((updated as Record<string, unknown>).apiKey || "");
    },
  });

  assert.equal(result.response.status, 200);
  assert.match(refreshedApiKey, /__Secure-1PSID=ultra_acc_3/);
  assert.match(refreshedApiKey, /__Secure-1PSIDTS=rotated_ts_val_999/);
});

test("Direct HTTP supports XML tool-call emulation (#7286) on gemini-4-argon", async () => {
  mockServer.setScenario("tool_call_xml");
  const executor = new GeminiWebExecutor();
  const result = await executor.execute({
    model: "gemini-4-argon",
    body: {
      messages: [{ role: "user", content: "What is the weather in Hanoi?" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    },
    stream: false,
    credentials: {
      apiKey: "__Secure-1PSID=ultra_acc_4; __Secure-1PSIDTS=ts_4",
      providerSpecificData: { endpointUrl: mockServer.baseUrl },
    },
    signal: AbortSignal.timeout(5000),
    log: null,
  });

  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as {
    choices: Array<{
      finish_reason: string;
      message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
    }>;
  };
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  assert.equal(json.choices[0].message.tool_calls?.[0].function.name, "get_weather");
});

test("Direct HTTP returns sanitized 403 when upstream redirects to account-chooser for combo fallback", async () => {
  mockServer.setScenario("account_chooser_403");
  const executor = new GeminiWebExecutor();
  const result = await executor.execute({
    model: "gemini-3.1-pro-http",
    body: {
      messages: [{ role: "user", content: "Hello Pro fallback" }],
      stream: false,
    },
    stream: false,
    credentials: {
      apiKey: "__Secure-1PSID=pro_acc_1; __Secure-1PSIDTS=ts_pro",
      providerSpecificData: { endpointUrl: mockServer.baseUrl },
    },
    signal: AbortSignal.timeout(5000),
    log: null,
  });

  assert.equal(result.response.status, 403);
  const body = (await result.response.json()) as { error: { message: string } };
  assert.match(body.error.message, /unauthorized|expired/i);
  assert.equal(body.error.message.includes("at /"), false);
});

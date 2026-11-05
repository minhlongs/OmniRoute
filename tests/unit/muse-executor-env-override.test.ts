import test from "node:test";
import assert from "node:assert/strict";

const API_BASE = "http://127.0.0.1:22199/mock/v1";
const GRAPHQL_URL = "http://127.0.0.1:22199/mock/graphql";

// The executors read these at module load, so set them before the dynamic import.
process.env.MUSE_API_BASE = API_BASE;
process.env.MUSE_WEB_GRAPHQL_URL = GRAPHQL_URL;

const { MuseExecutor } = await import("@omniroute/open-sse/executors/muse.ts");
const { MuseWebExecutor } = await import("@omniroute/open-sse/executors/muse-web.ts");

test("muse executor targets MUSE_API_BASE instead of the public endpoint", () => {
  const executor = new MuseExecutor();
  assert.equal(executor.config.baseUrl, API_BASE);
});

test("muse executor sends the API key and keeps the upstream payload", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({ id: "chatcmpl-muse", choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const executor = new MuseExecutor();
    const result = await executor.execute({
      model: "muse-spark-1.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "sk-muse-test" },
    } as never);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API_BASE}/chat/completions`);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-muse-test");
    assert.equal(result.url, `${API_BASE}/chat/completions`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("muse executor fails closed without an API key", async () => {
  const executor = new MuseExecutor();
  const result = await executor.execute({
    model: "muse-spark-1.3",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {},
  } as never);

  assert.equal(result.response.status, 401);
});

test("muse web executor targets MUSE_WEB_GRAPHQL_URL", () => {
  const executor = new MuseWebExecutor();
  assert.equal(executor.config.baseUrl, GRAPHQL_URL);
});

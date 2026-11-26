import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-gpt6-search-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { getModelsByProviderId } = await import("../../open-sse/config/providerModels.ts");
const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
const { splitCodexReasoningSuffix } =
  await import("../../open-sse/executors/codex/reasoningSuffix.ts");
const { resolveCodexCatalogAppVersion } =
  await import("../../src/shared/services/codexCatalogRevalidation.ts");
const searchRoute = await import("../../src/app/api/v1/search/route.ts");
const { executeWebSearch } = await import("../../src/lib/search/executeWebSearch.ts");
const webFetchRoute = await import("../../src/app/api/v1/web/fetch/route.ts");
const { executeWebFetch } = await import("../../src/lib/skills/webFetchExecution.ts");
const { runNonBlockingPeriodicTruncate } = await import("../../src/lib/db/walMaintenance.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
  delete process.env.OMNIROUTE_PRIMARY_FREE_SEARCH_PROVIDER;
  delete process.env.OMNIROUTE_SEARCH_FALLBACK_UNCONFIGURED_PROVIDER;
  delete process.env.OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.OMNIROUTE_PRIMARY_FREE_SEARCH_PROVIDER;
  delete process.env.OMNIROUTE_SEARCH_FALLBACK_UNCONFIGURED_PROVIDER;
  delete process.env.OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK;
});

test("Codex catalog exposes GPT-6, GPT-6.1, and GPT-6.2 model families and effort aliases", () => {
  const models = getModelsByProviderId("codex");
  const ids = new Set(models.map((m) => m.id));

  for (const requiredId of [
    "gpt-6.2-sol",
    "gpt-6.2-sol-ultra",
    "gpt-6.2-sol-xhigh",
    "gpt-6.2-astra",
    "gpt-6.2-astra-ultra",
    "gpt-6.1-sol",
    "gpt-6.1-sol-ultra",
    "gpt-6.1-sol-xhigh",
    "gpt-6.1-terra",
    "gpt-6.1-terra-ultra",
    "gpt-6-astra",
    "gpt-6-astra-ultra",
    "gpt-6-sol",
    "gpt-6-sol-ultra",
    "gpt-6-luna",
    "gpt-6-luna-max",
  ]) {
    assert.ok(ids.has(requiredId), `codex catalog must include ${requiredId}`);
  }
  assert.equal(ids.has("gpt-6-luna-ultra"), false, "gpt-6-luna caps at max, not ultra");
});

test("Codex reasoning suffix and effort clamping preserve ultra/max on GPT-6.1 and GPT-6.2", () => {
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6.1-sol-ultra"), {
    baseModel: "gpt-6.1-sol",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6.2-astra-max"), {
    baseModel: "gpt-6.2-astra",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-ultra"), {
    baseModel: "gpt-6-luna-ultra",
    effort: null,
  });

  const executor = new CodexExecutor();
  const transformed = executor.transformRequest(
    "gpt-6.1-sol-ultra",
    {
      model: "gpt-6.1-sol-ultra",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      stream: true,
    },
    true,
    { providerSpecificData: {} }
  ) as { model?: string; reasoning?: { effort?: string } };

  assert.equal(transformed.model, "gpt-6.1-sol");
  assert.equal(
    transformed.reasoning?.effort,
    "max",
    "ultra maps to wire effort max without xhigh clamp"
  );
});

test("resolveCodexCatalogAppVersion honors NEXT_DIST_DIR BUILD_ID for blue-green deployments", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-next-dist-"));
  try {
    const distDir = path.join(tmpRoot, ".build", "next14");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "BUILD_ID"), "build-next14-xyz\n", "utf8");
    fs.writeFileSync(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ version: "3.8.51" }),
      "utf8"
    );

    const version = resolveCodexCatalogAppVersion(
      { NEXT_DIST_DIR: ".build/next14" } as unknown as NodeJS.ProcessEnv,
      { runtimeRoot: tmpRoot }
    );
    assert.equal(version, "next:build-next14-xyz");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("v1 search fails over from duckduckgo-free 502 to keyless anysearch-search instead of context7", async () => {
  const originalFetch = globalThis.fetch;
  const calledHosts: string[] = [];

  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    calledHosts.push(parsed.hostname);
    if (parsed.hostname === "lite.duckduckgo.com") {
      return new Response("Forbidden", { status: 403 });
    }
    if (parsed.hostname === "api.anysearch.com") {
      return new Response(
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            results: [
              {
                title: "Cloudflare Workers Limits",
                url: "https://developers.cloudflare.com/workers/platform/limits/",
                snippet: "CPU and memory limits",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected search upstream host: ${parsed.hostname}`);
  }) as typeof fetch;

  try {
    const res = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "cloudflare workers limits", search_type: "web" }),
      })
    );
    const body = (await res.json()) as { provider?: string; results?: unknown[]; content?: string };
    assert.equal(res.status, 200);
    assert.equal(body.provider, "anysearch-search");
    assert.equal(body.results.length, 1);
    assert.ok(
      !calledHosts.includes("context7.com"),
      "context7 must never hijack generic web search"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search & executeWebSearch support primary anysearch-search and unconfigured-provider fallback", async () => {
  process.env.OMNIROUTE_PRIMARY_FREE_SEARCH_PROVIDER = "anysearch-search";
  process.env.OMNIROUTE_SEARCH_FALLBACK_UNCONFIGURED_PROVIDER = "true";

  const originalFetch = globalThis.fetch;
  const calledHosts: string[] = [];

  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    calledHosts.push(parsed.hostname);
    if (parsed.hostname === "api.anysearch.com") {
      return new Response(
        JSON.stringify({
          code: 0,
          message: "success",
          data: {
            results: [
              {
                title: "AnySearch Direct Hit",
                url: "https://example.com/anysearch-direct",
                snippet: "Fast keyless search",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected host: ${parsed.hostname}`);
  }) as typeof fetch;

  try {
    const res = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "unconfigured tavily fallback query",
          provider: "tavily-search",
          search_type: "web",
        }),
      })
    );
    const body = (await res.json()) as { provider?: string; results?: unknown[]; content?: string };
    assert.equal(res.status, 200);
    assert.equal(body.provider, "anysearch-search");
    assert.deepEqual(calledHosts, ["api.anysearch.com"]);

    const skillRes = await executeWebSearch({
      query: "unconfigured serper fallback query",
      provider: "serper-search",
      search_type: "web",
    });
    assert.equal(skillRes.data.provider, "anysearch-search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webFetch supports keyless anysearch-search on skill auto-select and opt-in route fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, "api.anysearch.com");
    return new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          url: "https://example.com",
          title: "Example",
          content: "# Extracted Markdown",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    // 1. Builtin skill executeWebFetch auto-selects keyless anysearch-search out-of-the-box
    const skillFetched = await executeWebFetch({ url: "https://example.com" });
    assert.equal(skillFetched.provider, "anysearch-search");
    assert.equal(skillFetched.content, "# Extracted Markdown");

    // 2. Explicit provider=anysearch-search on /v1/web/fetch works keyless without env flag
    const explicitRes = await webFetchRoute.POST(
      new Request("http://localhost/api/v1/web/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", provider: "anysearch-search" }),
      })
    );
    assert.equal(explicitRes.status, 200);

    // 3. Opt-in OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK=true rescues unconfigured jina-reader & auto-select
    process.env.OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK = "true";
    const fallbackRes = await webFetchRoute.POST(
      new Request("http://localhost/api/v1/web/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", provider: "jina-reader" }),
      })
    );
    const fallbackJson = (await fallbackRes.json()) as { provider?: string; content?: string };
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackJson.provider, "anysearch-search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runNonBlockingPeriodicTruncate bounds busy_timeout during TRUNCATE and always restores it", () => {
  const pragmas: string[] = [];
  const fakeAdapter = {
    pragma(sql: string) {
      pragmas.push(sql);
      if (sql === "busy_timeout") return [{ timeout: 5000 }];
      if (sql === "wal_checkpoint(TRUNCATE)") return [{ busy: 1, log: 42, checkpointed: 10 }];
      return [];
    },
  };

  const outcome = runNonBlockingPeriodicTruncate(fakeAdapter as never, 50, 2000);
  assert.equal(outcome.busy, true);
  assert.equal(outcome.logFrames, 42);
  assert.deepEqual(pragmas, [
    "busy_timeout",
    "busy_timeout = 50",
    "wal_checkpoint(TRUNCATE)",
    "busy_timeout = 5000",
  ]);
});

test("configured self-hosted searxng-search wins auto-select over keyless free search providers", async () => {
  await providersDb.createProviderConnection({
    provider: "searxng-search",
    authType: "none",
    name: "private-searxng",
    apiKey: null,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: "http://127.0.0.1:9095/search" },
  });

  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calledUrls.push(String(url));
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Private SearXNG Hit",
            url: "https://intranet.example/doc",
            content: "Private instance result",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const res = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "private searxng priority", search_type: "web" }),
      })
    );
    const body = (await res.json()) as { provider?: string; results?: unknown[]; content?: string };
    assert.equal(res.status, 200);
    assert.equal(body.provider, "searxng-search");
    assert.ok(calledUrls[0].startsWith("http://127.0.0.1:9095/search"));

    const skillRes = await executeWebSearch({
      query: "private searxng skill priority",
      search_type: "web",
    });
    assert.equal(skillRes.data.provider, "searxng-search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keyless anysearch-search 403 fails over symmetrically to duckduckgo-free", async () => {
  process.env.OMNIROUTE_PRIMARY_FREE_SEARCH_PROVIDER = "anysearch";
  const originalFetch = globalThis.fetch;
  const calledHosts: string[] = [];

  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    calledHosts.push(parsed.hostname);
    if (parsed.hostname === "api.anysearch.com") {
      return new Response("Forbidden", { status: 403 });
    }
    if (parsed.hostname === "lite.duckduckgo.com") {
      return new Response(
        `<html><body><a href="https://example.com/ddg-sym" class=result-link>DDG Symmetric Hit</a><td class=result-snippet>Recovered from AnySearch 403</td></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }
    throw new Error(`Unexpected host: ${parsed.hostname}`);
  }) as typeof fetch;

  try {
    const res = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "symmetric keyless failover", search_type: "web" }),
      })
    );
    const body = (await res.json()) as { provider?: string; results?: unknown[]; content?: string };
    assert.equal(res.status, 200);
    assert.equal(body.provider, "duckduckgo-free");
    assert.deepEqual(calledHosts, ["api.anysearch.com", "lite.duckduckgo.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings.blockedProviders blocks keyless anysearch-search across search and web-fetch", async () => {
  await settingsDb.updateSettings({ blockedProviders: ["anysearch-search"] });

  await assert.rejects(
    () => executeWebFetch({ url: "https://example.com" }),
    (err: { statusCode?: number; message?: string }) =>
      err?.statusCode === 400 && /No credentials configured/.test(err.message ?? "")
  );
  await assert.rejects(
    () => executeWebFetch({ url: "https://example.com", provider: "anysearch-search" }),
    (err: { statusCode?: number; message?: string }) =>
      err?.statusCode === 403 && /blocked by security policy/.test(err.message ?? "")
  );
  await assert.rejects(
    () => executeWebSearch({ query: "blocked test", provider: "anysearch" }),
    (err: { statusCode?: number; message?: string }) =>
      err?.statusCode === 403 && /blocked by security policy/.test(err.message ?? "")
  );

  const wfRes = await webFetchRoute.POST(
    new Request("http://localhost/api/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", provider: "anysearch-search" }),
    })
  );
  assert.equal(wfRes.status, 403);
});

test("OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK rescues preflight rate-limited web-fetch pool", async () => {
  process.env.OMNIROUTE_WEB_FETCH_ANONYMOUS_FALLBACK = "true";
  await providersDb.createProviderConnection({
    provider: "firecrawl",
    authType: "apikey",
    name: "fc-rl",
    apiKey: "fc-key",
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    assert.equal(new URL(String(url)).hostname, "api.anysearch.com");
    return new Response(
      JSON.stringify({
        code: 0,
        data: { url: "https://example.com", content: "# Rescued Content" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const res = await webFetchRoute.POST(
      new Request("http://localhost/api/v1/web/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      })
    );
    const body = (await res.json()) as { provider?: string; results?: unknown[]; content?: string };
    assert.equal(res.status, 200);
    assert.equal(body.provider, "anysearch-search");
    assert.equal(body.content, "# Rescued Content");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";

// Regression: Gemini Web retired "4 Argon" (2026-11). The Ultra picker now exposes
// Flash-Lite ("Quick answers"), Flash ("All-around help") and Carbon ("Most complex work").
// The executor hard-coded the Argon id `b1b46a6037e6aa9f` + inner[79]=1, which silently ran
// on Flash, and rejected `gemini-4-carbon` with 400. It must now route to the live Carbon mode.

const client = await import("../../open-sse/executors/gemini-web/streamGenerateClient.ts");
const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");

// Shape captured from a live otAQ7b response on an Ultra account (ids/numbers verbatim).
function makeStatus() {
  const status: unknown[] = new Array(18).fill(null);
  status[15] = [
    ["1d44b34bcaa1c04d", "Flash-Lite", null, null, null, null, null, null, null, 6, null, "Quick answers"],
    ["56fdd199312815e2", "Flash", null, null, null, null, null, null, null, 1, null, "All-around help"],
    ["95a4c0abcba24364", "Carbon", null, null, null, null, null, null, null, 8, null, "Most complex work"],
  ];
  status[16] = [16, 38];
  status[17] = [2, 140, 3, 4];
  return status;
}
function makeDiscoveryBody() {
  const frame = JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(makeStatus()), null, null, null, "generic"]]);
  return `)]}'\n\n${frame.length}\n${frame}\n25\n[["e",4,null,null,123]]\n`;
}
function makeStreamGenerateRaw(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `)]}'\n10\n[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
}

test("parseGeminiWebDiscovery extracts live modes and Ultra capacity", () => {
  const d = client.parseGeminiWebDiscovery(makeDiscoveryBody());
  assert.ok(d);
  assert.deepEqual(
    d.models.map((m) => [m.modelId, m.category, m.modelNumber]),
    [
      ["1d44b34bcaa1c04d", "Flash-Lite", 6],
      ["56fdd199312815e2", "Flash", 1],
      ["95a4c0abcba24364", "Carbon", 8],
    ]
  );
  assert.equal(d.capacity, 3);
  assert.equal(d.capacityField, 12);
});

test("every top-tier alias (incl. retired Argon) resolves to the Carbon mode", () => {
  const d = client.parseGeminiWebDiscovery(makeDiscoveryBody())!;
  for (const id of ["gemini-4-carbon", "gemini-4-carbon-high", "carbon", "gemini-4-argon", "gemini-4-argon-high", "gemini-4-ultra", "gemini-3.1-pro"]) {
    assert.equal(client.resolveGeminiWebModelKind(id), "carbon", id);
    assert.equal(client.pickGeminiWebLiveModel("carbon", d.models)?.modelId, "95a4c0abcba24364");
    assert.equal(client.geminiWebPublicModelId(id), "gemini-4-carbon", id);
  }
  assert.equal(client.resolveGeminiWebModelKind("gemini-3.8-flash"), "flash");
  assert.equal(client.pickGeminiWebLiveModel("flash", d.models)?.modelId, "56fdd199312815e2");
  assert.equal(client.resolveGeminiWebModelKind("gemini-3.5-flash-lite"), "flash-lite");
  assert.equal(client.pickGeminiWebLiveModel("flash-lite", d.models)?.modelId, "1d44b34bcaa1c04d");
});

test("buildGeminiWebModelHeader matches the web client's routing header layout", () => {
  const h = JSON.parse(
    client.buildGeminiWebModelHeader({ modelId: "95a4c0abcba24364", modelNumber: 8 }, 3, 12, "GEN")
  );
  assert.deepEqual(h, [1, null, null, null, "95a4c0abcba24364", null, null, 0, [4, 5, 6, 8], null, null, 3, null, null, 8, 1, "GEN"]);
});

test("static fallback no longer sends the retired Argon id for Argon/Carbon requests", () => {
  for (const id of ["gemini-4-argon", "gemini-4-carbon", "gemini-4-argon-high"]) {
    const sel = client.resolveGeminiWebModelSelector(id);
    assert.match(sel.header, /95a4c0abcba24364/, id);
    assert.doesNotMatch(sel.header, /b1b46a6037e6aa9f/, id);
    assert.equal(sel.category, 8, id);
  }
});

test("GeminiWebExecutor accepts gemini-4-carbon (validation passes, 401 on missing creds)", async () => {
  const result = await new GeminiWebExecutor().execute({
    model: "gemini-4-carbon",
    body: { messages: [{ role: "user", content: "hi" }], stream: false },
    stream: false,
    credentials: {},
    signal: AbortSignal.timeout(5000),
    log: null,
  } as never);
  assert.equal(result.response.status, 401);
});

test("direct HTTP: discovers live ids and sends the Carbon routing header + model number", async () => {
  client.clearGeminiWebSessionCache();
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) || {}));
    calls.push({ url: u, headers, body: String(init?.body ?? "") });
    if (u.endsWith("/app")) {
      return new Response('<script>{"SNlM0e":"AT_TOKEN","cfb2h":"boq_test","FdrFJe":"123"}</script>', { status: 200 });
    }
    if (u.includes("batchexecute")) return new Response(makeDiscoveryBody(), { status: 200 });
    if (u.includes("StreamGenerate")) return new Response(makeStreamGenerateRaw("CARBON_OK"), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    for (const requested of ["gemini-4-argon", "gemini-4-carbon"]) {
      calls.length = 0;
      client.clearGeminiWebSessionCache();
      const result = await client.executeGeminiWebDirectHttp({
        input: {
          model: requested,
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { apiKey: "__Secure-1PSID=abc", providerSpecificData: { transport: "http" } },
          signal: AbortSignal.timeout(5000),
          log: null,
        } as never,
        cookie: "__Secure-1PSID=abc",
        prompt: "hi",
        hasTools: false,
        requestedTools: undefined,
        mergeRotatedCookies: (c: string) => c,
        buildToolResponse: async () => new Response("{}"),
      });
      assert.equal(result.response.status, 200, requested);
      const json = (await result.response.json()) as any;
      assert.equal(json.model, "gemini-4-carbon", requested);
      assert.equal(json.choices[0].message.content, "CARBON_OK");
      const gen = calls.find((c) => c.url.includes("StreamGenerate"))!;
      const header = JSON.parse(gen.headers["x-goog-ext-525001261-jspb"]);
      assert.equal(header[4], "95a4c0abcba24364", requested);
      assert.equal(header[14], 8);
      const inner = JSON.parse(JSON.parse(new URLSearchParams(gen.body).get("f.req")!)[1]);
      assert.equal(inner[79], 8, "inner[79] must carry the Carbon model number");
    }
  } finally {
    globalThis.fetch = originalFetch;
    client.clearGeminiWebSessionCache();
  }
});

test("direct HTTP: Carbon missing from live discovery fails loudly (503), never silently downgrades", async () => {
  client.clearGeminiWebSessionCache();
  const originalFetch = globalThis.fetch;
  const noCarbon = () => {
    const s = makeStatus();
    s[15] = (s[15] as unknown[][]).filter((e) => e[1] !== "Carbon");
    const frame = JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(s), null, null, null, "generic"]]);
    return `)]}'\n${frame.length}\n${frame}\n`;
  };
  let streamCalled = false;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/app")) return new Response('{"SNlM0e":"AT","cfb2h":"bl","FdrFJe":"1"}', { status: 200 });
    if (u.includes("batchexecute")) return new Response(noCarbon(), { status: 200 });
    streamCalled = true;
    return new Response(makeStreamGenerateRaw("x"), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await client.executeGeminiWebDirectHttp({
      input: { model: "gemini-4-carbon", body: {}, stream: false, credentials: { apiKey: "k" }, signal: AbortSignal.timeout(5000), log: null } as never,
      cookie: "__Secure-1PSID=abc",
      prompt: "hi",
      hasTools: false,
      requestedTools: undefined,
      mergeRotatedCookies: (c: string) => c,
      buildToolResponse: async () => new Response("{}"),
    });
    assert.equal(result.response.status, 503);
    assert.equal(streamCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    client.clearGeminiWebSessionCache();
  }
});

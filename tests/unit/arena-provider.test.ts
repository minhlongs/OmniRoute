import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providers/index.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { arenaProvider } from "../../open-sse/config/providers/registry/arena/index.ts";
import { APIKEY_PROVIDERS_GATEWAYS } from "../../src/shared/constants/providers/apikey/gateways.ts";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers.ts";

test("arena provider registry entry exists and matches specification", () => {
  assert.ok(arenaProvider, "arenaProvider must exist");
  assert.equal(arenaProvider.id, "arena");
  assert.equal(arenaProvider.baseUrl, "https://api.arena.ai/v1/chat/completions");
  assert.equal(arenaProvider.authType, "apikey");
  assert.equal(arenaProvider.authHeader, "bearer");
  assert.equal(arenaProvider.format, "openai");
  assert.equal(arenaProvider.executor, "default");
  assert.equal(arenaProvider.passthroughModels, true);

  const modelIds = arenaProvider.models.map((m) => m.id);
  assert.ok(
    modelIds.includes("coding-router-preview"),
    "coding-router-preview must be in models array"
  );

  const codingRouter = arenaProvider.models.find((m) => m.id === "coding-router-preview");
  assert.ok(codingRouter, "coding-router-preview model config must be present");
  assert.equal(codingRouter.toolCalling, true, "coding-router-preview must support tool calling");
  assert.equal(
    codingRouter.supportsReasoning,
    true,
    "coding-router-preview must support reasoning"
  );
});

test("arena provider is registered in open-sse REGISTRY and getRegistryEntry", () => {
  assert.ok(REGISTRY.arena, "arena must be registered in REGISTRY");
  assert.equal(REGISTRY.arena.id, "arena");
  assert.equal(REGISTRY.arena.baseUrl, "https://api.arena.ai/v1/chat/completions");

  const entry = getRegistryEntry("arena");
  assert.ok(entry, "getRegistryEntry('arena') must return the arena entry");
  assert.equal(entry.id, "arena");
});

test("legacy lmarena provider is completely removed from provider registry", () => {
  assert.equal(
    (REGISTRY as Record<string, unknown>).lmarena,
    undefined,
    "lmarena must no longer exist in open-sse REGISTRY"
  );
  assert.equal(getRegistryEntry("lmarena"), null, "getRegistryEntry('lmarena') must return null");
  assert.equal(
    (WEB_COOKIE_PROVIDERS as Record<string, unknown>).lmarena,
    undefined,
    "lmarena must no longer be in WEB_COOKIE_PROVIDERS"
  );
});

test("arena is registered in APIKEY_PROVIDERS_GATEWAYS as a smart router / gateway", () => {
  assert.ok(APIKEY_PROVIDERS_GATEWAYS.arena, "arena must be in APIKEY_PROVIDERS_GATEWAYS");
  assert.equal(APIKEY_PROVIDERS_GATEWAYS.arena.id, "arena");
  assert.equal(APIKEY_PROVIDERS_GATEWAYS.arena.passthroughModels, true);
  assert.equal(APIKEY_PROVIDERS_GATEWAYS.arena.website, "https://arena.ai");
});

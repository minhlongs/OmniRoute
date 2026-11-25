import { after, test } from "node:test";
import assert from "node:assert/strict";

import { applyCatalogPostFilters } from "../../src/app/api/v1/models/catalogResponse.ts";
import {
  createApiKey,
  resetApiKeyState,
  updateApiKeyPermissions,
} from "../../src/lib/db/apiKeys.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// The isolated test env does not boot instrumentation-node.ts, so the key CRC
// secret has to be seeded before createApiKey() runs.
const SECRET_ENV = "API_KEY" + "_SECRET";
process.env[SECRET_ENV] ||= "test-secret-for-catalog-test";

const BASE = {
  id: "zunef/claude-opus-5-5",
  owned_by: "zunef",
  root: "claude-opus-5-5",
};

function makeRequest(key: string): Request {
  return new Request("http://localhost/v1/models", {
    headers: { authorization: `Bearer ${key}` },
  });
}

const ctx = { connections: [], prefixMode: "dual", aliasToProviderId: {} };

after(() => {
  resetApiKeyState();
  resetDbInstance();
});

test("blockedModels hides synthesized effort variants from discovery", async () => {
  const created = await createApiKey("blocked-variant-test", "test-machine", [], {
    modelAccessMode: "restricted",
    allowedModels: [BASE.id],
    allowedCombos: [],
  });
  await updateApiKeyPermissions(created.id, {
    blockedModels: [
      "zunef/*-low",
      "zunef/*-medium",
      "zunef/*-high",
      "zunef/*-xhigh",
      "no-think/zunef/*",
    ],
  });

  const out = await applyCatalogPostFilters(makeRequest(created.key), [BASE], ctx);
  const ids = out.map((model) => String(model.id));

  assert.ok(ids.includes(BASE.id), "the allowed base model must stay");
  assert.equal(
    ids.filter((id) => /-(low|medium|high|xhigh)$/.test(id)).length,
    0,
    "explicitly blocked effort variants must not be advertised"
  );
  assert.equal(
    ids.filter((id) => id.startsWith("no-think/")).length,
    0,
    "explicitly blocked no-think aliases must not be advertised"
  );
});

test("a key without blockedModels still sees the synthesized variants", async () => {
  const created = await createApiKey("unblocked-variant-test", "test-machine", [], {
    modelAccessMode: "restricted",
    allowedModels: [BASE.id],
    allowedCombos: [],
  });

  const out = await applyCatalogPostFilters(makeRequest(created.key), [BASE], ctx);
  const ids = out.map((model) => String(model.id));

  assert.ok(ids.includes(BASE.id));
  assert.ok(
    ids.some((id) => /-high$/.test(id)),
    "without a deny rule the effort variants must remain discoverable"
  );
});

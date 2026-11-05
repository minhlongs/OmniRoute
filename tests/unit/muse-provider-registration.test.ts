import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "@omniroute/open-sse/config/providers/index.ts";
import { getExecutor } from "@omniroute/open-sse/executors/index.ts";
import { MuseExecutor } from "@omniroute/open-sse/executors/muse.ts";
import { MuseWebExecutor } from "@omniroute/open-sse/executors/muse-web.ts";

test("muse provider entries are registered", () => {
  assert.equal(REGISTRY.muse?.id, "muse");
  assert.equal(REGISTRY["muse-web"]?.id, "muse-web");
});

test("getExecutor resolves the Muse executors", () => {
  assert.ok(getExecutor("muse") instanceof MuseExecutor);
  assert.ok(getExecutor("muse-web") instanceof MuseWebExecutor);
});

test("muse providers advertise chat models", () => {
  assert.ok((REGISTRY.muse?.models?.length ?? 0) > 0);
  assert.ok((REGISTRY["muse-web"]?.models?.length ?? 0) > 0);
});

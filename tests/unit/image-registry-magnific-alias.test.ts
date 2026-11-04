/**
 * Regression guard for the Freepik → Magnific provider rename (#10594).
 *
 * The provider slug and directory were renamed to `magnific`, but the image
 * registry kept importing `providers/registry/freepik/index.ts` — a path that no
 * longer exists — so `npm run build` failed with `Module not found` for the whole
 * app. This test pins both sides of the rename:
 *
 *   - the new `magnific` slug resolves,
 *   - the legacy `freepik` slug still resolves to the same provider object, so old
 *     URLs and saved combos keep working.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { IMAGE_PROVIDERS } = await import("../../open-sse/config/imageRegistry.ts");

test("magnific image provider is registered under the new slug", () => {
  const magnific = IMAGE_PROVIDERS.magnific;
  assert.ok(magnific, "IMAGE_PROVIDERS.magnific must exist after the rename");
  assert.equal(magnific.id, "magnific");
});

test("legacy freepik slug still resolves to the same provider config", () => {
  const freepik = IMAGE_PROVIDERS.freepik;
  assert.ok(freepik, "IMAGE_PROVIDERS.freepik must stay as a legacy alias");
  assert.equal(
    freepik,
    IMAGE_PROVIDERS.magnific,
    "both slugs must point at one shared provider config object"
  );
});

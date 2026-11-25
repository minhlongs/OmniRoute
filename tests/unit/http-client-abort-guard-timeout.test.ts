/**
 * A TimeoutError from the Undici dispatcher used to escape the process guard and
 * kill the gateway mid-stream, which clients reported as
 * "API Error: Connection lost mid-response" (launchd then restarted the app).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { isClientAbortError } = await import("../../src/shared/utils/httpClientAbortGuard.mjs");

function timeoutError(message: string, code?: string) {
  const err = new Error(message) as Error & { name: string; code?: string };
  err.name = "TimeoutError";
  if (code) err.code = code;
  return err;
}

test("upstream fetch timeouts are benign (process must survive)", () => {
  assert.equal(
    isClientAbortError(
      timeoutError("Upstream request did not return response headers after 120000ms")
    ),
    true
  );
  assert.equal(isClientAbortError(timeoutError("body timed out", "UND_ERR_BODY_TIMEOUT")), true);
  assert.equal(
    isClientAbortError(timeoutError("connect timed out", "UND_ERR_CONNECT_TIMEOUT")),
    true
  );
});

test("an unrelated TimeoutError still surfaces", () => {
  assert.equal(isClientAbortError(timeoutError("test timed out after 5000ms")), false);
});

test("ordinary errors still surface", () => {
  assert.equal(isClientAbortError(new Error("boom")), false);
});

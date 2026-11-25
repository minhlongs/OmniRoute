import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  proxyFetch,
  runWithDirectFetchContext,
  getOriginalFetch,
} from "../../open-sse/utils/proxyFetch.ts";
import { createProviderNode, deleteProviderNode } from "../../src/lib/db/providers.ts";
import {
  stopLocalHealthCheck,
  sweep,
  getHealthStatus,
} from "../../src/lib/localHealthCheck.ts";

function makeEconnresetError(
  msg = "fetch failed"
): TypeError & { cause: Error & { code: string; syscall: string; errno: number } } {
  const err = new TypeError(msg) as TypeError & {
    cause: Error & { code: string; syscall: string; errno: number };
  };
  const cause = new Error("read ECONNRESET") as Error & {
    code: string;
    syscall: string;
    errno: number;
  };
  cause.code = "ECONNRESET";
  cause.syscall = "read";
  cause.errno = -54;
  err.cause = cause;
  return err;
}

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = origWarn;
  }
  return warnings;
}

test("runWithDirectFetchContext bypasses Undici retry/fallback and emits 0 [ProxyFetch] warnings on loopback ECONNRESET", async () => {
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;

  let undiciCalls = 0;
  let nativeCalls = 0;

  try {
    const warnings = await captureWarnings(async () => {
      await runWithDirectFetchContext(async () => {
        await assert.rejects(
          () => fetch(`http://127.0.0.1:${address.port}/models`, { signal: AbortSignal.timeout(3000) }),
          (err: unknown) => err instanceof Error
        );

        await assert.rejects(
          () =>
            proxyFetch(
              `http://127.0.0.1:${address.port}/models`,
              { signal: AbortSignal.timeout(3000) },
              {
                undiciFetch: async () => {
                  undiciCalls += 1;
                  return getOriginalFetch()(`http://127.0.0.1:${address.port}/models`);
                },
                nativeFetch: async () => {
                  nativeCalls += 1;
                  return getOriginalFetch()(`http://127.0.0.1:${address.port}/models`);
                },
              }
            ),
          (err: unknown) => err instanceof Error
        );
      });
    });

    assert.equal(undiciCalls, 0, "undiciFetch dispatcher path must be skipped under runWithDirectFetchContext");
    assert.equal(nativeCalls, 0, "nativeFetch fallback must not run when originalFetch is used directly");
    assert.equal(
      warnings.filter((w) => w.includes("[ProxyFetch]")).length,
      0,
      `Expected 0 [ProxyFetch] warnings, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("direct proxyFetch appends [target=host] (stripping path/query/userinfo) and omits suffix when URL has no host", async () => {
  let caughtWithHost: (Error & { proxyFetchDetail?: string }) | null = null;
  const warningsWithHost = await captureWarnings(async () => {
    try {
      await proxyFetch(
        "https://user:pass@example.invalid:8443/v1/models?secret=ignored",
        { method: "GET" },
        {
          undiciFetch: async () => {
            throw makeEconnresetError();
          },
          nativeFetch: async () => {
            throw makeEconnresetError();
          },
        }
      );
    } catch (err) {
      caughtWithHost = err as Error & { proxyFetchDetail?: string };
    }
  });

  assert.match(caughtWithHost?.proxyFetchDetail ?? "", /dispatcher=\[.*ECONNRESET.*\] native=\[.*ECONNRESET.*\]/);
  const dispatcherWarn = warningsWithHost.find((w) =>
    w.includes("[ProxyFetch] Undici dispatcher failed, falling back to native fetch (after retry):")
  );
  const nativeWarn = warningsWithHost.find((w) =>
    w.includes("[ProxyFetch] native fetch fallback ALSO failed:")
  );
  assert.ok(dispatcherWarn?.endsWith("[target=example.invalid:8443]"), `Unexpected warn: ${dispatcherWarn}`);
  assert.ok(nativeWarn?.endsWith("[target=example.invalid:8443]"), `Unexpected warn: ${nativeWarn}`);
  assert.ok(!dispatcherWarn.includes("user:pass") && !dispatcherWarn.includes("ignored"));

  const warningsNoHost = await captureWarnings(async () => {
    await assert.rejects(() =>
      proxyFetch(
        "/relative/path",
        { method: "GET" },
        {
          undiciFetch: async () => {
            throw makeEconnresetError();
          },
          nativeFetch: async () => {
            throw makeEconnresetError();
          },
        }
      )
    );
  });
  for (const w of warningsNoHost) {
    assert.ok(!w.includes("[target="), `Did not expect empty [target=] suffix in: ${w}`);
  }
});

test("localHealthCheck.sweep() probes loopback provider_node inside runWithDirectFetchContext with 0 [ProxyFetch] warnings on ECONNRESET", async () => {
  stopLocalHealthCheck();
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;

  const node = await createProviderNode({
    type: "openai-compatible-chat",
    name: "Test Loopback Reset Node",
    prefix: "test-loopback-reset",
    apiType: "chat",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  });

  try {
    const warnings = await captureWarnings(async () => {
      await sweep();
    });
    stopLocalHealthCheck();

    const status = getHealthStatus(String(node.id));
    assert.ok(status, "Expected sweep() to record HealthStatus for loopback provider_node");
    assert.equal(status.isHealthy, false);
    assert.equal(status.consecutiveFailures, 1);
    assert.ok(status.lastError, "Expected lastError to be captured");
    assert.equal(
      warnings.filter((w) => w.includes("[ProxyFetch]")).length,
      0,
      `Expected 0 [ProxyFetch] warnings during localHealthCheck.sweep(), got: ${JSON.stringify(warnings)}`
    );
  } finally {
    stopLocalHealthCheck();
    await deleteProviderNode(String(node.id)).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

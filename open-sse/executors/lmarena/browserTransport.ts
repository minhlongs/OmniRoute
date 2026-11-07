/**
 * Opt-in Tier-2 browser-context fallback for LMArena (`arena.ai/text/direct`).
 *
 * When `OMNIROUTE_BROWSER_POOL=on` (or `WEB_COOKIE_USE_BROWSER=1` or
 * `providerSpecificData.useBrowserPool=true`) and direct TLS returns 403,
 * executes the same-origin `create-evaluation` POST inside the user's
 * pre-authenticated browser context from `browserPool.ts` without automating
 * or solving any anti-bot challenge.
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { acquireBrowserContext, openPage } from "../../services/browserPool.ts";
import { LMARENA_DIRECT_URL } from "./models.ts";

const MAX_LMARENA_BROWSER_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface LMArenaBrowserFetchInput {
  url: string;
  cookieString: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface LMArenaBrowserFetchResult {
  status: number;
  headers: Headers;
  text: string | null;
  body: ReadableStream<Uint8Array> | null;
}

type BrowserFallbackOverride = (
  input: LMArenaBrowserFetchInput
) => Promise<LMArenaBrowserFetchResult>;

let browserFallbackOverride: BrowserFallbackOverride | null = null;

export function __setLMArenaBrowserFallbackOverrideForTesting(
  fn: BrowserFallbackOverride | null
): void {
  browserFallbackOverride = fn;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isLMArenaBrowserFallbackEnabled(credentials?: unknown): boolean {
  if (browserFallbackOverride) return true;
  if (isTruthyEnvFlag(process.env.OMNIROUTE_BROWSER_POOL)) return true;
  if (isTruthyEnvFlag(process.env.WEB_COOKIE_USE_BROWSER)) return true;
  if (credentials && typeof credentials === "object") {
    const c = credentials as Record<string, unknown>;
    if (c.useBrowserPool === true) return true;
    if (c.providerSpecificData && typeof c.providerSpecificData === "object") {
      const psd = c.providerSpecificData as Record<string, unknown>;
      if (psd.useBrowserPool === true) return true;
    }
  }
  return false;
}

function filterInPageFetchHeaders(headers: Record<string, string>): Record<string, string> {
  const forbidden = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "referer",
    "user-agent",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (forbidden.has(lower) || lower.startsWith("sec-")) continue;
    out[key] = value;
  }
  return out;
}

export async function fetchLMArenaViaBrowserPool(
  input: LMArenaBrowserFetchInput
): Promise<LMArenaBrowserFetchResult> {
  if (input.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (browserFallbackOverride) {
    return browserFallbackOverride(input);
  }

  const keyHash = createHash("sha256")
    .update(`${input.cookieString}|${input.headers["User-Agent"] || ""}`)
    .digest("hex")
    .slice(0, 16);
  const poolKey = `lmarena:${keyHash}`;

  const pooled = await acquireBrowserContext(poolKey, {
    cookieDomain: ".arena.ai",
    cookieString: input.cookieString,
    warmupUrl: LMARENA_DIRECT_URL,
    userAgent: input.headers["User-Agent"],
    proxyProviderKey: "lmarena",
  });

  if (input.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const page = await openPage(pooled);
  const onAbort = () => {
    void page.close().catch(() => {});
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!page.url().startsWith("https://arena.ai")) {
      await page.goto(LMARENA_DIRECT_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    if (input.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const fetchHeaders = filterInPageFetchHeaders(input.headers);
    const maxBytes = MAX_LMARENA_BROWSER_RESPONSE_BYTES;
    const captured = await page.evaluate(
      async ({ url, headers, body, limit }) => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          credentials: "include",
        });
        const responseHeaders = Object.fromEntries(res.headers.entries());
        const reader = res.body?.getReader();
        const chunks: string[] = [];
        let total = 0;
        const toBase64 = (bytes: Uint8Array): string => {
          let bin = "";
          const step = 32 * 1024;
          for (let i = 0; i < bytes.byteLength; i += step) {
            bin += String.fromCharCode(...bytes.subarray(i, i + step));
          }
          return btoa(bin);
        };
        try {
          while (reader) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > limit) {
              await reader.cancel().catch(() => {});
              throw new Error("Arena browser response exceeded size limit");
            }
            chunks.push(toBase64(value));
          }
        } finally {
          try {
            reader?.releaseLock();
          } catch {
            // Reader may already be released.
          }
        }
        return {
          status: res.status,
          headers: responseHeaders,
          chunks,
        };
      },
      {
        url: input.url,
        headers: fetchHeaders,
        body: input.body,
        limit: maxBytes,
      }
    );

    const bytes = Buffer.concat(captured.chunks.map((c) => Buffer.from(c, "base64")));
    const text = new TextDecoder().decode(bytes);
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    return {
      status: captured.status,
      headers: new Headers(captured.headers),
      text,
      body: bodyStream,
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await page.close().catch(() => {});
  }
}

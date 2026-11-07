/**
 * LMArena Split Supabase SSR Cookie & cURL Extraction — Regression Tests (#4271)
 *
 * LMArena migrated to Supabase SSR chunked auth cookies. The single
 * `arena-auth-prod-v1` cookie is now empty; the real session value is split
 * across `arena-auth-prod-v1.0`, `arena-auth-prod-v1.1`, … (ascending). We
 * reconstruct the single cookie from its chunks AND preserve the original
 * `.0`/`.1` chunks alongside `cf_clearance`, while also supporting DevTools
 * "Copy as cURL" inputs from https://arena.ai/text/direct.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LMArenaExecutor,
  parseLMArenaCredentialInput,
  reconstructLMArenaCookie,
} from "../../open-sse/executors/lmarena.ts";
import { getWebSessionCredentialRequirement } from "../../src/shared/providers/webSessionCredentials.ts";

type ExecutorHeaderAccess = {
  buildRequestHeaders: (
    model: string,
    credentials: unknown,
    body: unknown
  ) => Record<string, string>;
  transformRequest: (
    body: unknown,
    model: string,
    credentials?: unknown
  ) => {
    mode: string;
    recaptchaV3Token: string | null;
  };
};

function access(executor: LMArenaExecutor): ExecutorHeaderAccess {
  return executor as unknown as ExecutorHeaderAccess;
}

function cookieHeaderFor(credentials: unknown): string | undefined {
  const executor = new LMArenaExecutor();
  const headers = access(executor).buildRequestHeaders("gpt-4", credentials, {});
  return headers.Cookie;
}

describe("LMArena split Supabase SSR cookie (#4271)", () => {
  it("reconstructs the single cookie from ascending chunks and preserves .0/.1 chunks", () => {
    const raw =
      "arena-auth-prod-v1=; arena-auth-prod-v1.0=base64-eyJABC; arena-auth-prod-v1.1=DEF.ghi";
    const reconstructed = reconstructLMArenaCookie(raw);

    assert.ok(
      reconstructed.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"),
      `expected reconstructed cookie to carry the joined session, got: ${reconstructed}`
    );
    assert.ok(
      reconstructed.includes("arena-auth-prod-v1.0=base64-eyJABC"),
      `expected .0 chunk to be preserved, got: ${reconstructed}`
    );
    assert.ok(
      reconstructed.includes("arena-auth-prod-v1.1=DEF.ghi"),
      `expected .1 chunk to be preserved, got: ${reconstructed}`
    );

    const header = cookieHeaderFor({ cookie: raw });
    assert.ok(header, "should set a Cookie header");
    assert.ok(
      header!.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"),
      `Cookie header should carry the reconstructed session, got: ${header}`
    );
  });

  it("leaves a non-empty single cookie unchanged (back-compat)", () => {
    const raw = "arena-auth-prod-v1=base64-xyz";
    const reconstructed = reconstructLMArenaCookie(raw);
    assert.ok(
      reconstructed.includes("arena-auth-prod-v1=base64-xyz"),
      `back-compat cookie should be preserved, got: ${reconstructed}`
    );

    const header = cookieHeaderFor({ cookie: raw });
    assert.equal(header, "arena-auth-prod-v1=base64-xyz");
  });

  it("concatenates chunks in ascending numeric order even when pasted out of order", () => {
    const raw =
      "arena-auth-prod-v1.1=DEF.ghi; arena-auth-prod-v1.0=base64-eyJABC; arena-auth-prod-v1=";
    const reconstructed = reconstructLMArenaCookie(raw);
    assert.ok(
      reconstructed.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"),
      `expected .0 then .1 regardless of paste order, got: ${reconstructed}`
    );
  });

  it("preserves other cookies in the jar while injecting the reconstructed session", () => {
    const raw =
      "cf_clearance=abc; arena-auth-prod-v1=; arena-auth-prod-v1.0=base64-eyJABC; arena-auth-prod-v1.1=DEF.ghi; sidebar=open";
    const reconstructed = reconstructLMArenaCookie(raw);
    assert.ok(
      reconstructed.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"),
      `session should be reconstructed, got: ${reconstructed}`
    );
    assert.ok(reconstructed.includes("cf_clearance=abc"), "should keep cf_clearance");
    assert.ok(reconstructed.includes("sidebar=open"), "should keep sidebar");
  });

  it("reconstructs from separately stored providerSpecificData chunk keys", () => {
    const header = cookieHeaderFor({
      providerSpecificData: {
        "arena-auth-prod-v1.0": "base64-eyJABC",
        "arena-auth-prod-v1.1": "DEF.ghi",
      },
    });

    assert.ok(header, "should set a Cookie header");
    assert.ok(header!.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"));
    assert.ok(header!.includes("arena-auth-prod-v1.0=base64-eyJABC"));
    assert.ok(header!.includes("arena-auth-prod-v1.1=DEF.ghi"));
  });

  it("reconstructs from separately stored top-level chunk keys", () => {
    const header = cookieHeaderFor({
      "arena-auth-prod-v1.0": "base64-eyJABC",
      "arena-auth-prod-v1.1": "DEF.ghi",
    });

    assert.ok(header, "should set a Cookie header");
    assert.ok(header!.includes("arena-auth-prod-v1=base64-eyJABCDEF.ghi"));
    assert.ok(header!.includes("arena-auth-prod-v1.0=base64-eyJABC"));
    assert.ok(header!.includes("arena-auth-prod-v1.1=DEF.ghi"));
  });

  it("treats an empty base with no chunks as no usable session (returned as-is)", () => {
    const raw = "arena-auth-prod-v1=";
    const reconstructed = reconstructLMArenaCookie(raw);
    assert.equal(reconstructed, raw);

    const header = cookieHeaderFor({ cookie: raw });
    assert.ok(
      !/arena-auth-prod-v1=[^;\s]/.test(header ?? ""),
      `should not fabricate a session value, got: ${header}`
    );
  });

  it("parses DevTools 'Copy as cURL' command with -b / -H cookie, macOS User-Agent, and payload hints", () => {
    const macUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
    const curlCmd = [
      "curl 'https://arena.ai/nextjs-api/stream/create-evaluation' \\",
      `  -H 'user-agent: ${macUa}' \\`,
      "  -H 'referer: https://arena.ai/text/direct' \\",
      "  -b 'arena-auth-prod-v1.0=base64-eyJMac; arena-auth-prod-v1.1=Part2; cf_clearance=cf_mac_123' \\",
      '  --data-raw \'{"id":"123","mode":"direct","recaptchaV3Token":"rc_tok_from_curl"}\'',
    ].join("\n");

    const parsed = parseLMArenaCredentialInput(curlCmd);
    assert.ok(parsed.cookie.includes("arena-auth-prod-v1=base64-eyJMacPart2"));
    assert.ok(parsed.cookie.includes("arena-auth-prod-v1.0=base64-eyJMac"));
    assert.ok(parsed.cookie.includes("arena-auth-prod-v1.1=Part2"));
    assert.ok(parsed.cookie.includes("cf_clearance=cf_mac_123"));
    assert.equal(parsed.headers["User-Agent"], macUa);
    assert.equal(parsed.mode, "direct");
    assert.equal(parsed.recaptchaV3Token, "rc_tok_from_curl");

    const executor = new LMArenaExecutor();
    const headers = access(executor).buildRequestHeaders("gpt-4", { cookie: curlCmd }, {});
    assert.equal(headers["User-Agent"], macUa);
    assert.equal(headers["Sec-Ch-Ua-Platform"], '"macOS"');
    assert.ok(headers["Sec-Ch-Ua"].includes('v="148"'));
    assert.equal(headers.Referer, "https://arena.ai/text/direct");

    const transformed = access(executor).transformRequest(
      { messages: [{ role: "user", content: "Hi" }] },
      "gpt-4",
      { cookie: curlCmd }
    );
    assert.equal(transformed.mode, "direct");
    assert.equal(transformed.recaptchaV3Token, "rc_tok_from_curl");
  });
});

describe("LMArena split-cookie credential storage keys (#4271)", () => {
  it("knows about the chunked .0 / .1 storage keys", () => {
    const req = getWebSessionCredentialRequirement("lmarena");
    assert.ok(req, "should have a credential requirement");
    assert.ok(
      req!.storageKeys.includes("arena-auth-prod-v1.0"),
      "storageKeys should include arena-auth-prod-v1.0"
    );
    assert.ok(
      req!.storageKeys.includes("arena-auth-prod-v1.1"),
      "storageKeys should include arena-auth-prod-v1.1"
    );
  });

  it("instructs pasting the full Cookie header in the placeholder", () => {
    const req = getWebSessionCredentialRequirement("lmarena");
    assert.ok(req, "should have a credential requirement");
    assert.ok(
      /full cookie header/i.test(req!.placeholder),
      `placeholder should instruct pasting the full Cookie header, got: ${req!.placeholder}`
    );
  });
});

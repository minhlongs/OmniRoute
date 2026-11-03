import { createHash } from "node:crypto";
import { mergeAbortSignals, type ExecuteInput } from "../base.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../../utils/error.ts";
import { WrbFrameAccumulator } from "../gemini-web-lab/wrbParser.ts";

const DEFAULT_BASE_URL = "https://gemini.google.com";
const DEFAULT_BL = "boq_assistant-bard-web-server_20260501.00_p0";
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_CACHE_SIZE = 128;
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface GeminiWebModelSelector {
  header: string;
  category: number;
}

export const GEMINI_WEB_MODEL_SELECTORS: Readonly<Record<string, GeminiWebModelSelector>> = {
  "gemini-4-argon": {
    header: '[1,null,null,null,"b1b46a6037e6aa9f",null,null,0,[4]]',
    category: 1,
  },
  "gemini-4-ultra": {
    header: '[1,null,null,null,"b1b46a6037e6aa9f",null,null,0,[4]]',
    category: 1,
  },
  "gemini-3-ultra": {
    header: '[1,null,null,null,"65001261a8e4c1d0",null,null,0,[4]]',
    category: 1,
  },
  "gemini-3.1-pro": {
    header: '[1,null,null,null,"2525e3954d185b3c",null,null,0,[4]]',
    category: 1,
  },
  "gemini-3-pro": {
    header: '[1,null,null,null,"2525e3954d185b3c",null,null,0,[4]]',
    category: 1,
  },
  "gemini-2.5-pro": {
    header: '[1,null,null,null,"2525e3954d185b3c",null,null,0,[4]]',
    category: 3,
  },
  "gemini-3.7-flash": {
    header: '[1,null,null,null,"f299729663a2343f",null,null,0,[4]]',
    category: 2,
  },
  "gemini-3-flash": {
    header: '[1,null,null,null,"f299729663a2343f",null,null,0,[4]]',
    category: 2,
  },
  "gemini-2.5-flash": {
    header: '[1,null,null,null,"f299729663a2343f",null,null,0,[4]]',
    category: 4,
  },
  "gemini-3.1-flash-lite": {
    header: '[1,null,null,null,"3513a98d90f6f8e2",null,null,0,[4]]',
    category: 4,
  },
};

interface CachedGeminiWebSession {
  at: string;
  bl: string;
  fSid: string;
  expiresAt: number;
}

const sessionCache = new Map<string, CachedGeminiWebSession>();

export function clearGeminiWebSessionCache(): void {
  sessionCache.clear();
}

function getProviderSpecificRecord(
  credentials: ExecuteInput["credentials"]
): Record<string, unknown> {
  const psd = credentials?.providerSpecificData;
  if (!psd || typeof psd !== "object" || Array.isArray(psd)) return {};
  return psd as Record<string, unknown>;
}

export function normalizeGeminiWebModelId(model: string): string {
  const trimmed = (model || "gemini-3.1-pro").trim();
  return trimmed.endsWith("-http") ? trimmed.slice(0, -5) : trimmed;
}

export function shouldUseGeminiWebDirectHttp(
  model: string,
  credentials: ExecuteInput["credentials"]
): boolean {
  const psd = getProviderSpecificRecord(credentials);
  const transport = typeof psd.transport === "string" ? psd.transport.trim().toLowerCase() : "";
  if (transport === "playwright" || transport === "browser") return false;
  if (transport === "http" || transport === "direct") return true;
  if (typeof psd.endpointUrl === "string" && psd.endpointUrl.trim().length > 0) return true;
  if (typeof psd.atToken === "string" && psd.atToken.trim().length > 0) return true;
  if (typeof psd.modelHeader === "string" && psd.modelHeader.trim().length > 0) return true;
  const lowerModel = (model || "").trim().toLowerCase();
  return (
    lowerModel.includes("argon") || lowerModel.includes("ultra") || lowerModel.endsWith("-http")
  );
}

export function resolveGeminiWebModelSelector(
  model: string,
  psd: Record<string, unknown> = {}
): GeminiWebModelSelector {
  const normalized = normalizeGeminiWebModelId(model).toLowerCase();
  const base =
    GEMINI_WEB_MODEL_SELECTORS[normalized] ?? GEMINI_WEB_MODEL_SELECTORS["gemini-3.1-pro"];
  const customHeader =
    typeof psd.modelHeader === "string" && psd.modelHeader.trim().length > 0
      ? psd.modelHeader.trim()
      : base.header;
  const customCategory =
    typeof psd.modelCategory === "number" && Number.isFinite(psd.modelCategory)
      ? psd.modelCategory
      : base.category;
  return { header: customHeader, category: customCategory };
}

function makeSessionCacheKey(baseUrl: string, cookie: string): string {
  return createHash("sha256").update(`${baseUrl}|${cookie}`).digest("hex");
}

function extractSetCookiePairs(headers: Headers): Array<{ name: string; value: string }> {
  const rawList =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") || ""].filter(Boolean);
  const pairs: Array<{ name: string; value: string }> = [];
  for (const raw of rawList) {
    for (const match of raw.matchAll(/(__Secure-1PSID(?:TS|CC)?)=([^;\s,]+)/g)) {
      pairs.push({ name: match[1], value: match[2] });
    }
  }
  return pairs;
}

function buildJsonError(status: number, message: string, code?: string): Response {
  return new Response(
    JSON.stringify(buildErrorBody(status, message, undefined, code ? { code } : undefined)),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function buildStreamGeneratePayload(prompt: string, at: string, category: number): string {
  const inner: unknown[] = new Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[7] = 1;
  inner[79] = category;
  return new URLSearchParams({
    "f.req": JSON.stringify([null, JSON.stringify(inner)]),
    at,
  }).toString();
}

async function resolveSessionTokens(
  baseUrl: string,
  cookie: string,
  psd: Record<string, unknown>,
  signal: AbortSignal
): Promise<
  | { session: CachedGeminiWebSession; rotatedPairs: Array<{ name: string; value: string }> }
  | { error: Response }
> {
  if (typeof psd.atToken === "string" && psd.atToken.trim().length > 0) {
    return {
      session: {
        at: psd.atToken.trim(),
        bl: typeof psd.bl === "string" && psd.bl.trim() ? psd.bl.trim() : DEFAULT_BL,
        fSid: typeof psd.fSid === "string" ? psd.fSid.trim() : "",
        expiresAt: Date.now() + SESSION_TTL_MS,
      },
      rotatedPairs: [],
    };
  }

  const key = makeSessionCacheKey(baseUrl, cookie);
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { session: cached, rotatedPairs: [] };
  }

  const appUrl = new URL("/app", baseUrl).toString();
  const resp = await fetch(appUrl, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent": GEMINI_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "manual",
    signal,
  });

  const rotatedPairs = extractSetCookiePairs(resp.headers);
  const location = resp.headers.get("location") || "";
  if (
    resp.status === 401 ||
    resp.status === 403 ||
    (resp.status >= 300 &&
      resp.status < 400 &&
      (location.includes("ServiceLogin") || location.includes("accounts.google.com")))
  ) {
    sessionCache.delete(key);
    return {
      error: buildJsonError(
        401,
        "Gemini Web session expired or redirected to Google login. Refresh __Secure-1PSID / __Secure-1PSIDTS cookies."
      ),
    };
  }

  const html = await resp.text();
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!atMatch?.[1]) {
    sessionCache.delete(key);
    return {
      error: buildJsonError(
        401,
        "Gemini Web SNlM0e CSRF token not found on /app page; cookies may be expired or challenged."
      ),
    };
  }

  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  const fSidMatch = html.match(/"FdrFJe":"([^"]+)"/);
  const session: CachedGeminiWebSession = {
    at: atMatch[1],
    bl: blMatch?.[1] || DEFAULT_BL,
    fSid: fSidMatch?.[1] || "",
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  if (sessionCache.size >= MAX_SESSION_CACHE_SIZE) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey) sessionCache.delete(oldestKey);
  }
  sessionCache.set(key, session);
  return { session, rotatedPairs };
}

export interface DirectHttpExecuteOptions {
  input: ExecuteInput;
  cookie: string;
  prompt: string;
  hasTools: boolean;
  requestedTools: unknown;
  mergeRotatedCookies: (
    originalCookie: string,
    jarCookies: Array<{ name: string; value: string }>
  ) => string;
  buildToolResponse: (
    responseText: string,
    requestedTools: unknown,
    stream: boolean,
    model: string,
    cid: string,
    created: number
  ) => Promise<Response>;
}

export async function executeGeminiWebDirectHttp({
  input,
  cookie,
  prompt,
  hasTools,
  requestedTools,
  mergeRotatedCookies,
  buildToolResponse,
}: DirectHttpExecuteOptions): Promise<{
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
}> {
  const { model, body, stream, credentials, signal, log, onCredentialsRefreshed } = input;
  const psd = getProviderSpecificRecord(credentials);
  const rawBase =
    typeof psd.endpointUrl === "string" && psd.endpointUrl.trim().length > 0
      ? psd.endpointUrl.trim().replace(/\/+$/, "")
      : DEFAULT_BASE_URL;
  const cleanModel = normalizeGeminiWebModelId(model);
  const selector = resolveGeminiWebModelSelector(model, psd);
  const timeoutSignal = AbortSignal.timeout(60_000);
  const effectiveSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;

  let streamUrl = `${rawBase}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Origin: rawBase,
    Referer: `${rawBase}/app`,
    "User-Agent": GEMINI_USER_AGENT,
    "X-Same-Domain": "1",
    "x-goog-ext-525001261-jspb": selector.header,
  };

  try {
    if (effectiveSignal.aborted) {
      throw effectiveSignal.reason instanceof Error
        ? effectiveSignal.reason
        : new Error("Request aborted");
    }

    const resolved = await resolveSessionTokens(rawBase, cookie, psd, effectiveSignal);
    if ("error" in resolved) {
      return { response: resolved.error, url: streamUrl, headers: {}, transformedBody: body };
    }

    const { session, rotatedPairs } = resolved;
    const query = new URLSearchParams({ bl: session.bl, hl: "en", rt: "c" });
    if (session.fSid) query.set("f.sid", session.fSid);
    streamUrl = `${streamUrl}?${query.toString()}`;

    const upstream = await fetch(streamUrl, {
      method: "POST",
      headers: { ...reqHeaders, Cookie: cookie },
      body: buildStreamGeneratePayload(prompt, session.at, selector.category),
      redirect: "manual",
      signal: effectiveSignal,
    });

    const allRotated = [...rotatedPairs, ...extractSetCookiePairs(upstream.headers)];
    if (allRotated.length > 0 && onCredentialsRefreshed) {
      try {
        const mergedCookie = mergeRotatedCookies(cookie, allRotated);
        if (mergedCookie && mergedCookie !== cookie) {
          await onCredentialsRefreshed({ ...credentials, apiKey: mergedCookie });
        }
      } catch (rotErr) {
        log?.warn?.(
          "GEMINI-WEB",
          `Failed to persist rotated cookie: ${rotErr instanceof Error ? rotErr.message : String(rotErr)}`
        );
      }
    }

    const rawText = await upstream.text();
    if (
      upstream.status === 401 ||
      upstream.status === 403 ||
      rawText.includes("account-chooser") ||
      rawText.includes("ServiceLogin")
    ) {
      sessionCache.delete(makeSessionCacheKey(rawBase, cookie));
      return {
        response: buildJsonError(
          upstream.status === 401 ? 401 : 403,
          "Gemini Web session unauthorized or expired during StreamGenerate."
        ),
        url: streamUrl,
        headers: {},
        transformedBody: body,
      };
    }

    if (!upstream.ok) {
      return {
        response: buildJsonError(
          upstream.status,
          `Gemini Web StreamGenerate returned HTTP ${upstream.status}: ${rawText.slice(0, 200)}`
        ),
        url: streamUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const acc = new WrbFrameAccumulator();
    const events = [...acc.pushChunk(rawText), ...acc.flush()];
    const fullText = acc.getFullText();
    const fullThought = acc.getFullThought();

    if (!fullText && !fullThought) {
      return {
        response: buildJsonError(502, "No response from Gemini"),
        url: streamUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-gweb-${Date.now()}`;

    if (hasTools) {
      const toolResp = await buildToolResponse(
        fullText,
        requestedTools,
        Boolean(stream),
        cleanModel,
        id,
        created
      );
      return { response: toolResp, url: streamUrl, headers: {}, transformedBody: body };
    }

    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        start(controller) {
          const send = (delta: Record<string, unknown>, finishReason: string | null = null) => {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: cleanModel,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };
          send({ role: "assistant" });
          for (const evt of events) {
            const delta: Record<string, unknown> = {};
            if (evt.thoughtDelta) delta.reasoning_content = evt.thoughtDelta;
            if (evt.textDelta) delta.content = evt.textDelta;
            if (Object.keys(delta).length > 0) send(delta);
          }
          send({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return {
        response: new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        }),
        url: streamUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const message: Record<string, unknown> = { role: "assistant", content: fullText };
    if (fullThought) message.reasoning_content = fullThought;
    return {
      response: new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: cleanModel,
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: streamUrl,
      headers: {},
      transformedBody: body,
    };
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err);
    log?.error?.("GEMINI-WEB", `Direct HTTP error: ${safeMsg}`);
    return {
      response: buildJsonError(500, safeMsg),
      url: streamUrl,
      headers: {},
      transformedBody: body,
    };
  }
}

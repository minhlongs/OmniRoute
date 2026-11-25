import { createHash, randomUUID } from "node:crypto";
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

/**
 * Gemini Web routing identities, as returned by the live `otAQ7b` model-discovery RPC.
 *
 * Gemini Web retired the "4 Argon" picker entry: Ultra accounts now expose three task-based
 * modes whose categories are Flash-Lite ("Quick answers"), Flash ("All-around help") and
 * Carbon ("Most complex work" = Gemini 4 Carbon). The old Argon id `b1b46a6037e6aa9f` is no
 * longer listed, and its inner[79] value (1) now selects Flash — so legacy Argon requests were
 * silently answered by Flash. Every Argon / Gemini-4 / Ultra / Pro request now resolves to
 * Carbon. These ids are only the FALLBACK: the executor discovers the account's live ids per
 * session (see discoverGeminiWebModels) and prefers them.
 *
 * `category` is the value written to the StreamGenerate inner[79] slot, which is the model
 * NUMBER reported by discovery (not a free-form category).
 */
export const GEMINI_WEB_GENERATION_ID = randomUUID().toUpperCase();

export interface GeminiWebLiveModel {
  modelId: string;
  category: string;
  display: string;
  modelNumber: number;
}

export interface GeminiWebDiscovery {
  models: GeminiWebLiveModel[];
  capacity: number;
  capacityField: number;
}

export function buildGeminiWebModelHeader(
  model: Pick<GeminiWebLiveModel, "modelId" | "modelNumber">,
  capacity = 3,
  capacityField = 12,
  generationId = GEMINI_WEB_GENERATION_ID
): string {
  const field = capacityField === 13 ? 13 : 12;
  const offset = field - 12;
  const header: unknown[] = new Array(17 + offset).fill(null);
  header[0] = 1;
  header[4] = model.modelId;
  header[7] = 0;
  header[8] = [4, 5, 6, 8];
  header[field - 1] = capacity > 0 ? capacity : 1;
  header[14 + offset] = model.modelNumber;
  header[15 + offset] = 1;
  header[16 + offset] = generationId;
  return JSON.stringify(header);
}

const CARBON_FALLBACK: GeminiWebLiveModel = {
  modelId: "95a4c0abcba24364",
  category: "Carbon",
  display: "Most complex work",
  modelNumber: 8,
};
const FLASH_FALLBACK: GeminiWebLiveModel = {
  modelId: "56fdd199312815e2",
  category: "Flash",
  display: "All-around help",
  modelNumber: 1,
};
const FLASH_LITE_FALLBACK: GeminiWebLiveModel = {
  modelId: "1d44b34bcaa1c04d",
  category: "Flash-Lite",
  display: "Quick answers",
  modelNumber: 6,
};

const carbonSelector = (): GeminiWebModelSelector => ({
  header: buildGeminiWebModelHeader(CARBON_FALLBACK),
  category: CARBON_FALLBACK.modelNumber,
});
const flashSelector = (): GeminiWebModelSelector => ({
  header: buildGeminiWebModelHeader(FLASH_FALLBACK),
  category: FLASH_FALLBACK.modelNumber,
});
const flashLiteSelector = (): GeminiWebModelSelector => ({
  header: buildGeminiWebModelHeader(FLASH_LITE_FALLBACK),
  category: FLASH_LITE_FALLBACK.modelNumber,
});

export const GEMINI_WEB_MODEL_SELECTORS: Readonly<Record<string, GeminiWebModelSelector>> = {
  "gemini-4-carbon": carbonSelector(),
  "gemini-4-carbon-high": carbonSelector(),
  "gemini-4-carbon-medium": carbonSelector(),
  "gemini-4-carbon-low": carbonSelector(),
  carbon: carbonSelector(),
  // Retired on Gemini Web — routed to Carbon (the only top-tier web mode left).
  "gemini-4-argon": carbonSelector(),
  "gemini-4-argon-low": carbonSelector(),
  "gemini-4-argon-medium": carbonSelector(),
  "gemini-4-argon-high": carbonSelector(),
  "gemini-4-ultra": carbonSelector(),
  "gemini-3-ultra": carbonSelector(),
  "gemini-3.1-pro": carbonSelector(),
  "gemini-3-pro": carbonSelector(),
  "gemini-2.5-pro": carbonSelector(),
  "gemini-3.8-flash": flashSelector(),
  "gemini-3.7-flash": flashSelector(),
  "gemini-3-flash": flashSelector(),
  "gemini-2.5-flash": flashSelector(),
  "gemini-3.1-flash-lite": flashLiteSelector(),
  "gemini-3.5-flash-lite": flashLiteSelector(),
};

export type GeminiWebModelKind = "carbon" | "flash" | "flash-lite";

/** Map any requested id onto the Gemini Web mode family it should run on. */
export function resolveGeminiWebModelKind(model: string): GeminiWebModelKind {
  const id = normalizeGeminiWebModelId(model).toLowerCase();
  if (/flash-lite|quick/.test(id)) return "flash-lite";
  if (/flash|all-around/.test(id) && !/carbon|argon/.test(id)) return "flash";
  return "carbon";
}

/** Public id reported back to clients for a request (Carbon for every top-tier alias). */
export function geminiWebPublicModelId(model: string): string {
  const kind = resolveGeminiWebModelKind(model);
  if (kind === "carbon") return "gemini-4-carbon";
  const id = normalizeGeminiWebModelId(model);
  return id || (kind === "flash" ? "gemini-3.8-flash" : "gemini-3.5-flash-lite");
}

export function pickGeminiWebLiveModel(
  kind: GeminiWebModelKind,
  models: GeminiWebLiveModel[]
): GeminiWebLiveModel | null {
  const by = (re: RegExp) =>
    models.find((m) => re.test(m.category)) ?? models.find((m) => re.test(m.display)) ?? null;
  if (kind === "carbon") return by(/carbon/i) ?? by(/complex/i);
  if (kind === "flash-lite") return by(/flash-lite/i) ?? by(/quick/i);
  return models.find((m) => /^flash$/i.test(m.category.trim())) ?? by(/all-around/i);
}

// Mirrors Gemini-API's AvailableModel.compute_capacity (same priorities as the Go bridge).
export function geminiWebAccountCapacity(tiers: unknown, caps: unknown): [number, number] {
  const has = (flags: unknown, want: number) =>
    Array.isArray(flags) && flags.some((f) => Number(f) === want);
  if (has(tiers, 21)) return [1, 13];
  if (has(tiers, 22)) return [2, 13];
  if (has(caps, 115)) return [4, 12];
  if (has(tiers, 16) || has(caps, 106)) return [3, 12];
  if (has(tiers, 8) || has(caps, 19)) return [2, 12];
  return [1, 12];
}

function collectOtAQ7bRecords(value: unknown, out: unknown[][]): void {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    (value[0] === "wrb.fr" || value[0] === "er") &&
    value[1] === "otAQ7b"
  ) {
    out.push(value);
    return;
  }
  for (const item of value) collectOtAQ7bRecords(item, out);
}

function firstString(fields: unknown[], ...indexes: number[]): string {
  for (const i of indexes) {
    const v = fields[i];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** Parse an `otAQ7b` batchexecute body (XSSI guard + length-prefixed frames). */
export function parseGeminiWebDiscovery(rawBody: string): GeminiWebDiscovery | null {
  let body = (rawBody || "").trim();
  if (body.startsWith(")]}'")) body = body.slice(4);
  const records: unknown[][] = [];
  // Scan top-level JSON arrays (frames may span lines; length prefixes are skipped).
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          collectOtAQ7bRecords(JSON.parse(body.slice(start, i + 1)), records);
        } catch {
          /* malformed frame */
        }
        start = -1;
      }
    }
  }
  for (const record of records) {
    let status: unknown = record[2];
    if (typeof status === "string") {
      try {
        status = JSON.parse(status);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(status)) continue;
    const [capacity, capacityField] = geminiWebAccountCapacity(status[16], status[17]);
    const entries = Array.isArray(status[15]) ? status[15] : [];
    const models: GeminiWebLiveModel[] = [];
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const modelId = firstString(entry, 0);
      if (!modelId) continue;
      const rawNumber = entry[17] ?? entry[9];
      const modelNumber = rawNumber == null ? 1 : Number(rawNumber);
      if (!Number.isFinite(modelNumber) || modelNumber <= 0) continue;
      models.push({
        modelId,
        category: firstString(entry, 1, 10),
        display: firstString(entry, 11, 19, 1),
        modelNumber,
      });
    }
    if (models.length > 0) return { models, capacity, capacityField };
  }
  return null;
}

interface CachedGeminiWebSession {
  at: string;
  bl: string;
  fSid: string;
  expiresAt: number;
  discovery?: GeminiWebDiscovery | null;
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
  credentials: ExecuteInput["credentials"],
  isPlaywrightMocked = false
): boolean {
  const psd = getProviderSpecificRecord(credentials);
  const transport = typeof psd.transport === "string" ? psd.transport.trim().toLowerCase() : "";
  if (transport === "playwright" || transport === "browser") return false;
  if (transport === "http" || transport === "direct") return true;
  if (typeof psd.endpointUrl === "string" && psd.endpointUrl.trim().length > 0) return true;
  if (typeof psd.atToken === "string" && psd.atToken.trim().length > 0) return true;
  if (typeof psd.modelHeader === "string" && psd.modelHeader.trim().length > 0) return true;
  if (isPlaywrightMocked) return false;
  const lowerModel = (model || "").trim().toLowerCase();
  if (lowerModel.includes("ultra") || lowerModel.endsWith("-http")) return true;
  if (lowerModel.includes("argon") || lowerModel.includes("carbon")) {
    const rawKey = typeof credentials?.apiKey === "string" ? credentials.apiKey : "";
    return !rawKey.startsWith("fake-cookie=");
  }
  return false;
}

export function resolveGeminiWebModelSelector(
  model: string,
  psd: Record<string, unknown> = {}
): GeminiWebModelSelector {
  const normalized = normalizeGeminiWebModelId(model).toLowerCase();
  const kind = resolveGeminiWebModelKind(normalized);
  const fallbackKey =
    kind === "carbon" ? "gemini-4-carbon" : kind === "flash" ? "gemini-3.8-flash" : "gemini-3.1-flash-lite";
  const base = GEMINI_WEB_MODEL_SELECTORS[normalized] ?? GEMINI_WEB_MODEL_SELECTORS[fallbackKey];
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

const ESSENTIAL_GOOGLE_COOKIE_RE =
  /^(__Secure-[13]PSID(?:TS|CC|RTS)?|__Secure-[13]PAPISID|SID|HSID|SSID|APISID|SAPISID|SIDCC)=/;

export function sanitizeGeminiRequestCookie(rawCookie: string): string {
  const cleaned = (rawCookie || "").replace(/[\r\n]+/g, " ").trim();
  if (cleaned.length <= 1024) return cleaned;
  const pairs = cleaned
    .split(";")
    .map((part) => part.trim())
    .filter((part) => ESSENTIAL_GOOGLE_COOKIE_RE.test(part));
  return pairs.length > 0 ? pairs.join("; ") : cleaned;
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
  inner[80] = 1;
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

/**
 * Discover the account's live Gemini Web modes via the `otAQ7b` RPC (same call the web UI
 * makes). Cached on the session for its TTL; returns null on any failure so the caller falls
 * back to the static table.
 */
export async function discoverGeminiWebModels(
  baseUrl: string,
  cookie: string,
  session: CachedGeminiWebSession,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<GeminiWebDiscovery | null> {
  if (session.discovery !== undefined) return session.discovery;
  try {
    const query = new URLSearchParams({
      rpcids: "otAQ7b",
      hl: "en",
      _reqid: String(10000 + Math.floor(Math.random() * 90000)),
      rt: "c",
      "source-path": "/app",
    });
    if (session.bl) query.set("bl", session.bl);
    if (session.fSid) query.set("f.sid", session.fSid);
    const probeHeader: unknown[] = new Array(17).fill(null);
    probeHeader[0] = 1;
    probeHeader[8] = [4, 5, 6, 8];
    probeHeader[16] = GEMINI_WEB_GENERATION_ID;
    const resp = await fetchImpl(`${baseUrl}/_/BardChatUi/data/batchexecute?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: baseUrl,
        Referer: `${baseUrl}/app`,
        "User-Agent": GEMINI_USER_AGENT,
        "X-Same-Domain": "1",
        "x-goog-ext-525001261-jspb": JSON.stringify(probeHeader),
        "x-goog-ext-73010989-jspb": "[0]",
        Cookie: cookie,
      },
      body: new URLSearchParams({
        at: session.at,
        "f.req": '[[["otAQ7b","[]",null,"generic"]]]',
      }).toString(),
      redirect: "manual",
      signal,
    });
    session.discovery = resp.ok ? parseGeminiWebDiscovery(await resp.text()) : null;
  } catch {
    session.discovery = null;
  }
  return session.discovery;
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
  const cleanModel = geminiWebPublicModelId(model);
  let selector = resolveGeminiWebModelSelector(model, psd);
  const hasCustomSelector =
    typeof psd.modelHeader === "string" && psd.modelHeader.trim().length > 0;
  const requestCookie = sanitizeGeminiRequestCookie(cookie);
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
    "x-goog-ext-73010989-jspb": "[0]",
  };

  try {
    if (effectiveSignal.aborted) {
      throw effectiveSignal.reason instanceof Error
        ? effectiveSignal.reason
        : new Error("Request aborted");
    }

    const resolved = await resolveSessionTokens(rawBase, requestCookie, psd, effectiveSignal);
    if ("error" in resolved) {
      return { response: resolved.error, url: streamUrl, headers: {}, transformedBody: body };
    }

    const { session, rotatedPairs } = resolved;
    if (!hasCustomSelector) {
      const discovery = await discoverGeminiWebModels(
        rawBase,
        requestCookie,
        session,
        effectiveSignal
      );
      const live = discovery
        ? pickGeminiWebLiveModel(resolveGeminiWebModelKind(model), discovery.models)
        : null;
      if (live && discovery) {
        selector = {
          header: buildGeminiWebModelHeader(live, discovery.capacity, discovery.capacityField),
          category: live.modelNumber,
        };
        reqHeaders["x-goog-ext-525001261-jspb"] = selector.header;
      } else if (discovery && resolveGeminiWebModelKind(model) === "carbon") {
        return {
          response: buildJsonError(
            503,
            "Gemini 4 Carbon is not available on this Gemini Web account (no Carbon mode in live discovery)."
          ),
          url: streamUrl,
          headers: {},
          transformedBody: body,
        };
      }
    }
    const query = new URLSearchParams({ bl: session.bl, hl: "en", rt: "c" });
    if (session.fSid) query.set("f.sid", session.fSid);
    streamUrl = `${streamUrl}?${query.toString()}`;

    const upstream = await fetch(streamUrl, {
      method: "POST",
      headers: { ...reqHeaders, Cookie: requestCookie },
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
      sessionCache.delete(makeSessionCacheKey(rawBase, requestCookie));
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

/**
 * LMArena / arena.ai session cookie reconstruction and DevTools "Copy as cURL" parser.
 * Supabase SSR splits `arena-auth-prod-v1` across `.0`, `.1`, … chunks.
 */

export const LMARENA_AUTH_COOKIE = "arena-auth-prod-v1";

interface ParsedCookie {
  name: string;
  value: string;
}

export interface ParsedLMArenaSession {
  cookie: string;
  headers: Record<string, string>;
  mode?: string;
  recaptchaV3Token?: string;
}

/**
 * Unescape a shell token from a DevTools "Copy as cURL" snippet (`'...'`, `"..."`, or `$'...'`).
 */
function unquoteShellToken(token: string): string {
  if (token.startsWith("$'") && token.endsWith("'") && token.length >= 3) {
    const inner = token.slice(2, -1);
    return inner.replace(
      /\\(?:([\\'"nrt])|x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4}))/g,
      (_match, simple: string, hex: string, unicode: string) => {
        if (simple === "n") return "\n";
        if (simple === "r") return "\r";
        if (simple === "t") return "\t";
        if (simple) return simple;
        if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
        if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
        return _match;
      }
    );
  }
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) {
    return token.slice(1, -1);
  }
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    return token.slice(1, -1).replace(/\\(["\\$`nrt])/g, (_m, c: string) => {
      if (c === "n") return "\n";
      if (c === "r") return "\r";
      if (c === "t") return "\t";
      return c;
    });
  }
  return token;
}

/**
 * Tokenize a POSIX/Windows DevTools `curl` command without invoking a shell or eval.
 */
function tokenizeCurlCommand(raw: string): string[] {
  const normalized = raw.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  const tokenRe = /\$'(?:\\.|[^'\\])*'|'(?:[^']*)'|"(?:\\.|[^"\\])*"|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(normalized)) !== null) {
    tokens.push(unquoteShellToken(match[0]));
  }
  return tokens;
}

function isCurlCommandInput(raw: string): boolean {
  return /^\s*curl(?:\.exe)?\s+/i.test(raw);
}

const SYNCED_CURL_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "User-Agent",
  "sec-ch-ua": "Sec-Ch-Ua",
  "sec-ch-ua-mobile": "Sec-Ch-Ua-Mobile",
  "sec-ch-ua-platform": "Sec-Ch-Ua-Platform",
  "accept-language": "Accept-Language",
  referer: "Referer",
  origin: "Origin",
};

interface CurlConsumeState {
  cookies: string[];
  headers: Record<string, string>;
  dataPayloads: string[];
}

const CURL_FLAG_ARITY: Readonly<Record<string, "cookie" | "header" | "ua" | "referer" | "data">> = {
  "-b": "cookie",
  "--cookie": "cookie",
  "-H": "header",
  "--header": "header",
  "-A": "ua",
  "--user-agent": "ua",
  "-e": "referer",
  "--referer": "referer",
  "-d": "data",
  "--data": "data",
  "--data-raw": "data",
  "--data-binary": "data",
};

function applyCurlHeaderLine(headerLine: string, state: CurlConsumeState): void {
  const colonIdx = headerLine.indexOf(":");
  if (colonIdx <= 0) return;
  const rawName = headerLine.slice(0, colonIdx).trim().toLowerCase();
  const rawValue = headerLine.slice(colonIdx + 1).trim();
  if (!rawValue) return;
  if (rawName === "cookie") {
    state.cookies.push(rawValue);
    return;
  }
  const canonical = SYNCED_CURL_HEADERS[rawName];
  if (canonical) {
    state.headers[canonical] = rawValue;
  }
}

function applyCurlFlagValue(
  kind: "cookie" | "header" | "ua" | "referer" | "data",
  value: string,
  state: CurlConsumeState
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (kind === "cookie") state.cookies.push(trimmed);
  else if (kind === "header") applyCurlHeaderLine(value, state);
  else if (kind === "ua") state.headers["User-Agent"] = trimmed;
  else if (kind === "referer") state.headers.Referer = trimmed;
  else if (kind === "data") state.dataPayloads.push(value);
}

function extractBodyHints(
  dataPayloads: string[]
): Pick<ParsedLMArenaSession, "mode" | "recaptchaV3Token"> {
  let mode: string | undefined;
  let recaptchaV3Token: string | undefined;
  for (const payload of dataPayloads) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed.mode === "string" && parsed.mode.trim()) {
        mode = parsed.mode.trim();
      }
      const tok = parsed.recaptchaV3Token ?? parsed.recaptchaToken;
      if (typeof tok === "string" && tok.trim()) {
        recaptchaV3Token = tok.trim();
      }
    } catch {
      // Ignore non-JSON body payloads.
    }
  }
  return {
    ...(mode ? { mode } : {}),
    ...(recaptchaV3Token ? { recaptchaV3Token } : {}),
  };
}

/**
 * Parse either a raw `Cookie` header or a DevTools "Copy as cURL" command into
 * reconstructed cookies, matched browser headers, and optional payload hints.
 */
export function parseLMArenaCredentialInput(rawInput: string): ParsedLMArenaSession {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { cookie: "", headers: {} };
  }

  if (!isCurlCommandInput(trimmed)) {
    const withoutPrefix = trimmed.replace(/^cookie\s*:\s*/i, "").trim();
    return {
      cookie: reconstructLMArenaCookie(withoutPrefix),
      headers: {},
    };
  }

  const tokens = tokenizeCurlCommand(trimmed);
  const state: CurlConsumeState = {
    cookies: [],
    headers: {},
    dataPayloads: [],
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    const flagKind = CURL_FLAG_ARITY[tok];
    if (flagKind && i + 1 < tokens.length) {
      applyCurlFlagValue(flagKind, tokens[++i], state);
    }
  }

  const combinedCookie = state.cookies.join("; ");
  const bodyHints = extractBodyHints(state.dataPayloads);
  return {
    cookie: reconstructLMArenaCookie(combinedCookie),
    headers: state.headers,
    ...bodyHints,
  };
}

/**
 * Parse a raw `Cookie:`-style blob (`name=value; name2=value2; …`) into an
 * ordered list of name/value pairs. Whitespace around names is trimmed; values
 * are kept verbatim (they may legitimately contain `=`, e.g. base64 padding).
 */
function parseCookieBlob(blob: string): ParsedCookie[] {
  const stripped = blob.replace(/^cookie\s*:\s*/i, "");
  const pairs: ParsedCookie[] = [];
  for (const part of stripped.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    pairs.push({ name, value });
  }
  return pairs;
}

/**
 * Reconstruct LMArena's `arena-auth-prod-v1` auth cookie from the Supabase SSR
 * chunked form while preserving the original `.0`, `.1`, … chunk pairs so both
 * single-cookie readers and `@supabase/ssr` chunk readers see the exact session.
 *
 * - Non-empty single cookie without chunks → returned unchanged (back-compat).
 * - Chunked cookies → emits `arena-auth-prod-v1=<joined>` AND preserves `.0`, `.1` chunks
 *   alongside `cf_clearance` / other cookies.
 * - Neither single nor chunks → raw blob returned for the missing-cookie path.
 */
export function reconstructLMArenaCookie(rawCookie: string): string {
  if (!rawCookie || !rawCookie.trim()) return rawCookie;
  if (isCurlCommandInput(rawCookie)) {
    return parseLMArenaCredentialInput(rawCookie).cookie;
  }

  const pairs = parseCookieBlob(rawCookie);
  const chunkPrefix = `${LMARENA_AUTH_COOKIE}.`;
  const chunks = new Map<number, string>();
  for (const { name, value } of pairs) {
    if (!name.startsWith(chunkPrefix)) continue;
    const idxRaw = name.slice(chunkPrefix.length);
    if (!/^\d+$/.test(idxRaw)) continue;
    chunks.set(Number(idxRaw), value);
  }

  const existing = pairs.find((p) => p.name === LMARENA_AUTH_COOKIE);
  if (existing && existing.value && chunks.size === 0) return rawCookie;

  const joinedParts: string[] = [];
  const orderedChunkPairs: string[] = [];
  for (let i = 0; chunks.has(i); i++) {
    const chunkVal = chunks.get(i) ?? "";
    joinedParts.push(chunkVal);
    orderedChunkPairs.push(`${chunkPrefix}${i}=${chunkVal}`);
  }
  const joined = joinedParts.join("");
  if (!joined) return rawCookie;

  const preserved = pairs.filter(
    (p) => p.name !== LMARENA_AUTH_COOKIE && !p.name.startsWith(chunkPrefix)
  );
  return [
    `${LMARENA_AUTH_COOKIE}=${joined}`,
    ...orderedChunkPairs,
    ...preserved.map((p) => `${p.name}=${p.value}`),
  ].join("; ");
}

function buildLMArenaCookieFromStoredFields(data: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (name !== LMARENA_AUTH_COOKIE && !name.startsWith(`${LMARENA_AUTH_COOKIE}.`)) {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    pairs.push(`${name}=${value.trim()}`);
  }

  if (pairs.length === 0) return "";
  return reconstructLMArenaCookie(pairs.join("; "));
}

function readRawCredentialSource(credentials: Record<string, unknown>): string {
  const direct = typeof credentials.cookie === "string" ? credentials.cookie.trim() : "";
  if (direct) return direct;
  const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
  if (apiKey) return apiKey;
  const psd = credentials.providerSpecificData;
  if (psd && typeof psd === "object") {
    const nested = (psd as Record<string, unknown>).cookie;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return "";
}

function applyStoredHeaderOverrides(
  target: Record<string, string>,
  source: Record<string, unknown>
): void {
  const ua = source.customUserAgent ?? source.userAgent;
  if (typeof ua === "string" && ua.trim()) {
    target["User-Agent"] = ua.trim();
  }
  if (typeof source.secChUa === "string" && source.secChUa.trim()) {
    target["Sec-Ch-Ua"] = source.secChUa.trim();
  }
  if (typeof source.secChUaPlatform === "string" && source.secChUaPlatform.trim()) {
    target["Sec-Ch-Ua-Platform"] = source.secChUaPlatform.trim();
  }
  if (typeof source.secChUaMobile === "string" && source.secChUaMobile.trim()) {
    target["Sec-Ch-Ua-Mobile"] = source.secChUaMobile.trim();
  }
  if (typeof source.referer === "string" && source.referer.trim()) {
    target.Referer = source.referer.trim();
  }
}

/**
 * Resolve full session metadata (cookie, headers, mode, recaptchaV3Token) from
 * credentials (including pasted "Copy as cURL" commands and `providerSpecificData`).
 */
export function readLMArenaSession(credentials: unknown): ParsedLMArenaSession {
  if (!credentials || typeof credentials !== "object") {
    return { cookie: "", headers: {} };
  }
  const c = credentials as Record<string, unknown>;
  const rawSource = readRawCredentialSource(c);
  const parsed: ParsedLMArenaSession = rawSource
    ? parseLMArenaCredentialInput(rawSource)
    : { cookie: "", headers: {} };

  if (!parsed.cookie) {
    const topLevelChunks = buildLMArenaCookieFromStoredFields(c);
    if (topLevelChunks) {
      parsed.cookie = topLevelChunks;
    } else if (c.providerSpecificData && typeof c.providerSpecificData === "object") {
      parsed.cookie = buildLMArenaCookieFromStoredFields(
        c.providerSpecificData as Record<string, unknown>
      );
    }
  }

  applyStoredHeaderOverrides(parsed.headers, c);
  if (c.providerSpecificData && typeof c.providerSpecificData === "object") {
    const psd = c.providerSpecificData as Record<string, unknown>;
    applyStoredHeaderOverrides(parsed.headers, psd);
    if (typeof psd.mode === "string" && psd.mode.trim()) {
      parsed.mode = psd.mode.trim();
    }
    const psdToken = psd.recaptchaV3Token ?? psd.recaptchaToken;
    if (typeof psdToken === "string" && psdToken.trim()) {
      parsed.recaptchaV3Token = psdToken.trim();
    }
  }
  if (typeof c.mode === "string" && c.mode.trim()) {
    parsed.mode = c.mode.trim();
  }
  const directToken = c.recaptchaV3Token ?? c.recaptchaToken;
  if (typeof directToken === "string" && directToken.trim()) {
    parsed.recaptchaV3Token = directToken.trim();
  }

  return parsed;
}

export function readLMArenaCookie(credentials: unknown): string {
  return readLMArenaSession(credentials).cookie;
}

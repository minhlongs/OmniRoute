/**
 * Custom Executor: MuseWebExecutor
 * Target Path: open-sse/executors/muse-web.ts
 *
 * Production-grade OmniRoute executor for muse.ai / Meta AI personal AI platform.
 * Supports:
 *  1. Direct REST Model API mode (Bearer token sk-... or meta_...)
 *  2. Primary: WebSocket Data Gateway (DGW) with binary Protobuf wire framing
 *  3. Resilient Fallback: GraphQL SSE streaming over HTTP POST (automatic when WS token is missing or WS fails)
 *  4. Multi-turn conversation continuity cache with SHA-256 history prefix anchoring
 *  5. Streaming (SSE) and non-streaming execution with reasoning/thinking delta extraction
 *  6. Emulated tool calling support
 *  7. Multi-account cookie rotation and session pooling
 */

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { getRotatingApiKey } from "../services/apiKeyRotator.ts";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { normalizeSessionCookieHeaders } from "@/lib/providers/webCookieAuth";
import {
  parseMetaAiResponseText,
  readMetaJsonPayloads,
  collectReasoningTexts,
  collectRendererTexts,
  isRecord,
} from "./muse-spark-web/response-parser.ts";

// ─── Constants & Configuration ───────────────────────────────────────────────

const META_AI_GRAPHQL_API =
  process.env.MUSE_WEB_GRAPHQL_URL?.trim() || "https://www.meta.ai/api/graphql";
const META_AI_REST_API =
  process.env.MUSE_WEB_REST_URL?.trim() || "https://api.meta.ai/v1/chat/completions";
const META_AI_DEFAULT_COOKIE = "ecto_1_sess";

// Meta Persisted Query IDs
const META_AI_WARMUP_DOC_ID = "e7f802582dbfed8e181b012e010993eb";
const META_AI_MODE_SWITCH_DOC_ID = "c32bbe999c48e64e855dc63177d5153f";
const META_AI_GRAPHQL_SUBSCRIPTION_DOC_ID = "e7f802582dbfed8e181b012e010993eb";

// Data Gateway (DGW) WebSocket Protocol Constants
const META_WS_APP_ID = "1522763855472543";
const META_WS_APP_VERSION = "1.0.0";
const META_WS_AUTHTYPE = "15:0";
const META_WS_DGW_VERSION = "5";
const META_WS_DGW_UUID = "0";
const META_WS_TIER = "prod";
const META_WS_INTRO_FRAME_TYPE = 0x0f;
const META_WS_PROMPT_FRAME_TYPE = 0x0d;
const META_WS_PROMPT_FRAME_FLAG = 0x80;
const META_AI_ROOT_BRANCH_PATH = "0";
const META_AI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Base64 Captured Protobuf Templates for DGW WebSocket
const META_WS_HOME_TEMPLATE_B64 =
  "CrYGCsQDCiBLQURBQlJBX19IT01FX19VTklGSUVEX0lOUFVUX0JBUhIQMTUyMjc2Mzg1NTQ3MjU0MyInNWE1Yi04ZDRlLWYwNTQtOTllZi1iMmRlLWRiMDItMGQwNS01MmM3KigqJgokOGYxMjliMjUtYzNlMC00NzNiLWFlNzktNWViM2YyNGU1NjRjMAU6C0hVTUFOX0FHRU5UQiIKDzg2NzA1MTMxNDc2NzY5NhIPODY3MDUxMzE0NzY3Njk2UgVFQ1RPMVoRQWJyYSBXZWIgTWFpbiBLZXliCRoDCOgHIgIIAWoITWFjIE9TIFhyCnVzZXJfaW5wdXR6dU1vemlsbGEvNS4wIChNYWNpbnRvc2g7IEludGVsIE1hYyBPUyBYIDEwXzE1XzcpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNDYuMC4wLjAgU2FmYXJpLzUzNy4zNoIBC2Rlc2t0b3Bfd2VimgFHCkBlMmI4OGY5ODQ2Mzc5Y2JjMjY5NjBmYTNhZTFkMjIyMDFkZmIxOWRmNzg5MGFlNmEzYWM4YTI4ODcwYmFjNjgyFQAAAEASFAi4w6XTk4/yARC4w6XTk4/yARgCGgIgASIAKg4Ix6D+ldkzGJ6g/pXZMzIkZWU3YTM1ZWItZGY4Yy00NzkzLWExYzAtMTBhZTQxNGY1ZTZlOgBKBxIFZW4tVVNScgokNTYwN2Y0YzAtYjljZi00ZjZlLWJlYTYtZTc2N2E1OGJhMjhlGiRlMDliN2FhMC1jYzYwLTQyYTktYjk2OS00YzY1YjViZGZlNGIiJDhmMTI5YjI1LWMzZTAtNDczYi1hZTc5LTVlYjNmMjRlNTY0Y3oRIg9BbWVyaWNhL0NoaWNhZ2+CAQOwAQGSAQwKBnN0b2NrcxICCAGSAQ0KB3dlYXRoZXISAggBkgEkCh5tZXRhX2tub3dsZWRnZV9zZWFyY2hfY2Fyb3VzZWwSAggBkgEiChxtZXRhX2NhdGFsb2dfc2VhcmNoX2Nhcm91c2VsEgIIAZIBEwoNbWVkaWFfZ2FsbGVyeRICCAGiAQEDEpIBCmEKJGFiOWRkNzg5LWRlOGQtNDc5MS05ODE1LWI5YjBmMTU1MDdiNBI3CiQ4ZjEyOWIyNS1jM2UwLTQ3M2ItYWU3OS01ZWIzZjI0ZTU2NGMQyKD+ldkzGKbcxozB/KuyZygBEihIZWxsbyB0aGlzIGlzIGFub3RoZXIgdGVzdCBvZiB5b3VyIHBvd2VyIgMKATA=";
const META_WS_CHAT_TEMPLATE_B64 =
  "CrIGCsADCiBLQURBQlJBX19DSEFUX19VTklGSUVEX0lOUFVUX0JBUhIQMTUyMjc2Mzg1NTQ3MjU0MyInNWE1Yi04ZDRlLWYwNTQtOTllZi1iMmRlLWRiMDItMGQwNS01MmM3KigqJgokYjA4Mzg1YTYtNWE1My00ZjE0LTk2NmUtMzQ3ZjI4MDg4NDU0MAU6C0hVTUFOX0FHRU5UQiIKDzg2NzA1MTMxNDc2NzY5NhIPODY3MDUxMzE0NzY3Njk2UgVFQ1RPMVoRQWJyYSBXZWIgTWFpbiBLZXliBRoDCOgHaghNYWMgT1MgWHIKdXNlcl9pbnB1dHp1TW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Ni4wLjAuMCBTYWZhcmkvNTM3LjM2ggELZGVza3RvcF93ZWKaAUcKQGUyYjg4Zjk4NDYzNzljYmMyNjk2MGZhM2FlMWQyMjIwMWRmYjE5ZGY3ODkwYWU2YTNhYzhhMjg4NzBiYWM2ODIVAAAAQBIUCLjDpdOTj/IBELjDpdOTj/IBGAIaAiABIgAqDgikgvuW2TMYoYL7ltkzMiRjNmI1ZDI2MS02NjI0LTQ5YWYtOTBjNy0wOWI0NWMwYTZiZWY6AEoHEgVlbi1VU1JyCiQxZDNjZGQzYy1jYTFhLTRlMDItODk1My1kZTBiYTM0NzI5ODkaJDcxODNhMzM0LTFiNWEtNGQyNi1iMjcxLWJjY2Y1NDY2NmJiZiIkYjA4Mzg1YTYtNWE1My00ZjE0LTk2NmUtMzQ3ZjI4MDg4NDU0ehEiD0FtZXJpY2EvQ2hpY2Fnb4IBA7ABAZIBDAoGc3RvY2tzEgIIAZIBDQoHd2VhdGhlchICCAGSASQKHm1ldGFfa25vd2xlZGdlX3NlYXJjaF9jYXJvdXNlbBICCAGSASIKHG1ldGFfY2F0YWxvZ19zZWFyY2hfY2Fyb3VzZWwSAggBkgETCg1tZWRpYV9nYWxsZXJ5EgIIAaIBAQMSlgEKfAokMTc4MDVmYjEtOTY3Zi00YmYyLTlmMjctOWRhYmRhMzYyMTJkEjcKJGIwODM4NWE2LTVhNTMtNGYxNC05NjZlLTM0N2YyODA4ODQ1NBCkgvuW2TMYxN23xoT2rbJnIhtlLjAwcHlKMUtxa3BHTmg5Sk9oWElNdnJRWlYSEWZvbGxvdyB1cCBwcm9iZSAyIgMKATI=";

type MuseModelInfo = {
  mode: string;
  isThinking: boolean;
};

const MODEL_MAP: Record<string, MuseModelInfo> = {
  muse: { mode: "think_fast", isThinking: false },
  "muse-spark": { mode: "think_fast", isThinking: false },
  "muse-spark-thinking": { mode: "think_hard", isThinking: true },
  "muse-spark-contemplating": { mode: "think_hard", isThinking: true },
  "muse-wonder": { mode: "think_fast", isThinking: true },
  "muse-agent": { mode: "think_hard", isThinking: true },
};

function getMuseModelInfo(model: string): MuseModelInfo {
  return MODEL_MAP[model] || MODEL_MAP["muse-spark"];
}

// ─── Protobuf Serialization Engine ──────────────────────────────────────────

type ProtoField = {
  number: number;
  wireType: number;
  value: Uint8Array | number | bigint;
};

function encodeVarint(value: number): Uint8Array {
  let v = BigInt(value);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return new Uint8Array(out);
}

function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let shift = 0;
  let value = 0;
  let off = offset;
  while (true) {
    const byte = data[off++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value >>> 0, off];
    shift += 7;
    if (shift > 63) throw new Error("Varint overflow");
  }
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [tag, next] = decodeVarint(data, offset);
    offset = next;
    const number = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const [value, n] = decodeVarint(data, offset);
      offset = n;
      fields.push({ number, wireType, value });
    } else if (wireType === 2) {
      const [len, n] = decodeVarint(data, offset);
      offset = n;
      const value = data.subarray(offset, offset + len);
      offset += len;
      fields.push({ number, wireType, value });
    } else if (wireType === 1) {
      const value = data.subarray(offset, offset + 8);
      offset += 8;
      fields.push({ number, wireType, value });
    } else if (wireType === 5) {
      const value = data.subarray(offset, offset + 4);
      offset += 4;
      fields.push({ number, wireType, value });
    } else {
      throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }
  return fields;
}

function serializeProtoFields(fields: ProtoField[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of fields) {
    const tag = (f.number << 3) | f.wireType;
    chunks.push(encodeVarint(tag));
    if (f.wireType === 0) {
      chunks.push(encodeVarint(Number(f.value)));
    } else if (f.wireType === 2 && f.value instanceof Uint8Array) {
      chunks.push(encodeVarint(f.value.length));
      chunks.push(f.value);
    } else if (f.value instanceof Uint8Array) {
      chunks.push(f.value);
    }
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    result.set(c, off);
    off += c.length;
  }
  return result;
}

function traverseAndMutate(
  data: Uint8Array,
  path: number[],
  mutate: (field: ProtoField) => ProtoField
): Uint8Array {
  if (path.length === 0) return data;
  const fields = parseProtoFields(data);
  const targetNumber = path[0];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].number === targetNumber) {
      if (path.length === 1) {
        fields[i] = mutate(fields[i]);
      } else if (fields[i].wireType === 2 && fields[i].value instanceof Uint8Array) {
        fields[i].value = traverseAndMutate(fields[i].value as Uint8Array, path.slice(1), mutate);
      }
      break;
    }
  }
  return serializeProtoFields(fields);
}

// ─── Frame Building & Base62 Packing ────────────────────────────────────────

function writeU24Le(value: number, target: Uint8Array, offset: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
}

function encodeBase62(value: bigint, padLength: number): string {
  let remaining = value;
  let encoded = "";
  while (remaining > 0n) {
    encoded = BASE62_ALPHABET[Number(remaining % 62n)] + encoded;
    remaining /= 62n;
  }
  return encoded.padStart(padLength, "0");
}

function randomBigInt(byteLength: number): bigint {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function generateMetaConversationId(): string {
  const timestamp = BigInt(Date.now()) & ((1n << 44n) - 1n);
  const random = randomBigInt(8) & ((1n << 64n) - 1n);
  const packed = (timestamp << 64n) | random;
  return `c.${encodeBase62(packed, 19)}`;
}

function buildWsIntroFrame(conversationId: string): Uint8Array {
  const payload = JSON.stringify({
    "x-dgw-app-x-ecto-conversation-id": conversationId,
    "x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
  });
  const payloadBytes = Buffer.from(payload, "utf-8");
  const frame = new Uint8Array(6 + payloadBytes.length);
  frame[0] = META_WS_INTRO_FRAME_TYPE;
  frame[1] = 0x00;
  frame[2] = 0x00;
  writeU24Le(payloadBytes.length, frame, 3);
  frame.set(payloadBytes, 6);
  return frame;
}

function buildWsPromptFrame(
  prompt: string,
  conversationId: string,
  options: { templateB64: string; requestId: string }
): Uint8Array {
  let protoBytes = Buffer.from(options.templateB64, "base64");
  const encoder = new TextEncoder();

  // Inject conversationId
  protoBytes = Buffer.from(
    traverseAndMutate(protoBytes, [1, 1, 5], (field) => ({
      ...field,
      value: encoder.encode(conversationId),
    }))
  );

  // Inject prompt
  protoBytes = Buffer.from(
    traverseAndMutate(protoBytes, [2, 2], (field) => ({
      ...field,
      value: encoder.encode(prompt),
    }))
  );

  const outerJson = JSON.stringify({
    "req-id": options.requestId,
    payload: protoBytes.toString("base64"),
  });
  const jsonBytes = Buffer.from(outerJson, "utf-8");

  const bodyLength = 2 + jsonBytes.length;
  const frame = new Uint8Array(6 + bodyLength);
  frame[0] = META_WS_PROMPT_FRAME_TYPE;
  frame[1] = 0x00;
  frame[2] = 0x00;
  writeU24Le(bodyLength, frame, 3);
  frame[6] = 0x00; // messageSeq
  frame[7] = META_WS_PROMPT_FRAME_FLAG;
  frame.set(jsonBytes, 8);
  return frame;
}

// ─── Conversation Continuity Cache ──────────────────────────────────────────

type CachedConversation = {
  conversationId: string;
  branchPath: string;
  expiresAt: number;
};

const CONVERSATION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONVERSATION_CACHE_MAX = 5000;
const conversationCache = new Map<string, CachedConversation>();

function pruneConversationCache(): void {
  const now = Date.now();
  for (const [key, value] of conversationCache.entries()) {
    if (value.expiresAt <= now) {
      conversationCache.delete(key);
    }
  }
  if (conversationCache.size > CONVERSATION_CACHE_MAX) {
    const oldestKeys = Array.from(conversationCache.keys()).slice(0, 1000);
    for (const k of oldestKeys) conversationCache.delete(k);
  }
}

function makeConversationCacheKey(
  connectionId: string,
  model: string,
  historyPrefix: Array<{ role: string; content: string }>
): string {
  const hash = createHash("sha256");
  hash.update(connectionId).update("\x1f").update(model).update("\x1f");
  for (const msg of historyPrefix) {
    hash.update(msg.role).update("\x1f").update(msg.content).update("\x1e");
  }
  return hash.digest("hex");
}

function lookupCachedConversation(cacheKey: string): CachedConversation | null {
  pruneConversationCache();
  const entry = conversationCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    conversationCache.delete(cacheKey);
    return null;
  }
  return entry;
}

// ─── History Parser ─────────────────────────────────────────────────────────

type NormalizedMessage = { role: string; content: string };
type ParsedHistory = {
  foldedPrompt: string;
  latestUserContent: string;
  lastAssistantIndex: number;
  normalized: NormalizedMessage[];
};

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "input_text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

function parseOpenAIMessages(messages: Array<Record<string, unknown>>): ParsedHistory {
  const extracted: NormalizedMessage[] = [];

  for (const message of messages) {
    let role = String(message.role || "user");
    if (role === "developer") role = "system";
    const content = extractMessageText(message.content);
    if (!content) continue;
    extracted.push({ role, content });
  }

  if (extracted.length === 0) {
    return { foldedPrompt: "", latestUserContent: "", lastAssistantIndex: -1, normalized: [] };
  }

  let lastUserIndex = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  let lastAssistantIndex = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const foldedPrompt = extracted
    .map((message, index) => {
      if (index === lastUserIndex) return message.content;
      return `${message.role}: ${message.content}`;
    })
    .join("\n\n")
    .trim();

  const latestUserContent = lastUserIndex >= 0 ? extracted[lastUserIndex].content : "";
  return { foldedPrompt, latestUserContent, lastAssistantIndex, normalized: extracted };
}

// ─── WebSocket Execution Engine ─────────────────────────────────────────────

type WsChatResult = {
  content: string;
  deltas: string[];
  reasoningContent: string;
  reasoningDeltas: string[];
  error?: string;
  status?: number;
};

let WebSocketCtor: typeof WebSocket = WebSocket;

export function __setMuseSparkWebSocketForTesting(ctor: typeof WebSocket): () => void {
  const previous = WebSocketCtor;
  WebSocketCtor = ctor;
  return () => {
    WebSocketCtor = previous;
  };
}

function buildWsUrl(authorization: string, requestId: string): string {
  const params = new URLSearchParams({
    "x-dgw-appid": META_WS_APP_ID,
    "x-dgw-appversion": META_WS_APP_VERSION,
    "x-dgw-authtype": META_WS_AUTHTYPE,
    "x-dgw-version": META_WS_DGW_VERSION,
    "x-dgw-uuid": META_WS_DGW_UUID,
    "x-dgw-tier": META_WS_TIER,
    Authorization: authorization,
    "x-dgw-app-origin": "meta.ai",
    "x-dgw-app-clippy-request-id": requestId,
    "x-dgw-app-clippy-async": "true",
  });
  return `wss://gateway.meta.ai/ws/clippy?${params.toString()}`;
}

async function executeWsChat(
  prompt: string,
  conversationId: string,
  authorization: string,
  cookieHeader: string,
  templateB64: string,
  signal?: AbortSignal | null
): Promise<WsChatResult> {
  const requestId = randomUUID();
  const wsUrl = buildWsUrl(authorization, requestId);

  return new Promise((resolve) => {
    const ws = new WebSocketCtor(wsUrl, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": META_AI_USER_AGENT,
        Origin: "https://meta.ai",
      },
    });

    let settled = false;
    let fullContent = "";
    const deltas: string[] = [];
    let fullReasoning = "";
    const reasoningDeltas: string[] = [];
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const finish = (result: WsChatResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const fail = (error: string, status = 502) =>
      finish({ content: "", deltas: [], reasoningContent: "", reasoningDeltas: [], error, status });

    timeout = setTimeout(() => fail("Meta AI WebSocket timed out", 504), 30000);
    abortHandler = () => fail("Request aborted", 499);
    signal?.addEventListener("abort", abortHandler, { once: true });

    ws.on("open", () => {
      try {
        ws.send(buildWsIntroFrame(conversationId));
        ws.send(buildWsPromptFrame(prompt, conversationId, { templateB64, requestId }));
      } catch (err) {
        fail(
          `Failed to send WebSocket frames: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        let raw = "";
        if (typeof data === "string") {
          raw = data;
        } else if (Buffer.isBuffer(data)) {
          raw = data.toString("utf-8");
        } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
          raw = new TextDecoder().decode(data);
        }
        if (!raw) return;

        const payloads = readMetaJsonPayloads(raw);
        for (const payload of payloads) {
          const seen = new Set<string>();
          const rTexts = collectReasoningTexts(payload, seen);
          if (rTexts.length > 0) {
            const rChunk = rTexts.join("");
            reasoningDeltas.push(rChunk);
            fullReasoning += rChunk;
          }

          const cTexts = collectRendererTexts(payload, seen);
          if (cTexts.length > 0) {
            const cChunk = cTexts.join("");
            deltas.push(cChunk);
            fullContent += cChunk;
          }
        }
      } catch {
        /* ignore parse errors in individual frames */
      }
    });

    ws.on("close", () => {
      if (!settled) {
        finish({
          content: fullContent,
          deltas: deltas.length > 0 ? deltas : fullContent ? [fullContent] : [],
          reasoningContent: fullReasoning,
          reasoningDeltas,
        });
      }
    });

    ws.on("error", (err: Error) => {
      const msg = err.message.toLowerCase();
      const isAuth = /auth|401|forbidden|cookie/.test(msg);
      fail(
        isAuth
          ? `Meta AI session rejected: ${err.message}. Your ecto_1_sess cookie or ecto1: token may be expired.`
          : `Meta AI gateway connection error: ${err.message}`,
        isAuth ? 401 : 502
      );
    });
  });
}

// ─── GraphQL HTTP / SSE Fallback Engine ──────────────────────────────────────

async function executeGraphqlFallback(
  prompt: string,
  conversationId: string,
  model: string,
  cookieHeader: string,
  signal?: AbortSignal | null
): Promise<WsChatResult> {
  const modelInfo = getMuseModelInfo(model);

  // Warmup registration
  try {
    await fetch(META_AI_GRAPHQL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookieHeader,
        Origin: "https://meta.ai",
        "User-Agent": META_AI_USER_AGENT,
      },
      body: JSON.stringify({
        doc_id: META_AI_WARMUP_DOC_ID,
        variables: {
          conversationId,
          isNewConversation: true,
        },
      }),
      signal: signal ?? undefined,
    });
  } catch {
    // Continue even if warmup has non-critical issue
  }

  // Mode switch if thinking
  if (modelInfo.isThinking) {
    try {
      await fetch(META_AI_GRAPHQL_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: cookieHeader,
          Origin: "https://meta.ai",
          "User-Agent": META_AI_USER_AGENT,
        },
        body: JSON.stringify({
          doc_id: META_AI_MODE_SWITCH_DOC_ID,
          variables: {
            conversationId,
            mode: "think_hard",
          },
        }),
        signal: signal ?? undefined,
      });
    } catch {
      // ignore
    }
  }

  // Stream execution via GraphQL subscription
  const variables = {
    conversationId,
    message: {
      sensitive_string_value: prompt,
    },
    clientMutationId: randomUUID(),
  };

  const res = await fetch(META_AI_GRAPHQL_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, multipart/mixed, application/json",
      Cookie: cookieHeader,
      Origin: "https://meta.ai",
      Referer: "https://meta.ai/",
      "User-Agent": META_AI_USER_AGENT,
      "X-ASBD-ID": "129477",
      "X-FB-Friendly-Name": "useEctoSendMessageSubscription",
    },
    body: JSON.stringify({
      doc_id: META_AI_GRAPHQL_SUBSCRIPTION_DOC_ID,
      variables,
    }),
    signal: signal ?? undefined,
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      content: "",
      deltas: [],
      reasoningContent: "",
      reasoningDeltas: [],
      error: `GraphQL SSE fallback failed: HTTP ${res.status}: ${errorText}`,
      status: res.status,
    };
  }

  const responseText = await res.text();
  const parsed = parseMetaAiResponseText(responseText, modelInfo.isThinking);

  return {
    content: parsed.content,
    deltas: parsed.deltas.length > 0 ? parsed.deltas : parsed.content ? [parsed.content] : [],
    reasoningContent: parsed.reasoningContent,
    reasoningDeltas: parsed.reasoningDeltas,
    error: parsed.errorMessage || undefined,
  };
}

// ─── Helpers: Response Streaming and Formatting ─────────────────────────────

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function buildStreamingResponse(
  deltas: string[],
  reasoningDeltas: string[],
  model: string,
  id: string,
  created: number
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // 1. Initial role chunk
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })
        )
      );

      // 2. Reasoning chunks
      for (const rDelta of reasoningDeltas) {
        if (!rDelta) continue;
        controller.enqueue(
          encoder.encode(
            sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { reasoning_content: rDelta }, finish_reason: null }],
            })
          )
        );
      }

      // 3. Content chunks
      for (const cDelta of deltas) {
        if (!cDelta) continue;
        controller.enqueue(
          encoder.encode(
            sseChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: cDelta }, finish_reason: null }],
            })
          )
        );
      }

      // 4. Finish chunk + DONE
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        )
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function buildNonStreamingResponse(
  content: string,
  reasoningContent: string,
  model: string,
  id: string,
  created: number
): Response {
  const completionTokens = Math.max(1, Math.ceil((content || "").length / 4));
  const reasoningTokens = Math.max(0, Math.ceil((reasoningContent || "").length / 4));
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: {
        prompt_tokens: completionTokens,
        completion_tokens: completionTokens + reasoningTokens,
        total_tokens: completionTokens * 2 + reasoningTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function buildErrorResponse(status: number, message: string, code?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: sanitizeErrorMessage(message),
        type: "upstream_error",
        ...(code ? { code } : {}),
      },
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

// ─── Direct Meta Model REST API Driver ──────────────────────────────────────

async function executeDirectModelApi(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal | null
): Promise<Response> {
  return fetch(META_AI_REST_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(body),
    signal: signal ?? undefined,
  });
}

// ─── Main Executor Implementation ───────────────────────────────────────────

export class MuseWebExecutor extends BaseExecutor {
  constructor() {
    super("muse-web", { id: "muse", baseUrl: META_AI_GRAPHQL_API });
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders: _upstreamExtraHeaders,
  }: ExecuteInput) {
    const bodyObj = (body || {}) as Record<string, unknown>;
    const messages = bodyObj.messages as Array<Record<string, unknown>> | undefined;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        response: buildErrorResponse(400, "Missing or empty messages array", "invalid_request"),
        url: META_AI_GRAPHQL_API,
        headers: {},
        transformedBody: body,
      };
    }

    const rawApiKey = (credentials.apiKey || "").trim();

    // ── Mode 1: Direct Meta Model REST API (Bearer token) ───────────────────
    if (rawApiKey.startsWith("sk-") || rawApiKey.startsWith("meta_")) {
      log?.info?.("MUSE-WEB", "Routing request to Direct Meta Model REST API");
      const restResponse = await executeDirectModelApi(bodyObj, rawApiKey, signal);
      return {
        response: restResponse,
        url: META_AI_REST_API,
        headers: { Authorization: `Bearer ${rawApiKey}` },
        transformedBody: bodyObj,
      };
    }

    // ── Mode 2 & 3: Web Session Credential Resolution ───────────────────────
    let authorization = "";
    if (typeof credentials.providerSpecificData?.authorization === "string") {
      authorization = credentials.providerSpecificData.authorization.trim();
    } else {
      const match = rawApiKey.match(/ecto1:[^\s;]+/i);
      if (match) authorization = match[0].trim();
    }

    // Resolve Cookie Pool
    const extraCookieValues = Array.isArray(credentials.providerSpecificData?.extraApiKeys)
      ? credentials.providerSpecificData.extraApiKeys.filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0
        )
      : [];
    const normalizedPool = normalizeSessionCookieHeaders(
      [rawApiKey, ...extraCookieValues],
      META_AI_DEFAULT_COOKIE
    );
    const cookieHeader =
      normalizedPool.length > 1 && credentials.connectionId
        ? getRotatingApiKey(credentials.connectionId, normalizedPool[0], normalizedPool.slice(1))
        : normalizedPool[0] || "";

    if (!cookieHeader && !authorization) {
      return {
        response: buildErrorResponse(
          401,
          "Missing ecto_1_sess cookie or Meta API key for Muse. " +
            "Provide your session cookie or API key in credentials.",
          "missing_cookie"
        ),
        url: META_AI_GRAPHQL_API,
        headers: {},
        transformedBody: body,
      };
    }

    // Tool calling preparation
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      bodyObj,
      messages as Array<{ role: string; content: unknown }>
    );

    // Continuity cache lookup
    const parsedHistory = parseOpenAIMessages(effectiveMessages);
    if (!parsedHistory.foldedPrompt) {
      return {
        response: buildErrorResponse(
          400,
          "Empty prompt query after message extraction",
          "invalid_request"
        ),
        url: META_AI_GRAPHQL_API,
        headers: {},
        transformedBody: body,
      };
    }

    let cacheKey: string | null = null;
    if (parsedHistory.lastAssistantIndex >= 0 && credentials.connectionId) {
      cacheKey = makeConversationCacheKey(
        credentials.connectionId,
        model,
        parsedHistory.normalized.slice(0, parsedHistory.lastAssistantIndex + 1)
      );
    }

    const cached = cacheKey ? lookupCachedConversation(cacheKey) : null;
    const conversationId = cached ? cached.conversationId : generateMetaConversationId();
    const isNew = !cached;
    const prompt =
      cached && parsedHistory.latestUserContent
        ? parsedHistory.latestUserContent
        : parsedHistory.foldedPrompt;
    const templateB64 = cached ? META_WS_CHAT_TEMPLATE_B64 : META_WS_HOME_TEMPLATE_B64;

    let chatResult: WsChatResult;

    // Decide transport:
    // If authorization token (ecto1:...) is present -> Attempt Primary: WebSocket DGW
    // If authorization is missing -> Directly use Resilient Secondary: GraphQL SSE Fallback
    if (authorization) {
      log?.info?.(
        "MUSE-WEB",
        `Executing prompt via WebSocket DGW (convId: ${conversationId}, isNew: ${isNew})`
      );
      chatResult = await executeWsChat(
        prompt,
        conversationId,
        authorization,
        cookieHeader,
        templateB64,
        signal
      );

      // If WebSocket failed or timed out, automatically fall back to GraphQL SSE
      if (chatResult.error) {
        log?.warn?.(
          "MUSE-WEB",
          `WebSocket DGW failed: ${chatResult.error}. Initiating automatic GraphQL SSE fallback.`
        );
        const fallbackResult = await executeGraphqlFallback(
          prompt,
          conversationId,
          model,
          cookieHeader,
          signal
        );
        if (!fallbackResult.error && (fallbackResult.content || fallbackResult.deltas.length > 0)) {
          chatResult = fallbackResult;
        }
      }
    } else {
      log?.info?.(
        "MUSE-WEB",
        `No ecto1: WS token found. Executing prompt directly via GraphQL SSE (convId: ${conversationId})`
      );
      chatResult = await executeGraphqlFallback(
        prompt,
        conversationId,
        model,
        cookieHeader,
        signal
      );
    }

    if (chatResult.error || (!chatResult.content && chatResult.deltas.length === 0)) {
      if (cacheKey) conversationCache.delete(cacheKey);
      const errStatus = chatResult.status || (chatResult.error?.includes("401") ? 401 : 502);
      return {
        response: buildErrorResponse(
          errStatus,
          chatResult.error || "Muse returned empty completion content",
          "muse_upstream_error"
        ),
        url: META_AI_GRAPHQL_API,
        headers: {},
        transformedBody: body,
      };
    }

    // Cache updated conversation continuity
    if (credentials.connectionId) {
      const nextNormalized = [
        ...parsedHistory.normalized,
        { role: "assistant", content: chatResult.content },
      ];
      const nextCacheKey = makeConversationCacheKey(
        credentials.connectionId,
        model,
        nextNormalized
      );
      conversationCache.set(nextCacheKey, {
        conversationId,
        branchPath: META_AI_ROOT_BRANCH_PATH,
        expiresAt: Date.now() + CONVERSATION_CACHE_TTL_MS,
      });
    }

    const id = `chatcmpl-muse-web-${randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const deltas = chatResult.deltas.length > 0 ? chatResult.deltas : [chatResult.content];

    let response = stream
      ? new Response(
          buildStreamingResponse(deltas, chatResult.reasoningDeltas, model, id, created),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          }
        )
      : buildNonStreamingResponse(
          chatResult.content,
          chatResult.reasoningContent,
          model,
          id,
          created
        );

    // Emulated tool calling post-processor
    if (hasTools && !stream) {
      const bodyText = await (response as Response).text();
      try {
        const json = JSON.parse(bodyText);
        const rawContent = json?.choices?.[0]?.message?.content || "";
        const { content, toolCalls, finishReason } = buildToolAwareResult(
          rawContent,
          requestedTools,
          "muse"
        );
        if (toolCalls) {
          json.choices[0].message = { role: "assistant", content: null, tool_calls: toolCalls };
          json.choices[0].finish_reason = finishReason;
        } else {
          json.choices[0].message.content = content;
        }
        response = new Response(JSON.stringify(json), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      } catch {
        /* retain original response */
      }
    }

    return {
      response,
      url: META_AI_GRAPHQL_API,
      headers: { "Content-Type": "application/json" },
      transformedBody: body,
    };
  }
}

export default MuseWebExecutor;

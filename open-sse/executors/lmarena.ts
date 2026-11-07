/**
 * LMArenaExecutor — Arena (formerly LMArena) web-session provider.
 *
 * Routes requests through arena.ai create-evaluation with session cookies
 * (supporting both raw Cookie headers and DevTools "Copy as cURL" inputs from
 * https://arena.ai/text/direct). Upstream sits behind Cloudflare; traffic goes
 * through tls-client-node Chrome impersonation first (see services/lmarenaTlsClient.ts),
 * with an opt-in fallback to `browserPool.ts` when `OMNIROUTE_BROWSER_POOL=on`.
 *
 * Helpers: open-sse/executors/lmarena/{cookie,models,stream,response,browserTransport}.ts
 */
import { v7 as uuidv7 } from "uuid";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { tlsFetchLMArena, TlsClientUnavailableError } from "../services/lmarenaTlsClient.ts";
import {
  parseLMArenaCredentialInput,
  readLMArenaCookie,
  readLMArenaSession,
  reconstructLMArenaCookie,
  type ParsedLMArenaSession,
} from "./lmarena/cookie.ts";
import {
  LMARENA_DIRECT_URL,
  LMARENA_STREAM_URL,
  LMARENA_USER_AGENT,
  buildLmarenaBrowserHeaders,
  markLMArenaCatalogModelDead,
  normalizeLMArenaModelsForCatalog,
  parseLMArenaInitialModels,
  pickLMArenaModelId,
  resolveLMArenaModelId,
  type LMArenaModelMetadata,
} from "./lmarena/models.ts";
import { formatArenaPrompt, parseArenaSSE } from "./lmarena/stream.ts";
import {
  buildArenaUpstreamHttpResponse,
  createOpenAIArenaStream,
  handleNonStreamingArenaResponse,
  mapFailedTlsResult,
  mapNetworkError,
  mapTlsUnavailable,
  missingCookieResult,
} from "./lmarena/response.ts";
import {
  __setLMArenaBrowserFallbackOverrideForTesting,
  fetchLMArenaViaBrowserPool,
  isLMArenaBrowserFallbackEnabled,
} from "./lmarena/browserTransport.ts";

export {
  reconstructLMArenaCookie,
  parseLMArenaCredentialInput,
  readLMArenaSession,
  normalizeLMArenaModelsForCatalog,
  parseLMArenaInitialModels,
  pickLMArenaModelId,
  parseArenaSSE,
  markLMArenaCatalogModelDead,
  LMARENA_USER_AGENT,
  LMARENA_DIRECT_URL,
  __setLMArenaBrowserFallbackOverrideForTesting,
};
export { clearLMArenaDeadCatalogModels } from "./lmarena/models.ts";
export type { LMArenaModelMetadata, ParsedLMArenaSession };

interface OpenAIMessage {
  role?: string;
  content?: unknown;
}

/** Optional browser-issued reCAPTCHA v3 token (operator-supplied or extracted from cURL). */
function readRecaptchaToken(credentials: unknown, body: unknown): string | null {
  const session = readLMArenaSession(credentials);
  if (session.recaptchaV3Token) return session.recaptchaV3Token;
  const fromObj = (v: unknown): string | null => {
    if (!v || typeof v !== "object") return null;
    const rec = v as Record<string, unknown>;
    const direct = rec.recaptchaV3Token ?? rec.recaptchaToken;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const psd = rec.providerSpecificData;
    if (psd && typeof psd === "object") {
      const nested = psd as Record<string, unknown>;
      const t = nested.recaptchaV3Token ?? nested.recaptchaToken;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
    return null;
  };
  return fromObj(credentials) ?? fromObj(body);
}

function readEvaluationMode(credentials: unknown, body: unknown): string {
  const session = readLMArenaSession(credentials);
  if (session.mode) return session.mode;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.arenaMode === "string" && b.arenaMode.trim()) {
      return b.arenaMode.trim();
    }
  }
  return "direct-battle";
}

export class LMArenaExecutor extends BaseExecutor {
  constructor(providerConfig = {}) {
    super("lmarena", { format: "openai", ...providerConfig });
  }

  // Public to match BaseExecutor.buildUrl — a subclass may widen visibility but not
  // narrow it. This was masked behind the buildHeaders TS2416 until that one cleared.
  buildUrl(_model: string, _credentials: unknown): string {
    return LMARENA_STREAM_URL;
  }

  protected buildRequestHeaders(
    _model: string,
    credentials: unknown,
    _body: unknown
  ): Record<string, string> {
    const session = readLMArenaSession(credentials);
    const headers = buildLmarenaBrowserHeaders({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...session.headers,
    });
    if (session.cookie) headers.Cookie = session.cookie;
    return headers;
  }

  transformRequest(body: unknown, model: string, credentials?: unknown): unknown {
    const openaiBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const messages = Array.isArray(openaiBody.messages)
      ? (openaiBody.messages as OpenAIMessage[])
      : [];
    return {
      id: uuidv7(),
      mode: readEvaluationMode(credentials, body),
      modelAId: model,
      userMessageId: uuidv7(),
      modelAMessageId: uuidv7(),
      userMessage: {
        content: formatArenaPrompt(messages),
        experimental_attachments: [],
        metadata: {},
      },
      modality: "chat",
      recaptchaV3Token: readRecaptchaToken(credentials, body),
    };
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal, log } = input;
    const url = this.buildUrl(model, credentials);
    const headers = this.buildRequestHeaders(model, credentials, body);
    const cookie = readLMArenaCookie(credentials);

    if (!cookie) {
      return missingCookieResult(url, headers, this.transformRequest(body, model, credentials));
    }

    const arenaModelId = await resolveLMArenaModelId(model, log);
    const transformedBody = this.transformRequest(body, arenaModelId, credentials) as Record<
      string,
      unknown
    >;

    log?.info?.(
      "LMArenaExecutor",
      arenaModelId === model
        ? `Executing request for model: ${model}`
        : `Executing request for model: ${model} (${arenaModelId})`
    );

    try {
      return await this.dispatchTls(url, headers, transformedBody, {
        model,
        arenaModelId,
        stream: !!stream,
        credentials,
        cookie,
        signal,
        log,
      });
    } catch (error) {
      if (error instanceof TlsClientUnavailableError) {
        log?.error?.("LMArenaExecutor", `TLS client unavailable: ${error.message}`);
        return mapTlsUnavailable(error, url, headers, transformedBody);
      }
      const message = error instanceof Error ? error.message : String(error);
      log?.error?.("LMArenaExecutor", `Request failed: ${message}`);
      return mapNetworkError(message, url, headers, transformedBody);
    }
  }

  private async dispatchTls(
    url: string,
    headers: Record<string, string>,
    transformedBody: Record<string, unknown>,
    ctx: {
      model: string;
      arenaModelId: string;
      stream: boolean;
      credentials?: unknown;
      cookie: string;
      signal?: AbortSignal;
      log?: ExecuteInput["log"];
    }
  ) {
    const serializedBody = JSON.stringify(transformedBody);
    let tlsResult = await tlsFetchLMArena(url, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: ctx.signal,
      stream: ctx.stream,
      streamEofSymbol: "__OMNIROUTE_LMARENA_EOF_NEVER__",
    });

    if (tlsResult.status === 403 && isLMArenaBrowserFallbackEnabled(ctx.credentials)) {
      try {
        ctx.log?.info?.(
          "LMArenaExecutor",
          "Direct TLS returned 403; attempting browser-pool fallback on arena.ai/text/direct"
        );
        tlsResult = await fetchLMArenaViaBrowserPool({
          url,
          cookieString: ctx.cookie,
          headers,
          body: serializedBody,
          signal: ctx.signal,
        });
      } catch (browserErr) {
        const msg = browserErr instanceof Error ? browserErr.message : String(browserErr);
        ctx.log?.warn?.("LMArenaExecutor", `Browser fallback failed: ${msg}`);
      }
    }

    const failed = mapFailedTlsResult({
      status: tlsResult.status,
      text: tlsResult.text,
      hasRecaptcha: transformedBody.recaptchaV3Token != null,
      model: ctx.model,
      arenaModelId: ctx.arenaModelId,
      url,
      headers,
      transformedBody,
    });
    if (failed) return failed;

    const upstream = buildArenaUpstreamHttpResponse({
      stream: ctx.stream,
      status: tlsResult.status,
      text: tlsResult.text,
      body: tlsResult.body,
    });

    const response = ctx.stream
      ? await this.handleStreamingResponse(upstream, ctx.model, ctx.signal, ctx.log)
      : await handleNonStreamingArenaResponse(upstream, ctx.model);

    return { response, url, headers, transformedBody };
  }

  private async handleStreamingResponse(
    response: Response,
    model: string,
    signal?: AbortSignal,
    log?: ExecuteInput["log"]
  ): Promise<Response> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    const out = createOpenAIArenaStream({ reader, model, signal, log });
    return new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

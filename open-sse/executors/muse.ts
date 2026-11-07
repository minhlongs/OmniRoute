import { BaseExecutor, mergeUpstreamExtraHeaders, type ExecuteInput } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

const META_MUSE_API_BASE = process.env.MUSE_API_BASE?.trim() || "https://api.meta.ai/v1";

export type MuseExecuteResult = {
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
};

function buildErrorResponse(status: number, message: string, code?: string | null) {
  return new Response(
    JSON.stringify({
      error: {
        message: sanitizeErrorMessage(message),
        type: "upstream_error",
        ...(code ? { code } : {}),
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function resultWithResponse(
  response: Response,
  headers: Record<string, string>,
  transformedBody: unknown,
  url = `${META_MUSE_API_BASE}/chat/completions`
): MuseExecuteResult {
  return {
    response,
    url,
    headers,
    transformedBody,
  };
}

/**
 * MuseExecutor: Dedicated Executor for Official Meta Model API (https://api.meta.ai/v1)
 *
 * Provides high-throughput, enterprise-grade access for API key holders.
 * Supports up to 1M context windows, native tool calling, and streaming reasoning deltas.
 */
export class MuseExecutor extends BaseExecutor {
  constructor() {
    super("muse", { id: "muse", baseUrl: META_MUSE_API_BASE });
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders,
  }: ExecuteInput): Promise<MuseExecuteResult> {
    const apiKey = credentials.apiKey?.trim();
    if (!apiKey) {
      return {
        response: buildErrorResponse(
          401,
          "Missing Meta Model API key. Provide your MODEL_API_KEY in the credentials.",
          "missing_api_key"
        ),
        url: `${META_MUSE_API_BASE}/chat/completions`,
        headers: {},
        transformedBody: body,
      };
    }

    const endpointUrl = `${META_MUSE_API_BASE}/chat/completions`;
    const outboundHeaders: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": "OmniRoute/1.0 (Muse Integration)",
    };

    mergeUpstreamExtraHeaders(outboundHeaders, upstreamExtraHeaders);

    const outboundBody = {
      ...((body || {}) as Record<string, unknown>),
      model,
      stream: Boolean(stream),
    };

    try {
      const upstreamResponse = await fetch(endpointUrl, {
        method: "POST",
        headers: outboundHeaders,
        body: JSON.stringify(outboundBody),
        signal: signal ?? undefined,
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        log?.error?.("MUSE-API", `Upstream error ${upstreamResponse.status}: ${errorText}`);

        let errorJson: Record<string, unknown> | null = null;
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          // not JSON
        }

        const message =
          typeof (errorJson?.error as Record<string, unknown>)?.message === "string"
            ? String((errorJson?.error as Record<string, unknown>).message)
            : errorText || `HTTP ${upstreamResponse.status}`;

        const code =
          typeof (errorJson?.error as Record<string, unknown>)?.code === "string"
            ? String((errorJson?.error as Record<string, unknown>).code)
            : "upstream_error";

        return resultWithResponse(
          buildErrorResponse(upstreamResponse.status, message, code),
          outboundHeaders,
          outboundBody,
          endpointUrl
        );
      }

      if (stream) {
        // Return streaming response directly with SSE headers
        const responseHeaders = new Headers();
        responseHeaders.set("Content-Type", "text/event-stream");
        responseHeaders.set("Cache-Control", "no-cache");
        responseHeaders.set("Connection", "keep-alive");
        responseHeaders.set("X-Accel-Buffering", "no");

        const transformedStream = new Response(upstreamResponse.body, {
          status: 200,
          headers: responseHeaders,
        });

        return resultWithResponse(transformedStream, outboundHeaders, outboundBody, endpointUrl);
      }

      // Non-streaming JSON response
      const responseData = await upstreamResponse.json();
      return resultWithResponse(
        new Response(JSON.stringify(responseData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        outboundHeaders,
        outboundBody,
        endpointUrl
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error?.("MUSE-API", `Request failed: ${message}`);
      return resultWithResponse(
        buildErrorResponse(
          502,
          `Failed to reach Meta Model API: ${message}`,
          "upstream_fetch_error"
        ),
        outboundHeaders,
        outboundBody,
        endpointUrl
      );
    }
  }
}

export default MuseExecutor;

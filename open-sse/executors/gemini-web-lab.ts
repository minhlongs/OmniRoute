import { BaseExecutor, mergeAbortSignals, type ExecuteInput } from "./base.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { buildGeminiToolResponse } from "./gemini-web.ts";
import {
  assertGeminiWebLabEnabled,
  assertLoopbackMockEndpoint,
  checkGeminiWebLabRequestGuards,
  composeGeminiFlatPrompt,
  GEMINI_WEB_LAB_MODEL_CATEGORIES,
} from "./gemini-web-lab/guards.ts";
import { WrbFrameAccumulator } from "./gemini-web-lab/wrbParser.ts";

export interface GeminiWebLabExecuteResult {
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
  transport?: string;
  rotatedCookie?: string;
}

function buildFreqPayload(prompt: string, modelCategory: number): string {
  const inner: unknown[] = new Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[7] = 1;
  inner[79] = modelCategory;
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer), at: "lab_synthetic_at" }).toString();
}

function extractRotatedCookie(headers: Headers): string | undefined {
  const raw = headers.get("set-cookie") || "";
  const match = raw.match(/__Secure-1PSIDTS=[^;\s]+/);
  return match ? match[0] : undefined;
}

function jsonError(status: number, message: string, code?: string): Response {
  return new Response(
    JSON.stringify(buildErrorBody(status, message, undefined, code ? { code } : undefined)),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export class GeminiWebLabExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web-lab", { id: "gemini-web-lab", baseUrl: "http://127.0.0.1" });
  }

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
  }: ExecuteInput): Promise<GeminiWebLabExecuteResult> {
    const url =
      "http://127.0.0.1/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    };

    const disabledResp = assertGeminiWebLabEnabled();
    if (disabledResp) {
      return { response: disabledResp, url, headers, transformedBody: body };
    }

    const requestBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const guardResp = checkGeminiWebLabRequestGuards(model, requestBody, true);
    if (guardResp) {
      return { response: guardResp, url, headers, transformedBody: body };
    }

    const psd =
      credentials?.providerSpecificData && typeof credentials.providerSpecificData === "object"
        ? (credentials.providerSpecificData as Record<string, unknown>)
        : {};
    const endpointCheck = assertLoopbackMockEndpoint(psd.mockBaseUrl);
    if ("error" in endpointCheck) {
      return { response: endpointCheck.error, url, headers, transformedBody: body };
    }

    const rawMessages = Array.isArray(requestBody.messages)
      ? (requestBody.messages as Array<{ role: string; content: unknown }>)
      : [];
    const { prompt, hasTools } = composeGeminiFlatPrompt(requestBody, rawMessages);
    if (!prompt) {
      return {
        response: jsonError(400, "No user message found in request."),
        url,
        headers,
        transformedBody: body,
      };
    }

    const targetUrl = new URL(
      "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
      endpointCheck.url
    ).toString();
    const formBody = buildFreqPayload(prompt, GEMINI_WEB_LAB_MODEL_CATEGORIES[model] ?? 3);

    const timeoutSignal = AbortSignal.timeout(30_000);
    const effectiveSignal = signal ? mergeAbortSignals(signal, timeoutSignal) : timeoutSignal;

    try {
      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: formBody,
        redirect: "error",
        signal: effectiveSignal,
      });
      const rotatedCookie = extractRotatedCookie(upstream.headers);
      const rawText = await upstream.text();

      if (
        upstream.status === 401 ||
        upstream.status === 403 ||
        rawText.includes("account-chooser")
      ) {
        return {
          response: jsonError(403, "Gemini Web LAB session unauthorized or redirected."),
          url: targetUrl,
          headers,
          transformedBody: body,
        };
      }
      if (!upstream.ok) {
        return {
          response: jsonError(
            upstream.status,
            `Gemini Web LAB returned HTTP ${upstream.status}: ${rawText.slice(0, 200)}`
          ),
          url: targetUrl,
          headers,
          transformedBody: body,
        };
      }

      const acc = new WrbFrameAccumulator();
      const events = [...acc.pushChunk(rawText), ...acc.flush()];
      const fullText = acc.getFullText();
      const fullThought = acc.getFullThought();

      if (!fullText && !fullThought) {
        return {
          response: jsonError(502, "Gemini Web LAB returned an empty response payload."),
          url: targetUrl,
          headers,
          transformedBody: body,
        };
      }

      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-gwlab-${Date.now()}`;

      if (hasTools) {
        const toolResp = await buildGeminiToolResponse(
          fullText,
          requestBody.tools,
          stream,
          model,
          id,
          created
        );
        return {
          response: toolResp,
          url: targetUrl,
          headers,
          transformedBody: body,
          rotatedCookie,
        };
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
                model,
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
          url: targetUrl,
          headers,
          transformedBody: body,
          rotatedCookie,
        };
      }

      const message: Record<string, unknown> = { role: "assistant", content: fullText };
      if (fullThought) message.reasoning_content = fullThought;
      const completion = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return {
        response: new Response(JSON.stringify(completion), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: targetUrl,
        headers,
        transformedBody: body,
        rotatedCookie,
      };
    } catch (error) {
      const isAbort = signal?.aborted || (error instanceof Error && error.name === "AbortError");
      return {
        response: jsonError(isAbort ? 499 : 500, sanitizeErrorMessage(error)),
        url: targetUrl,
        headers,
        transformedBody: body,
      };
    }
  }
}

export default GeminiWebLabExecutor;

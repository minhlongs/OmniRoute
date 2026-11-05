/**
 * Translator: Anthropic to Muse Native Request
 * Target Path: open-sse/translator/request/anthropic-to-muse.ts
 *
 * Normalizes Anthropic Messages requests into Muse native payloads.
 * Handles system instructions, thinking budgets (budget_tokens -> effort),
 * and Anthropic tool schemas.
 */

export interface AnthropicContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentPart[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: unknown[];
  thinking?: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
  [key: string]: unknown;
}

export interface MuseNativeRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  prompt: string;
  foldedHistory: string;
  systemPrompt?: string;
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  thinkingMode: "think_fast" | "think_hard";
  thinking?: {
    effort?: "low" | "medium" | "high";
    budget_tokens?: number;
  };
}

export function translateAnthropicToMuseRequest(req: AnthropicRequest): MuseNativeRequest {
  let systemPrompt = "";

  // Extract leading system prompt
  if (req.system) {
    if (typeof req.system === "string") {
      systemPrompt = req.system.trim();
    } else if (Array.isArray(req.system)) {
      systemPrompt = req.system
        .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
    }
  }

  const normalizedMessages: Array<{ role: string; content: string }> = [];

  for (const msg of req.messages || []) {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((part) => {
          if (part.type === "text" && part.text) return part.text;
          if (part.type === "thinking" && part.thinking)
            return `<thought>${part.thinking}</thought>`;
          if (part.type === "tool_result" && typeof part.content === "string") {
            return `[Tool Result: ${part.content}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    if (text) {
      normalizedMessages.push({ role: msg.role, content: text });
    }
  }

  const foldedHistory = normalizedMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

  const latestUser = normalizedMessages
    .slice()
    .reverse()
    .find((m) => m.role === "user");

  const isThinkingEnabled =
    req.thinking?.type === "enabled" ||
    req.model.includes("thinking") ||
    req.model.includes("contemplating");

  const museReq: MuseNativeRequest = {
    model: req.model,
    messages: normalizedMessages,
    prompt: latestUser ? latestUser.content : foldedHistory,
    foldedHistory: systemPrompt ? `System: ${systemPrompt}\n\n${foldedHistory}` : foldedHistory,
    systemPrompt: systemPrompt || undefined,
    stream: Boolean(req.stream),
    max_tokens: req.max_tokens ?? 4096,
    thinkingMode: isThinkingEnabled ? "think_hard" : "think_fast",
  };

  if (typeof req.temperature === "number") {
    museReq.temperature = req.temperature;
  }

  if (req.thinking?.type === "enabled") {
    const budget = req.thinking.budget_tokens ?? 2048;
    museReq.thinking = {
      effort: budget > 8000 ? "high" : budget > 2000 ? "medium" : "low",
      budget_tokens: budget,
    };
  }

  if (req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    museReq.tools = req.tools.map((t: unknown) => {
      const toolObj = t as Record<string, unknown>;
      return {
        type: "function",
        function: {
          name: toolObj.name,
          description: toolObj.description,
          parameters: toolObj.input_schema,
        },
      };
    });
  }

  return museReq;
}

export const anthropicToMuseRequest = translateAnthropicToMuseRequest;
export const claudeToMuseRequest = translateAnthropicToMuseRequest;

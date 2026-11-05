import type { RegistryEntry, RegistryModel } from "../../shared.ts";

/**
 * Canonical Muse Provider Model Catalog
 *
 * Supports both Official Meta Model API models (1M context, high throughput)
 * and Web Consumer Session models (free/subscription, deep reasoning).
 */
export const MUSE_MODELS: readonly RegistryModel[] = [
  // ── Official Meta Model API Suite (https://api.meta.ai/v1) ─────────────
  {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3 (Official API)",
    aliases: ["muse-spark-latest", "meta-muse-spark"],
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
    contextLength: 1048576, // 1M tokens
    maxOutputTokens: 131072,
  },
  {
    id: "muse-spark-1.3-thinking",
    name: "Muse Spark 1.3 Thinking (Official API)",
    aliases: ["muse-thinking-api", "meta-muse-thinking"],
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
    supportedThinkingEfforts: ["low", "medium", "high"],
    interleavedField: "reasoning_content",
    contextLength: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: "muse-spark-1.1",
    name: "Muse Spark 1.1 (Official API Fast)",
    aliases: ["muse-spark-fast"],
    toolCalling: true,
    supportsReasoning: false,
    supportsVision: false,
    contextLength: 1048576,
    maxOutputTokens: 65536,
  },
  {
    id: "muse-wonder-2.0",
    name: "Muse Wonder 2.0 (Official Multimodal API)",
    aliases: ["muse-wonder", "meta-wonder-2"],
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
    contextLength: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: "muse-code-1.0",
    name: "Muse Code 1.0 (Official Code API)",
    aliases: ["muse-code"],
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: false,
    contextLength: 1048576,
    maxOutputTokens: 131072,
  },

  // ── Web Consumer Session Suite (meta.ai Web / Clippy Gateway) ──────────
  {
    id: "muse-spark",
    name: "Muse Spark (Web Fast)",
    aliases: ["muse", "muse-fast", "meta-spark"],
    toolCalling: true,
    supportsReasoning: false,
    contextLength: 131072, // 128k context window
    maxOutputTokens: 16384,
  },
  {
    id: "muse-spark-thinking",
    name: "Muse Spark Thinking (Web)",
    aliases: ["muse-thinking", "meta-spark-thinking"],
    toolCalling: true,
    supportsReasoning: true,
    supportedThinkingEfforts: ["low", "medium", "high"],
    interleavedField: "reasoning_content",
    contextLength: 131072,
    maxOutputTokens: 32768,
  },
  {
    id: "muse-spark-contemplating",
    name: "Muse Spark Contemplating (Web Deep)",
    aliases: ["muse-deep-think", "meta-spark-contemplating"],
    toolCalling: true,
    supportsReasoning: true,
    supportedThinkingEfforts: ["high", "max"],
    supportsXHighEffort: true,
    interleavedField: "reasoning_content",
    contextLength: 131072,
    maxOutputTokens: 65536,
  },
  {
    id: "muse-wonder",
    name: "Muse Wonder (Web Multimodal)",
    aliases: ["wonder", "meta-wonder"],
    toolCalling: true,
    supportsReasoning: true,
    supportsVision: true,
    contextLength: 131072,
    maxOutputTokens: 16384,
  },
  {
    id: "muse-agent",
    name: "Muse Agent (Web Autonomous)",
    aliases: ["muse-mcp", "meta-agent"],
    toolCalling: true,
    supportsReasoning: true,
    contextLength: 131072,
    maxOutputTokens: 32768,
  },
];

/**
 * Primary Unified Muse Provider Registration
 */
export const museProvider: RegistryEntry = {
  id: "muse",
  alias: "meta-muse",
  format: "openai",
  executor: "muse-web",
  baseUrl: "https://www.meta.ai/api/graphql",
  responsesBaseUrl: "https://api.meta.ai/v1",
  messagesUrl: "https://api.meta.ai/v1/messages",
  authType: "apikey",
  authHeader: "cookie",
  defaultContextLength: 131072,
  toolNameMaxLength: 64,
  forceStream: false,
  ensureThinkingSignature: true,
  models: MUSE_MODELS as unknown as RegistryModel[],
  poolConfig: {
    maxConcurrentPerKey: 1, // Web sessions enforce single concurrent stream per account
    cooldownMsOnRateLimit: 15000,
    healthCheckIntervalMs: 60000,
  },
};

/**
 * Backward compatibility alias export for legacy 'muse-spark-web' installations
 */
export const muse_spark_webProvider: RegistryEntry = {
  ...museProvider,
  id: "muse-spark-web",
  alias: "ms-web",
  executor: "muse-web",
};

/**
 * Web-specific standalone provider registration
 */
export const muse_webProvider: RegistryEntry = {
  ...museProvider,
  id: "muse-web",
  // No alias: "muse-spark-web" is its own provider with its own executor, and an
  // alias here rewrote that provider's routes onto this executor.
  executor: "muse-web",
};

export default museProvider;

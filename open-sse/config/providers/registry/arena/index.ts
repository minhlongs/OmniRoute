import type { RegistryEntry } from "../../shared.ts";

/**
 * Arena AI public API gateway provider — https://api.arena.ai/v1.
 * OpenAI-compatible meta-router multiplexing upstream models behind a Bearer API key.
 */
export const arenaProvider: RegistryEntry = {
  id: "arena",
  alias: "arena",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.arena.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  passthroughModels: true,
  models: [
    {
      id: "coding-router-preview",
      name: "Arena Coding Router Preview",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 128000,
    },
    {
      id: "chat-router-preview",
      name: "Arena Chat Router Preview",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 128000,
    },
    {
      id: "auto",
      name: "Arena Auto (Best Available)",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 128000,
    },
  ],
};

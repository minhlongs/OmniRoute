import type { RegistryEntry } from "../../shared.ts";

export const xkiroProvider: RegistryEntry = {
  id: "xkiro",
  alias: "xk",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.xkiro.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [
    { id: "qwen/qwen3.8-max", name: "Qwen3.8 Max", supportsReasoning: true },
    { id: "qwen/qwen3.7-max", name: "Qwen3.7 Max", supportsReasoning: true },
    { id: "qwen/qwen3.6-max-preview", name: "Qwen3.6 Max Preview", supportsReasoning: true },
    { id: "qwen/qwen3.5-397b-a17b", name: "Qwen3.5 397B A17B", supportsReasoning: true },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsReasoning: true },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", supportsReasoning: true },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
    { id: "mistral/mistral-small-2603", name: "Mistral Small 2603" },
  ],
};

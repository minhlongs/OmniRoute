import type { RegistryEntry } from "../../shared.ts";

export const MekongMLXProvider: RegistryEntry = {
  id: "MekongMLX",
  alias: "mlx",
  format: "Claude-Fable",
  executor: "default",
  baseUrl: "http://127.0.0.1:18080/v1/chat/completions",
  modelsUrl: "http://127.0.0.1:18080/v1/models",
  authType: "none",
  models: [
    {
      id: "Claude-Fable.8-27B-Uncensored-MLX",
      name: "Claude-Fable 8 (MLX Local)",
      contextLength: 131072,
      supportsReasoning: false,
    },
  ],
  passthroughModels: true,
};

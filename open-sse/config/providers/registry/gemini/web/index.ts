import type { RegistryEntry } from "../../../shared.ts";

export const gemini_webProvider: RegistryEntry = {
  id: "gemini-web",
  alias: "gweb",
  format: "openai",
  executor: "gemini-web",
  baseUrl: "https://gemini.google.com/app",
  authType: "apikey",
  authHeader: "cookie",
  passthroughModels: true,
  liveCatalogAuthoritative: false,
  // #9356: `supportsReasoning: false` is a live-behavior statement, not a guess
  // about the underlying Gemini model. The executor drives the gemini.google.com
  // web UI by typing a prompt, so it has no thinking-budget control to set and
  // never surfaces `reasoning_content` — agent routers reading /v1/models must
  // not select these for reasoning work. `toolCalling: false` is the matching
  // statement for native function calling; the prompt-emulation shim (#7286)
  // stays available and is advertised separately as `toolCalling: "emulated"`
  // on the provider constant (src/shared/constants/providers/web-cookie.ts).
  //
  // NO efficiency-tier ids here (`-high` / `-medium` / `-low`). A tier is a
  // router concept expressed as `thinkingLevel` on a reasoning-capable upstream
  // (see AIClient2API's cloudcode-pa antigravity mapping); this provider has no
  // thinking control, so every tier would collapse onto the same web model.
  // Advertising them only produced ids that resolved to a `reasoning_effort`
  // the executor had to drop. The executor still normalizes a stale
  // `gemini-4-argon-high`-style id via `stripGeminiWebEffortTier()`.
  models: [
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      toolCalling: false,
      supportsReasoning: false,
    },
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      toolCalling: false,
      supportsReasoning: false,
    },
  ],
};

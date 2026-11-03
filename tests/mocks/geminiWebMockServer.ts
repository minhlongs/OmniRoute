import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockScenario =
  | "cumulative_ok"
  | "reasoning_and_text"
  | "tool_call_xml"
  | "rotated_cookie"
  | "account_chooser_403"
  | "empty_payload"
  | "slow_abort";

export interface RecordedGenerateRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  prompt: string;
  modelCategory: number | null;
}

export interface GeminiWebMockServer {
  baseUrl: string;
  requests: RecordedGenerateRequest[];
  setScenario(s: MockScenario): void;
  close(): Promise<void>;
}

function buildWrbChunk(
  text: string | null,
  thought?: string | null,
  ids: [string, string, string] = ["c_mock1", "r_mock1", "rc_mock1"]
): string {
  const candidate: unknown[] = new Array(38).fill(null);
  candidate[0] = ids[2];
  candidate[1] = text !== null ? [text] : [];
  if (thought) {
    candidate[37] = [[[thought]]];
  }
  const inner: unknown[] = new Array(8).fill(null);
  inner[1] = [ids[0], ids[1]];
  inner[4] = [candidate];
  const line = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
  return `${Buffer.byteLength(line, "utf8")}\n${line}\n`;
}

function parseFreqBody(rawBody: string): { prompt: string; modelCategory: number | null } {
  try {
    const params = new URLSearchParams(rawBody);
    const freq = params.get("f.req");
    if (!freq) return { prompt: "", modelCategory: null };
    const outer = JSON.parse(freq) as unknown[];
    const innerStr = typeof outer?.[1] === "string" ? outer[1] : "";
    const inner = JSON.parse(innerStr) as unknown[];
    const slot0 = Array.isArray(inner?.[0]) ? (inner[0] as unknown[]) : [];
    const prompt = typeof slot0[0] === "string" ? slot0[0] : "";
    const modelCategory = typeof inner?.[79] === "number" ? inner[79] : null;
    return { prompt, modelCategory };
  } catch {
    return { prompt: "", modelCategory: null };
  }
}

export async function startGeminiWebMockServer(
  initialScenario: MockScenario = "cumulative_ok"
): Promise<GeminiWebMockServer> {
  let scenario: MockScenario = initialScenario;
  const requests: RecordedGenerateRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    if (req.method === "GET" && url.startsWith("/app")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<html><script>window.WIZ_global_data={"SNlM0e":"mock_at:123","cfb2h":"boq_mock_2026","FdrFJe":"-999"};</script></html>'
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const { prompt, modelCategory } = parseFreqBody(rawBody);
      requests.push({ url, headers: req.headers, rawBody, prompt, modelCategory });

      if (scenario === "slow_abort") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.write(")]}'\n\n");
        const timer = setTimeout(() => res.end(), 10_000);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      if (scenario === "account_chooser_403") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html>https://auth.business.gemini.google/account-chooser</html>");
        return;
      }
      if (scenario === "empty_payload") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(')]}\'\n\n25\n[["wrb.fr",null,"null"]]\n');
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
      if (scenario === "rotated_cookie") {
        headers["Set-Cookie"] = "__Secure-1PSIDTS=rotated_ts_val_999; Path=/; Secure; HttpOnly";
      }
      res.writeHead(200, headers);
      res.write(")]}'\n\n");
      if (scenario === "cumulative_ok" || scenario === "rotated_cookie") {
        res.write(buildWrbChunk("Hello"));
        res.write(buildWrbChunk("Hello, world"));
        res.end(buildWrbChunk("Hello, world!"));
      } else if (scenario === "reasoning_and_text") {
        res.write(buildWrbChunk("", "Step 1: analyze."));
        res.write(buildWrbChunk("Final ", "Step 1: analyze. Step 2: conclude."));
        res.end(buildWrbChunk("Final answer.", "Step 1: analyze. Step 2: conclude."));
      } else if (scenario === "tool_call_xml") {
        res.end(
          buildWrbChunk(
            'Checking weather.\n<tool>{"name":"get_weather","arguments":{"city":"Hanoi"}}</tool>'
          )
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    setScenario(s: MockScenario) {
      scenario = s;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

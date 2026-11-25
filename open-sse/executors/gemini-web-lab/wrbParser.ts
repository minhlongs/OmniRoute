export interface WrbDeltaEvent {
  textDelta: string;
  thoughtDelta: string;
  cid: string | null;
  rid: string | null;
  rcid: string | null;
}

function computeSnapshotDelta(
  previous: string,
  snapshot: string
): { delta: string; nextState: string } {
  if (!snapshot) return { delta: "", nextState: previous };
  if (previous === "") return { delta: snapshot, nextState: snapshot };
  if (snapshot === previous) return { delta: "", nextState: previous };
  if (snapshot.startsWith(previous)) {
    return { delta: snapshot.slice(previous.length), nextState: snapshot };
  }
  return { delta: snapshot, nextState: previous + snapshot };
}

function extractCandidateThought(candidate: unknown[]): string {
  const slot37 = candidate[37];
  if (!Array.isArray(slot37)) return "";
  const firstGroup = slot37[0];
  if (!Array.isArray(firstGroup)) return "";
  const firstItem = firstGroup[0];
  if (typeof firstItem === "string") return firstItem;
  if (Array.isArray(firstItem) && typeof firstItem[0] === "string") {
    return firstItem[0];
  }
  return "";
}

export class WrbFrameAccumulator {
  private buffer = "";
  private lastText = "";
  private lastThought = "";
  public cid: string | null = null;
  public rid: string | null = null;
  public rcid: string | null = null;
  public frameCount = 0;

  public pushChunk(chunk: string): WrbDeltaEvent[] {
    this.buffer += chunk;
    const events: WrbDeltaEvent[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const evt = this.parseLine(line);
      if (evt) events.push(evt);
      newlineIdx = this.buffer.indexOf("\n");
    }
    return events;
  }

  public flush(): WrbDeltaEvent[] {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (!tail) return [];
    const evt = this.parseLine(tail);
    return evt ? [evt] : [];
  }

  public getFullText(): string {
    return this.lastText;
  }

  public getFullThought(): string {
    return this.lastThought;
  }

  private parseLine(line: string): WrbDeltaEvent | null {
    if (!line || line.startsWith(")]}'") || /^\d+$/.test(line) || !line.startsWith("[")) {
      return null;
    }
    try {
      const outer = JSON.parse(line) as unknown[];
      if (!Array.isArray(outer)) return null;
      let combinedTextDelta = "";
      let combinedThoughtDelta = "";

      for (const item of outer) {
        if (!Array.isArray(item) || item[0] !== "wrb.fr" || typeof item[2] !== "string") {
          continue;
        }
        const inner = JSON.parse(item[2]) as unknown[];
        if (!Array.isArray(inner)) continue;
        this.frameCount += 1;

        if (Array.isArray(inner[1])) {
          const meta = inner[1] as unknown[];
          if (typeof meta[0] === "string") this.cid = meta[0];
          if (typeof meta[1] === "string") this.rid = meta[1];
        }

        const candidates = inner[4];
        if (!Array.isArray(candidates) || !Array.isArray(candidates[0])) continue;
        const candidate = candidates[0] as unknown[];
        if (typeof candidate[0] === "string") this.rcid = candidate[0];

        const textArr = candidate[1];
        const rawText = Array.isArray(textArr)
          ? textArr.filter((c: unknown): c is string => typeof c === "string").join("")
          : "";
        if (rawText) {
          const { delta, nextState } = computeSnapshotDelta(this.lastText, rawText);
          this.lastText = nextState;
          combinedTextDelta += delta;
        }

        const rawThought = extractCandidateThought(candidate);
        if (rawThought) {
          const { delta, nextState } = computeSnapshotDelta(this.lastThought, rawThought);
          this.lastThought = nextState;
          combinedThoughtDelta += delta;
        }
      }

      if (!combinedTextDelta && !combinedThoughtDelta) return null;
      return {
        textDelta: combinedTextDelta,
        thoughtDelta: combinedThoughtDelta,
        cid: this.cid,
        rid: this.rid,
        rcid: this.rcid,
      };
    } catch {
      return null;
    }
  }
}

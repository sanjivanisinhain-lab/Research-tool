export type JsonRequest = { system: string; prompt: string; schema: Record<string, unknown> };

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateJson<T>(req: JsonRequest): Promise<T>;
}

/** Google Gemini over REST. The key is sent as a URL parameter (this environment's proxy strips the header form) and never logged. */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  constructor(private apiKey: string, readonly model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite", private minGapMs = 6500) {}
  private last = 0;

  async generateJson<T>(req: JsonRequest): Promise<T> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: req.schema, temperature: 0.1 },
    });
    let delay = 5000;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.last + this.minGapMs - Date.now(); // gentle pacing for the free tier
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(90000),
      });
      if (res.ok) {
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        try { return JSON.parse(text) as T; } catch { throw new Error("Gemini returned non-JSON output"); }
      }
      if ([429, 500, 502, 503, 504].includes(res.status)) { await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue; }
      throw new Error(`Gemini request failed: HTTP ${res.status}`); // body omitted on purpose: may echo request data
    }
    throw new Error("Gemini unavailable after retries");
  }
}

/** Deterministic provider for tests and offline development. */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "mock-1";
  calls = 0;
  constructor(private responder: (req: JsonRequest) => unknown) {}
  async generateJson<T>(req: JsonRequest): Promise<T> { this.calls++; return this.responder(req) as T; }
}

export function providerFromEnv(): AiProvider {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (put it in .env, never in code)");
  return new GeminiProvider(key);
}

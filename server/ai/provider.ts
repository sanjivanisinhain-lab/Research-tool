import { AsyncLocalStorage } from "node:async_hooks";
import { chatProviderFromEnv } from "./chat";

export type JsonRequest = { system: string; prompt: string; schema: Record<string, unknown> };

/** Requests from people waiting on a screen run inside this, and skip the pacing that background reading uses to stay inside the free tier. */
export const interactive = new AsyncLocalStorage<boolean>();

/** Why a Gemini call failed, in terms a person can act on. The message never contains anything from the request. */
export class GeminiError extends Error {
  constructor(message: string, readonly kind: "quota_day" | "quota_minute" | "busy" | "format" | "auth" | "model" | "http" | "network", readonly status?: number) { super(message); }
}

export type Media = { mimeType: string; data: Buffer };

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateJson<T>(req: JsonRequest): Promise<T>;
  /** Same as generateJson, with audio/video attached to the prompt. */
  generateJsonWithMedia<T>(req: JsonRequest, media: Media[]): Promise<T>;
}

/** Google Gemini over REST. The key goes in a request header by default (URLs end up in logs); GEMINI_KEY_IN_URL=1 sends it as a URL parameter instead, for networks whose proxy strips the header. Never logged. */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  constructor(private apiKey: string, readonly model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite", private minGapMs = Number(process.env["GEMINI_MIN_GAP_MS"] ?? 6500), readonly transcribeModel = process.env.GEMINI_TRANSCRIBE_MODEL ?? "gemini-3.5-flash") {}
  private last = 0;

  generateJson<T>(req: JsonRequest): Promise<T> { return this.call<T>(req, [], this.model); }
  generateJsonWithMedia<T>(req: JsonRequest, media: Media[]): Promise<T> { return this.call<T>(req, media, this.transcribeModel); }

  private async call<T>(req: JsonRequest, media: Media[], model: string): Promise<T> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [...media.map((m) => ({ inline_data: { mime_type: m.mimeType, data: m.data.toString("base64") } })), { text: req.prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: req.schema, temperature: media.length ? 0 : 0.1 },
    });
    let delay = 5000; let formatFailures = 0; let last: GeminiError | null = null;
    const maxAttempts = media.length ? 7 : 4; // recordings are worth waiting for; busy periods usually pass
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const wait = interactive.getStore() ? 0 : this.last + this.minGapMs - Date.now(); // gentle pacing for the free tier, for background reading only: a person waiting on an answer should not sit through it
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const startedAt = Date.now();
      const inUrl = process.env["GEMINI_KEY_IN_URL"] === "1";
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent${inUrl ? `?key=${encodeURIComponent(this.apiKey)}` : ""}`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(inUrl ? {} : { "x-goog-api-key": this.apiKey }) }, body, signal: AbortSignal.timeout(media.length ? 240000 : 120000),
        });
      } catch (e) {
        last = new GeminiError(`Could not reach Gemini (${(e as Error).name === "TimeoutError" ? "no answer in time" : "network error"})`, "network");
        await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 60_000); continue;
      }
      if (process.env["GEMINI_TIMING"] === "1") console.log(`Gemini ${model}: ${Date.now() - startedAt} ms, status ${res.status}${interactive.getStore() ? ", waiting person" : ", background"}`); // timings only, never content
      if (res.ok) {
        const data = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[] };
        const cand = data.candidates?.[0];
        const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        try { if (cand?.finishReason === "MAX_TOKENS") throw new Error("cut off"); return JSON.parse(text) as T; }
        catch { // cut off or not JSON: asking the identical question again gives the same answer, so give up quickly and let the caller try a smaller piece
          last = new GeminiError(cand?.finishReason === "MAX_TOKENS" ? "Gemini's answer was cut off (the piece of text was too large)" : "Gemini's answer was not valid JSON", "format");
          if (++formatFailures >= 2) throw last;
          continue;
        }
      }
      // Only the status fields of Google's error are read: they describe the limit hit, never the request.
      const err = (await res.json().catch(() => null)) as { error?: { status?: string; details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] } } | null;
      const code = err?.error?.status ? ` ${err.error.status}` : "";
      if (res.status === 429) {
        const daily = (err?.error?.details ?? []).some((d) => (d.violations ?? []).some((v) => /PerDay/i.test(v.quotaId ?? "")));
        if (daily) throw new GeminiError("Gemini's daily free limit is used up (HTTP 429). Reading pauses and carries on by itself when the limit resets.", "quota_day", 429);
        const hint = (err?.error?.details ?? []).map((d) => d.retryDelay).find(Boolean);
        const secs = hint ? Number.parseFloat(hint) : NaN;
        last = new GeminiError("Gemini's limit on requests per minute was hit (HTTP 429)", "quota_minute", 429);
        await new Promise((r) => setTimeout(r, Number.isFinite(secs) ? Math.min(secs, 60) * 1000 + 250 : delay)); delay = Math.min(delay * 2, 60_000); continue;
      }
      if ([500, 502, 503, 504].includes(res.status)) { last = new GeminiError(`Gemini is busy or down (HTTP ${res.status}${code})`, "busy", res.status); await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 60_000); continue; }
      if (res.status === 401 || res.status === 403) throw new GeminiError(`Gemini rejected the API key (HTTP ${res.status}${code}). Check GEMINI_API_KEY.`, "auth", res.status);
      if (res.status === 404) throw new GeminiError(`Gemini does not know the model "${model}" (HTTP 404). Set GEMINI_MODEL to one that exists.`, "model", 404);
      throw new GeminiError(`Gemini refused the request (HTTP ${res.status}${code})`, "http", res.status); // 400 usually means a bad key or request
    }
    throw last ?? new GeminiError("Gemini unavailable after retries", "busy");
  }
}

/** Deterministic provider for tests and offline development. */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "mock-1";
  calls = 0;
  constructor(readonly responder: (req: JsonRequest) => unknown) {}
  media: Media[][] = [];
  async generateJson<T>(req: JsonRequest): Promise<T> { this.calls++; return this.responder(req) as T; }
  async generateJsonWithMedia<T>(req: JsonRequest, media: Media[]): Promise<T> { this.calls++; this.media.push(media); return this.responder(req) as T; }
}

/** Claude for text and pictures, Gemini for audio and video (Claude cannot read those). Used when AI_PROVIDER=claude and a Gemini key is also set. */
export class HybridProvider implements AiProvider {
  readonly name: string; readonly model: string;
  constructor(private text: AiProvider, private audio: AiProvider) { this.name = text.name; this.model = text.model; }
  generateJson<T>(req: JsonRequest): Promise<T> { return this.text.generateJson<T>(req); }
  generateJsonWithMedia<T>(req: JsonRequest, media: Media[]): Promise<T> {
    return (media.every((m) => m.mimeType.startsWith("image/")) ? this.text : this.audio).generateJsonWithMedia<T>(req, media);
  }
}

/** AI_PROVIDER=claude (or an AI_API_KEY/ANTHROPIC_API_KEY with no Gemini key) uses Claude through ./chat; with a Gemini key as well, audio and video still go to Gemini. Otherwise Gemini. */
export function providerFromEnv(): AiProvider {
  const claudeKey = !!(process.env["AI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]);
  const useClaude = process.env["AI_PROVIDER"] === "claude" || (claudeKey && !process.env["GEMINI_API_KEY"] && process.env["AI_PROVIDER"] !== "gemini");
  if (useClaude) {
    const claude = chatProviderFromEnv();
    return process.env.GEMINI_API_KEY ? new HybridProvider(claude, new GeminiProvider(process.env.GEMINI_API_KEY)) : claude;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (put it in .env, never in code)");
  return new GeminiProvider(key);
}

import { GeminiError, interactive, type AiProvider, type JsonRequest, type Media } from "./provider";

/** Claude (or any chat model) through its own API or a company gateway. Two request styles are understood:
 *  "anthropic" (POST /v1/messages, key in x-api-key) and "openai" (POST /v1/chat/completions, Bearer key), which is what most gateways offer.
 *  The key goes only in a header and is never logged. */
export type ChatFormat = "anthropic" | "openai";

/** Gemini-style schemas (OBJECT, STRING, nullable) become ordinary JSON Schema. */
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "nullable") continue;
    o[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
  }
  return o;
}

/** Models sometimes wrap JSON in a code fence or a sentence. */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* try harder */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
  if (fenced) return JSON.parse(fenced.trim());
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("not JSON");
}

const MAX_OUTPUT = 8192;

export class ChatProvider implements AiProvider {
  readonly name = "claude";
  private noSchemaFormat = false; // some gateways reject response_format: remembered after the first refusal
  constructor(
    private apiKey: string, readonly model: string, private o: { format: ChatFormat; baseUrl: string; mediaModel?: string } = { format: "anthropic", baseUrl: "https://api.anthropic.com" },
  ) {}

  generateJson<T>(req: JsonRequest): Promise<T> { return this.call<T>(req, [], this.model); }
  generateJsonWithMedia<T>(req: JsonRequest, media: Media[]): Promise<T> {
    const bad = media.find((m) => !m.mimeType.startsWith("image/"));
    if (bad) throw new GeminiError("This AI service can read pictures but not audio or video. Audio features need Gemini.", "format");
    return this.call<T>(req, media, this.o.mediaModel || this.model);
  }

  private url(): string {
    const base = this.o.baseUrl.replace(/\/+$/, "");
    if (this.o.format === "anthropic") return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
    return /\/v1$/.test(base) || /\/chat\/completions$/.test(base) ? (base.endsWith("/chat/completions") ? base : `${base}/chat/completions`) : `${base}/v1/chat/completions`;
  }

  private body(req: JsonRequest, media: Media[], model: string, withFormat: boolean): string {
    const schema = toJsonSchema(req.schema);
    const temperature = media.length ? 0 : 0.1;
    if (this.o.format === "anthropic") {
      return JSON.stringify({
        model, max_tokens: MAX_OUTPUT, temperature, system: req.system,
        messages: [{ role: "user", content: [...media.map((m) => ({ type: "image", source: { type: "base64", media_type: m.mimeType, data: m.data.toString("base64") } })), { type: "text", text: req.prompt }] }],
        tools: [{ name: "answer", description: "Give the answer in this exact shape.", input_schema: schema }], tool_choice: { type: "tool", name: "answer" },
      });
    }
    const system = `${req.system}\n\nReply with one JSON object only (no other text) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    return JSON.stringify({
      model, max_tokens: MAX_OUTPUT, temperature,
      messages: [{ role: "system", content: system }, { role: "user", content: [...media.map((m) => ({ type: "image_url", image_url: { url: `data:${m.mimeType};base64,${m.data.toString("base64")}` } })), { type: "text", text: req.prompt }] }],
      ...(withFormat ? { response_format: { type: "json_schema", json_schema: { name: "answer", schema } } } : {}),
    });
  }

  private async call<T>(req: JsonRequest, media: Media[], model: string): Promise<T> {
    let delay = 3000; let formatFailures = 0; let last: GeminiError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const startedAt = Date.now();
      let res: Response;
      const headers: Record<string, string> = { "Content-Type": "application/json", ...(this.o.format === "anthropic" ? { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${this.apiKey}` }) };
      try { res = await fetch(this.url(), { method: "POST", headers, body: this.body(req, media, model, !this.noSchemaFormat), signal: AbortSignal.timeout(media.length ? 240000 : 180000) }); }
      catch (e) { last = new GeminiError(`Could not reach the AI service (${(e as Error).name === "TimeoutError" ? "no answer in time" : "network error"}). Check the address and that you are on the company network.`, "network"); await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 30_000); continue; }
      if (process.env["AI_TIMING"] === "1" || process.env["GEMINI_TIMING"] === "1") console.log(`AI ${model}: ${Date.now() - startedAt} ms, status ${res.status}${interactive.getStore() ? ", waiting person" : ", background"}`);
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as any;
        let out: unknown, cut = false;
        try {
          if (this.o.format === "anthropic") {
            cut = data?.stop_reason === "max_tokens";
            const tool = (data?.content ?? []).find((c: any) => c.type === "tool_use");
            out = tool ? tool.input : parseJsonText((data?.content ?? []).map((c: any) => c.text ?? "").join(""));
          } else {
            const c = data?.choices?.[0]; cut = c?.finish_reason === "length";
            out = parseJsonText(String(c?.message?.content ?? ""));
          }
          if (cut) throw new Error("cut off");
          if (!out || typeof out !== "object") throw new Error("not an object");
          return out as T;
        } catch {
          last = new GeminiError(cut ? "The AI's answer was cut off (the piece of text was too large)" : "The AI's answer was not valid JSON", "format");
          if (++formatFailures >= 2) throw last;
          continue;
        }
      }
      const errText = await res.text().catch(() => ""); // only used to recognise a refused option, never shown or logged
      if (res.status === 400 && this.o.format === "openai" && !this.noSchemaFormat && /response_format|json_schema/i.test(errText)) { this.noSchemaFormat = true; attempt--; continue; }
      if (res.status === 429) { last = new GeminiError("The AI service says too many requests (HTTP 429). It will retry.", "quota_minute", 429); const ra = Number(res.headers.get("retry-after")); await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : delay)); delay = Math.min(delay * 2, 30_000); continue; }
      if ([500, 502, 503, 504, 529].includes(res.status)) { last = new GeminiError(`The AI service is busy or down (HTTP ${res.status})`, "busy", res.status); await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 30_000); continue; }
      if (res.status === 401 || res.status === 403) throw new GeminiError(`The AI service rejected the key (HTTP ${res.status}). Check AI_API_KEY.`, "auth", res.status);
      if (res.status === 404) throw new GeminiError(`The AI service does not know the address or the model "${model}" (HTTP 404). Check AI_BASE_URL and AI_MODEL.`, "model", 404);
      throw new GeminiError(`The AI service refused the request (HTTP ${res.status}). Check AI_FORMAT (anthropic or openai) and AI_MODEL.`, "http", res.status);
    }
    throw last ?? new GeminiError("The AI service was unavailable after retries", "busy");
  }
}

/** Reads AI_API_KEY / AI_BASE_URL / AI_FORMAT / AI_MODEL / AI_MODEL_MEDIA, or the ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL a company gateway hands out (always the Anthropic style). */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export function chatProviderFromEnv(env: Record<string, string | undefined> = process.env): ChatProvider {
  const key = env["AI_API_KEY"] || env["ANTHROPIC_API_KEY"];
  if (!key) throw new Error("AI_API_KEY (or ANTHROPIC_API_KEY) is not set");
  const viaAnthropicVars = !env["AI_API_KEY"] && !env["AI_BASE_URL"];
  const baseUrl = env["AI_BASE_URL"] || env["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com";
  const format: ChatFormat = env["AI_FORMAT"] === "openai" ? "openai" : env["AI_FORMAT"] === "anthropic" || viaAnthropicVars || !env["AI_BASE_URL"] ? "anthropic" : "openai";
  const model = env["AI_MODEL"] || env["ANTHROPIC_MODEL"] || DEFAULT_CLAUDE_MODEL;
  return new ChatProvider(key, model, { format, baseUrl, ...(env["AI_MODEL_MEDIA"] ? { mediaModel: env["AI_MODEL_MEDIA"] } : {}) });
}

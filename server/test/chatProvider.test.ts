import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, parseJsonText, toJsonSchema, chatProviderFromEnv } from "../ai/chat";
import { GeminiError, HybridProvider, MockProvider } from "../ai/provider";

const schema = { type: "OBJECT", properties: { ok: { type: "BOOLEAN" }, x: { type: "OBJECT", nullable: true, properties: {} } }, required: ["ok"] };
const okJson = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Claude provider", () => {
  it("turns Gemini-style schemas into JSON Schema", () => {
    expect(toJsonSchema(schema)).toEqual({ type: "object", properties: { ok: { type: "boolean" }, x: { type: "object", properties: {} } }, required: ["ok"] });
  });
  it("finds JSON inside fences and sentences", () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('Here you go: {"a":1} done')).toEqual({ a: 1 });
    expect(() => parseJsonText("nothing")).toThrow();
  });
  it("anthropic style: forced tool call, key in x-api-key, images attached", async () => {
    const f = vi.fn(async () => okJson({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer", input: { ok: true } }] }));
    vi.stubGlobal("fetch", f);
    const p = new ChatProvider("sk-test", "claude-x", { format: "anthropic", baseUrl: "https://gw.example/" });
    expect(await p.generateJsonWithMedia({ system: "s", prompt: "p", schema }, [{ mimeType: "image/png", data: Buffer.from("a") }])).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    const b = JSON.parse(String(init.body));
    expect(b.tool_choice).toEqual({ type: "tool", name: "answer" });
    expect(b.messages[0].content[0].type).toBe("image");
    expect(String(init.body)).not.toContain("sk-test");
  });
  it("openai style: bearer key, schema in prompt, falls back when response_format is refused", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("response_format not supported", { status: 400 }))
      .mockResolvedValueOnce(okJson({ choices: [{ finish_reason: "stop", message: { content: '```json\n{"ok":true}\n```' } }] }));
    vi.stubGlobal("fetch", f);
    const p = new ChatProvider("sk-test", "m", { format: "openai", baseUrl: "https://gw.example/v1" });
    expect(await p.generateJson({ system: "s", prompt: "p", schema })).toEqual({ ok: true });
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    expect(JSON.parse(String(init.body)).response_format).toBeUndefined();
    expect(JSON.parse(String(init.body)).messages[0].content).toContain("JSON Schema");
  });
  it("explains a rejected key, a wrong model, and audio it cannot read", async () => {
    const p = new ChatProvider("k", "m", { format: "openai", baseUrl: "https://gw.example" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(p.generateJson({ system: "", prompt: "", schema })).rejects.toMatchObject({ kind: "auth" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(p.generateJson({ system: "", prompt: "", schema })).rejects.toMatchObject({ kind: "model" });
    expect(() => p.generateJsonWithMedia({ system: "", prompt: "", schema }, [{ mimeType: "audio/mpeg", data: Buffer.from("a") }])).toThrow(GeminiError);
  });
  it("gives up with a format error when answers keep being cut off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ stop_reason: "max_tokens", content: [{ type: "tool_use", input: { ok: true } }] })));
    await expect(new ChatProvider("k", "m").generateJson({ system: "", prompt: "", schema })).rejects.toMatchObject({ kind: "format" });
  });
  it("reads its settings from the environment", () => {
    expect(() => chatProviderFromEnv({})).toThrow(/AI_API_KEY/);
    expect(chatProviderFromEnv({ AI_API_KEY: "k", AI_MODEL: "m" }).model).toBe("m");
    const g = chatProviderFromEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://saarthi-gw.example/" }) as any; // what a company gateway hands out
    expect(g.o).toMatchObject({ format: "anthropic", baseUrl: "https://saarthi-gw.example/" });
    expect(g.model).toBe("claude-sonnet-5-5");
  });
  it("hybrid: text and pictures go to Claude, audio and video to Gemini", async () => {
    const c = new MockProvider(() => ({ from: "claude" })), g = new MockProvider(() => ({ from: "gemini" }));
    const h = new HybridProvider(c, g);
    expect(await h.generateJson({ system: "", prompt: "", schema })).toEqual({ from: "claude" });
    expect(await h.generateJsonWithMedia({ system: "", prompt: "", schema }, [{ mimeType: "image/png", data: Buffer.from("a") }])).toEqual({ from: "claude" });
    expect(await h.generateJsonWithMedia({ system: "", prompt: "", schema }, [{ mimeType: "audio/mpeg", data: Buffer.from("a") }])).toEqual({ from: "gemini" });
    expect(await h.generateJsonWithMedia({ system: "", prompt: "", schema }, [{ mimeType: "video/mp4", data: Buffer.from("a") }])).toEqual({ from: "gemini" });
  });
  it("anthropic style: drops the forced tool call when the model refuses it, and shows the gateway's reason otherwise", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Thinking may not be enabled when tool_choice forces tool use." } }), { status: 400 }))
      .mockResolvedValueOnce(okJson({ stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }] }));
    vi.stubGlobal("fetch", f);
    const p = new ChatProvider("k", "m", { format: "anthropic", baseUrl: "https://gw.example" });
    expect(await p.generateJson({ system: "s", prompt: "p", schema })).toEqual({ ok: true });
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body)).tool_choice).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "max_tokens too large for this model" } }), { status: 400 })));
    await expect(new ChatProvider("k", "m").generateJson({ system: "", prompt: "", schema })).rejects.toThrow(/max_tokens too large/);
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider, interactive } from "../ai/provider";

const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); });
const req = { system: "s", prompt: "p", schema: {} };

describe("pacing of Gemini calls", () => {
  it("spaces out background calls, but not calls made for a person waiting on an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const p = new GeminiProvider("key", "m", 400);
    await p.generateJson(req);
    let t = Date.now(); await p.generateJson(req); // background: waits for the gap
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
    t = Date.now();
    await interactive.run(true, async () => { await p.generateJson(req); await p.generateJson(req); await p.generateJson(req); });
    expect(Date.now() - t).toBeLessThan(200); // three calls in a row, no waiting
  });
});

describe("requests from a person are marked as waiting", () => {
  it("runs the AI calls made while answering a request inside the unpaced context", async () => {
    const { openDb } = await import("../db"); const { createApp } = await import("../app"); const { MockProvider } = await import("../ai/provider");
    const seen: (boolean | undefined)[] = [];
    const ai = new MockProvider(() => { seen.push(interactive.getStore()); return { keywords: ["x"], broad: false, studies: [] }; });
    const server = createApp(openDb(":memory:"), { auth: { authDisabled: true }, ai }).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      await fetch(`${base}/api/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "anything about delivery?", audience: [], mode: "combine" }) });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((x) => x === true)).toBe(true);
    } finally { server.close(); }
  });
});

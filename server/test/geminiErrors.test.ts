// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { GeminiError, GeminiProvider, MockProvider } from "../ai/provider";
import { clearAiPause, enqueueExtractions, getAiPause, runNextJob } from "../jobs";
import { extractSource } from "../ai/extract";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const okBody = (text: string, finishReason = "STOP") => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
const req = { system: "s", prompt: "p", schema: {} };
const provider = () => new GeminiProvider("key", "m", 0);
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json(200, okBody('{"ok":true}'))); vi.stubGlobal("fetch", f); return f; };
afterEach(() => { vi.unstubAllGlobals(); clearAiPause(); });
const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as GeminiError;

describe("what went wrong with Gemini is said plainly", () => {
  it("a daily quota stops at once and says so (retrying would not help)", async () => {
    const f = stub(json(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }));
    const e = await fail(provider().generateJson(req));
    expect(e).toMatchObject({ kind: "quota_day", status: 429 }); expect(e.message).toMatch(/daily free limit/);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("a per-minute limit waits as long as Google says, then carries on", async () => {
    const f = stub(json(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.05s" }] } }));
    const t = Date.now();
    expect(await provider().generateJson(req)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2); expect(Date.now() - t).toBeLessThan(2000); // not the old fixed five seconds
  });
  it("a busy Gemini is retried, then reported as busy with the status code", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    stub(json(503, { error: { status: "UNAVAILABLE" } }), json(503, {}), json(503, {}), json(503, {}));
    const run = fail(provider().generateJson(req));
    await vi.runAllTimersAsync();
    const e = await run; vi.useRealTimers();
    expect(e).toMatchObject({ kind: "busy", status: 503 }); expect(e.message).toMatch(/HTTP 503/);
  });
  it("names a rejected key, a missing model and a bad request, without echoing anything from the request", async () => {
    expect(await fail((stub(json(403, { error: { status: "PERMISSION_DENIED", message: "SECRET TEXT FROM THE REQUEST" } })), provider().generateJson(req)))).toMatchObject({ kind: "auth" });
    const missing = await fail((stub(json(404, {})), provider().generateJson(req)));
    expect(missing).toMatchObject({ kind: "model" }); expect(missing.message).toMatch(/"m"/);
    const bad = await fail((stub(json(400, { error: { status: "INVALID_ARGUMENT", message: "SECRET TEXT FROM THE REQUEST" } })), provider().generateJson(req)));
    expect(bad.message).toMatch(/HTTP 400 INVALID_ARGUMENT/); expect(bad.message).not.toMatch(/SECRET/);
  });
  it("a cut-off answer is reported after two tries, not four identical ones", async () => {
    const f = stub(json(200, okBody('{"findings":[{"qu', "MAX_TOKENS")), json(200, okBody('{"findings":[{"qu', "MAX_TOKENS")), json(200, okBody("{}")));
    const e = await fail(provider().generateJson(req));
    expect(e).toMatchObject({ kind: "format" }); expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("reading copes with it", () => {
  const seed = (n: number) => {
    const db = openDb(":memory:");
    db.exec("INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P1','S','{}','x'); INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('X1','S','P1','interview','verbatim_transcript','t','x')");
    for (let i = 0; i < n; i++) db.prepare("INSERT INTO utterances(source_id,participant_id,speaker,seq,text) VALUES ('X1','P1','participant',?,?)").run(i, `Line ${i}: ` + "word ".repeat(300));
    return db;
  };
  it("splits a piece Gemini cannot answer whole into halves, and reads every half", async () => {
    const db = seed(8); const sizes: number[] = [];
    const ai = new MockProvider((r) => { const lines = (r.prompt.match(/^\[\d+\]/gm) ?? []).length; sizes.push(lines); if (lines > 2) throw new GeminiError("cut off", "format"); return { findings: [] }; });
    const out = await extractSource(db, ai, "X1");
    expect(out.cached).toBe(false);
    expect(sizes.filter((n) => n <= 2).reduce((a, b) => a + b, 0)).toBe(8); // all 8 lines were read in the end
  });
  it("pauses everything when the daily limit is used up, keeps each job's tries, and carries on when it is checked again", async () => {
    const db = seed(1); enqueueExtractions(db);
    const dead = new MockProvider(() => { throw new GeminiError("Gemini's daily free limit is used up (HTTP 429).", "quota_day", 429); });
    await runNextJob(db, dead);
    expect(getAiPause()).toMatchObject({ reason: expect.stringMatching(/daily free limit/) });
    expect(db.prepare("SELECT status, attempts, error FROM jobs").get()).toMatchObject({ status: "queued", attempts: 0, error: expect.stringContaining("waiting") });
    expect(await runNextJob(db, new MockProvider(() => ({ findings: [] })))).toBe(false); // nothing runs while paused
    clearAiPause(); db.prepare("UPDATE jobs SET run_after=NULL").run();
    expect(await runNextJob(db, new MockProvider(() => ({ findings: [] })))).toBe(true);
    expect(db.prepare("SELECT status FROM jobs").get()).toMatchObject({ status: "done" });
  });
});

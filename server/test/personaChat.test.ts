// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { chatWithPersona, conversation, firstSentence, latestPersona, unsupportedNumbers } from "../ai/personaChat";
import { MockProvider } from "../ai/provider";

function seed() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,6,6); INSERT INTO personas(id,run_id,name,description) VALUES ('PER-1',1,'Cash Cautious','Prefers paying on delivery because of fraud worries')");
  db.exec("INSERT INTO persona_traits(persona_id,trait_type,text) VALUES ('PER-1','trust_barrier','Fears online payment fraud')");
  for (let i = 1; i <= 6; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x'); INSERT INTO persona_participants VALUES ('PER-1','${p}');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-25','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','online payment pe bharosa nahi','I do not trust online payment, I wait 6 days at most','said','participant_verbatim','payment trust','negative','approved','x');`);
  }
  return db;
}
const persona = () => latestPersona(seed(), "PER-1")!;
const ai = (over: Partial<{ reply: string; label: string; ids: number[]; study: string }> = {}, tally = { n: 0 }) => new MockProvider((req) => {
  tally.n++;
  if (req.system.includes("search over")) return { keywords: ["payment", "trust", "online"] };
  return { reply: over.reply ?? "Most of us don't trust paying online, so we pick cash on delivery.", label: over.label ?? "evidence", evidence_ids: over.ids ?? [1, 2, 3, 4, 99999], ...(over.study ? { suggested_study: over.study } : {}) };
});

describe("persona chat integrity", () => {
  it("replies from evidence: fake citations dropped, label kept when several people support it, both messages stored", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!;
    const m = await chatWithPersona(db, ai(), { userId: "u1", persona: p, text: "How do you feel about paying online?" });
    expect(m).toMatchObject({ from: "persona", label: "evidence", evidenceIds: ["1", "2", "3", "4"] });
    expect(m.suggestedStudy).toBeUndefined();
    expect(conversation(db, "u1", p).map((x) => x.from)).toEqual(["user", "persona"]);
    expect(conversation(db, "u2", p)).toEqual([]); // private to the person who chatted
  });
  it("downgrades 'evidence' to 'inference' with a suggested study when fewer than 3 people back it", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!;
    const m = await chatWithPersona(db, ai({ ids: [1, 2] }), { userId: "u1", persona: p, text: "online payment?" });
    expect(m.label).toBe("inference");
    expect(m.suggestedStudy).toMatch(/study/i);
  });
  it("downgrades when the reply contains numbers found nowhere in the evidence (invented specifics)", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!;
    const bad = await chatWithPersona(db, ai({ reply: "I usually spend about 2,500 rupees and wait 9 days." }), { userId: "u1", persona: p, text: "online payment?" });
    expect(bad.label).toBe("inference");
    const ok = await chatWithPersona(db, ai({ reply: "I'd wait 6 days at most before I cancel." }), { userId: "u1", persona: p, text: "online payment delivery?" });
    expect(ok.label).toBe("evidence"); // "6" is in the evidence
    expect(unsupportedNumbers("about 40% of us", ["no such number"])).toEqual(["40"]);
  });
  it("says so honestly when nothing matches, without asking the model to answer", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!; const tally = { n: 0 };
    const quiet = new MockProvider((req) => { tally.n++; return req.system.includes("search over") ? { keywords: ["zzzz"] } : { reply: "x", label: "evidence", evidence_ids: [1] }; });
    const m = await chatWithPersona(db, quiet, { userId: "u1", persona: p, text: "Would you prefer dark mode zzzz?" });
    expect(m).toMatchObject({ label: "no_evidence", evidenceIds: [] });
    expect(m.suggestedStudy).toMatch(/dark mode/);
    expect(tally.n).toBe(1); // only the search-keyword call
  });
  it("when the model itself says no evidence, drops any citations and keeps a suggested study", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!;
    const m = await chatWithPersona(db, ai({ label: "no_evidence", ids: [1, 2, 3], reply: "I can't say.", study: "Test gestures with this group." }), { userId: "u1", persona: p, text: "online payment gestures?" });
    expect(m).toMatchObject({ label: "no_evidence", evidenceIds: [], suggestedStudy: "Test gestures with this group." });
  });
  it("a no-evidence reply keeps only the refusal, not related findings it adds afterwards", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!;
    const m = await chatWithPersona(db, ai({ label: "no_evidence", reply: "Nothing in the research mentions timers. The evidence shows we wait for sales.", ids: [1] }), { userId: "u1", persona: p, text: "online payment timers?" });
    expect(m.text).toBe("Nothing in the research mentions timers.");
    expect(firstSentence("Mujhe nahi pata\u0964 Aur kuch.")).toBe("Mujhe nahi pata\u0964");
    expect(firstSentence("No punctuation here")).toBe("No punctuation here");
  });
  it("passes the conversation so far to the model, so follow-ups make sense", async () => {
    const db = seed(); const p = latestPersona(db, "PER-1")!; let prompt = "";
    const spy = new MockProvider((req) => { if (!req.system.includes("search over")) prompt = req.prompt; return req.system.includes("search over") ? { keywords: ["payment"] } : { reply: "r", label: "evidence", evidence_ids: [1, 2, 3] }; });
    await chatWithPersona(db, spy, { userId: "u1", persona: p, text: "How do you pay online payment?" });
    await chatWithPersona(db, spy, { userId: "u1", persona: p, text: "Why online payment?" });
    expect(prompt).toContain("Team: How do you pay online payment?");
    expect(prompt).toContain("Fears online payment fraud"); // research-derived profile
  });
});

describe("persona chat API", () => {
  let server: Server; let base = ""; const db = seed();
  beforeAll(() => { server = createApp(db, { ai: ai(), auth: { authDisabled: true } }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
  afterAll(() => server.close());
  const j = (p: string, body?: unknown) => fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  it("validates input and unknown personas", async () => {
    expect((await j("/api/personas/PER-1/messages", { text: "  " })).status).toBe(400);
    expect((await j("/api/personas/NOPE/messages", { text: "hi" })).status).toBe(404);
    expect((await j("/api/personas/NOPE/conversation")).status).toBe(404);
  });
  it("chats, remembers, lists in saved work, and follows the persona across an audience rebuild", async () => {
    const r = await j("/api/personas/PER-1/messages", { text: "How do you feel about online payment?" });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ from: "persona", label: "evidence" });
    expect((await j("/api/personas/PER-1/conversation")).body).toHaveLength(2);
    // audiences rebuilt: same persona name, new id
    db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-09','m',0,6,6); INSERT INTO personas(id,run_id,name,description) VALUES ('PER-2',2,'Cash Cautious','rebuilt')");
    expect((await j("/api/personas/PER-2/conversation")).body).toHaveLength(2); // history carried over by name
    const saved = (await j("/api/saved-work")).body.find((x: any) => x.type === "persona_chat");
    expect(saved).toMatchObject({ title: "Conversation with Cash Cautious", target: { to: "/persona-chat", persona: "PER-2" } });
  });
  it("reports unavailable AI honestly", async () => {
    const s2 = createApp(db, { ai: null, auth: { authDisabled: true } }).listen(0);
    const r = await fetch(`http://127.0.0.1:${(s2.address() as any).port}/api/personas/PER-1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(503); s2.close();
  });
});

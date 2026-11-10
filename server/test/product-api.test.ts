// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { MockProvider } from "../ai/provider";

const db = openDb(":memory:");
let server: Server; let base = "";
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const ai = new MockProvider((req) => req.system.includes("search over") ? { keywords: ["delivery"] } : {
  headline: "h", summary: "s", signals: Array.from({ length: 12 }, (_, i) => ({ evidence_id: i + 1, signal: i < 10 ? "negative" : "positive" })),
  patterns: [{ title: "t", summary: "s", signal: "risk", label: "evidence", evidence_ids: [1, 11] }], unknowns: [], implications: imps });

beforeAll(async () => {
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  for (let i = 1; i <= 12; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-20','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','delivery late','late delivery','said','participant_verbatim','delivery','negative','approved','x');`);
  }
  db.exec(`INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,12,12);
    INSERT INTO personas(id,run_id,name,description) VALUES ('PER-1',1,'Cash Cautious','desc');
    INSERT INTO persona_participants VALUES ('PER-1','P001'),('PER-1','P002'),('PER-1','P003');
    INSERT INTO persona_traits(persona_id,trait_type,text) VALUES ('PER-1','gap','unknown thing');`);
  server = createApp(db, { ai }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
const call = (p: string, init?: RequestInit) => fetch(base + p, { headers: { "content-type": "application/json" }, ...init });

describe("product API", () => {
  it("profile: 404 before save, validated, round-trips", async () => {
    expect((await call("/api/profile")).status).toBe(404);
    expect((await call("/api/profile", { method: "PUT", body: JSON.stringify({ role: "hacker", team: "t", area: "a" }) })).status).toBe(400);
    await call("/api/profile", { method: "PUT", body: JSON.stringify({ role: "designer", team: "Shopping", area: "PDP" }) });
    expect(await (await call("/api/profile")).json()).toMatchObject({ role: "designer", team: "Shopping" });
  });
  it("audiences list and detail come from the latest synthesis; counts are unique participants", async () => {
    const list = await (await call("/api/audiences")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ref: { kind: "persona", id: "PER-1", participants: 3 }, gaps: ["unknown thing"] });
    expect((await call("/api/audiences/persona/nope")).status).toBe(404);
    const aud = [{ kind: "persona", id: "PER-1", name: "x", participants: 3 }];
    expect(await (await call("/api/audiences/count", { method: "POST", body: JSON.stringify({ audience: [...aud, ...aud] }) })).json()).toEqual({ count: 3 });
    expect(await (await call("/api/audiences/count", { method: "POST", body: JSON.stringify({ audience: [] }) })).json()).toEqual({ count: 12 });
  });
  it("ask -> answer -> evidence with stances -> saved work", async () => {
    const r = await call("/api/answers", { method: "POST", body: JSON.stringify({ question: "Will late delivery matter?", audience: [], mode: "combine", attachments: [] }) });
    const { id } = await r.json();
    const ans = await (await call(`/api/answers/${id}`)).json();
    expect(ans.variant).toBe("standard");
    expect(ans.confidence.participants).toBe(12);
    const ev = await (await call("/api/evidence?ids=1,11")).json();
    expect(ev.map((e: any) => [e.id, e.stance])).toEqual([["1", "supports"], ["11", "contradicts"]]);
    expect((await (await call("/api/saved-work")).json())[0]).toMatchObject({ id, type: "answer" });
    expect((await call("/api/answers/none")).status).toBe(404);
    expect((await call("/api/answers", { method: "POST", body: JSON.stringify({ question: "" }) })).status).toBe(400);
  });
  it("reports unavailable AI honestly", async () => {
    const s2 = createApp(db, { ai: null }).listen(0);
    const r = await fetch(`http://127.0.0.1:${(s2.address() as any).port}/api/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q" }) });
    expect(r.status).toBe(503); s2.close();
  });
});

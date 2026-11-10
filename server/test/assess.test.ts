// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { MockProvider } from "../ai/provider";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-assess-"));
const db = openDb(":memory:");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const A = { kind: "persona", id: "PER-A", name: "Price Watchers", participants: 12 };

// 12 participants talk about price/discount; only 2 talk about the countdown timer
function seed() {
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,14,12); INSERT INTO personas(id,run_id,name,description) VALUES ('PER-A',1,'Price Watchers','d')");
  for (let i = 1; i <= 12; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x'); INSERT INTO persona_participants VALUES ('PER-A','${p}');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-25','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','discount dekhta hoon','I look at the discount price first','said','participant_verbatim','price','positive','approved','x');`);
    if (i <= 2) db.exec(`INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','timer se jaldi','countdown timer feels pushy','said','participant_verbatim','urgency','negative','approved','x')`);
  }
}
let server: Server; let base = "";
const ai = new MockProvider((req) => {
  if (req.system.includes("UX analyst")) return { design_title: "Product card", design_summary: "A product card", elements: [
    { title: "Price", description: "discount price", box_2d: [100, 100, 200, 300], search_terms: ["discount", "price"] },
    { title: "Countdown timer", description: "timer", box_2d: [500, 50, 400, 20], search_terms: ["timer", "countdown"] }] };
  const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
  return { headline: "Likely positive", summary: "s", elements: [
    { index: 1, signal: "strong", summary: "price is welcomed", evidence_ids: ids.filter((i) => i <= 14).slice(0, 8) },
    { index: 2, signal: "risk", summary: "timer feels pushy", evidence_ids: ids.slice(-2).concat([99999]) }],
    signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })), unknowns: [{ title: "u", body: "b" }], implications: imps };
});
beforeAll(() => { seed(); server = createApp(db, { auth: { authDisabled: true }, ai, assetsDir: dir }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const post = (body: unknown) => fetch(`${base}/api/assessments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const upload = { kind: "upload", name: "card.png", mimeType: "image/png", data: PNG.toString("base64") };

describe("assess design", () => {
  it("annotates elements with enough evidence, moves thin ones to 'what we don't know', stores the image", async () => {
    const r = await post({ prototype: upload, task: "Buy a product", audience: [A] });
    expect(r.status).toBe(200);
    const { id } = await r.json();
    const a = await (await fetch(`${base}/api/assessments/${id}`)).json();
    expect(a.prototype).toMatchObject({ kind: "upload", mimeType: "image/png" });
    expect(a.annotations.map((x: any) => x.title)).toEqual(["Price"]); // timer: 2 participants < 3
    expect(a.annotations[0]).toMatchObject({ signal: "strong", box: [100, 100, 200, 300] });
    expect(a.annotations[0].participants).toBeGreaterThanOrEqual(3);
    expect(a.unknowns.map((u: any) => u.title)).toContain("Countdown timer");
    expect(a.confidence).toMatchObject({ methodStatus: "computed_v1" });
    expect(a.confidence.participants).toBeGreaterThanOrEqual(8); // at most 8 evidence items are retrieved per element
    const img = await fetch(`${base}/api/assessments/${id}/image`);
    expect(img.status).toBe(200); expect(img.headers.get("content-type")).toMatch(/png/);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });
  it("shows up in saved work and its evidence gets stances", async () => {
    const list = await (await fetch(`${base}/api/saved-work`)).json();
    expect(list[0]).toMatchObject({ type: "assessment", target: { to: "/assess/$id" } });
    const ev = await (await fetch(`${base}/api/evidence?ids=1`)).json();
    expect(ev[0].stance).toBe("supports");
  });
  it("refuses Figma links, non-images, missing audience, oversized or empty input honestly", async () => {
    expect((await post({ prototype: { kind: "figma_link", url: "https://figma.com/x" }, task: "t", audience: [A] })).status).toBe(422);
    expect((await post({ prototype: { ...upload, mimeType: "application/pdf" }, task: "t", audience: [A] })).status).toBe(400);
    expect((await post({ prototype: upload, task: "t", audience: [] })).status).toBe(400);
    expect((await post({ prototype: upload, task: "", audience: [A] })).status).toBe(400);
    expect((await post({ prototype: { ...upload, data: "" }, task: "t", audience: [A] })).status).toBe(400);
  });
});

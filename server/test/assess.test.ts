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
  it("assesses several screens together and keeps each picture and marker on its own screen", async () => {
    const r = await post({ screens: [{ ...upload, name: "one.png" }, { ...upload, name: "two.png" }], task: "Buy a product", audience: [A] });
    expect(r.status).toBe(200);
    const { id } = await r.json();
    const a = await (await fetch(`${base}/api/assessments/${id}`)).json();
    expect(a.screens.map((x: any) => x.name)).toEqual(["one.png", "two.png"]);
    expect(a.title).toMatch(/2 screens/);
    expect(a.annotations.every((x: any) => x.screen === 0 || x.screen === 1)).toBe(true);
    expect((await fetch(`${base}/api/assessments/${id}/image?screen=1`)).status).toBe(200);
    expect((await fetch(`${base}/api/assessments/${id}/image?screen=2`)).status).toBe(404);
    const one = await (await post({ prototype: upload, task: "t", audience: [A] })).json();
    expect((await fetch(`${base}/api/assessments/${one.id}/image?screen=1`)).status).toBe(404);
    expect((await post({ screens: Array(7).fill(upload), task: "t", audience: [A] })).status).toBe(400);
  });
  it("puts each element's marker on the screen it was seen on", async () => {
    const ai2 = new MockProvider((req) => {
      if (req.system.includes("UX analyst")) { const n = /screen (\d)/.exec(req.prompt)?.[1] ?? "1"; return { design_title: "Flow", design_summary: `s${n}`, elements: [{ title: `Price ${n}`, description: "price", box_2d: [100, 100, 200, 300], search_terms: ["discount", "price"] }] }; }
      const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
      return { headline: "Likely positive", summary: "s", elements: [1, 2].map((i) => ({ index: i, signal: "strong", summary: "ok", evidence_ids: ids.slice(0, 8) })), signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })), unknowns: [], implications: imps };
    });
    const s = createApp(db, { auth: { authDisabled: true }, ai: ai2, assetsDir: dir }).listen(0);
    try {
      const u = `http://127.0.0.1:${(s.address() as any).port}/api/assessments`;
      const { id } = await (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [upload, upload], task: "t", audience: [A] }) })).json();
      const a = await (await fetch(`${base}/api/assessments/${id}`)).json();
      expect(a.annotations.map((x: any) => [x.title, x.screen])).toEqual([["Price 1", 0], ["Price 2", 1]]);
    } finally { s.close(); }
  });
  it("refuses Figma links, non-images, missing audience, oversized or empty input honestly", async () => {
    expect((await post({ prototype: { kind: "figma_link", url: "https://figma.com/x" }, task: "t", audience: [A] })).status).toBe(422);
    expect((await post({ prototype: { ...upload, mimeType: "application/pdf" }, task: "t", audience: [A] })).status).toBe(400);
    expect((await post({ prototype: upload, task: "t", audience: [] })).status).toBe(400);
    expect((await post({ prototype: upload, task: "", audience: [A] })).status).toBe(400);
    expect((await post({ prototype: { ...upload, data: "" }, task: "t", audience: [A] })).status).toBe(400);
  });
});

describe("Figma links", () => {
  const KEY = "AbCdEfGhIjKlMn";
  const S3 = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/img/frame.png";
  const fake = (status = 200) => async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    if (status !== 200 && url.startsWith("https://api.figma.com")) return { ok: false, status, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    if (url.includes("/nodes?")) return ok({ nodes: { "1:2": { document: { name: "Checkout" } } } });
    if (url.includes("/v1/images/")) return ok({ images: Object.fromEntries(decodeURIComponent(url.split("ids=")[1]!.split("&")[0]!).split(",").map((id) => [id, S3])) });
    if (url === S3) return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) };
    if (url.includes(`/v1/files/${KEY}?depth=2`)) return ok({ document: { children: [{ children: [{ id: "5:1", name: "Home", type: "FRAME" }, { id: "5:2", name: "Cart", type: "FRAME" }, { id: "5:3", name: "note", type: "TEXT" }] }] } });
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const withFigma = (token: string | undefined, f: any) => { const s = createApp(db, { auth: { authDisabled: true }, ai, assetsDir: dir, ...(token ? { figmaToken: token } : {}), figmaFetch: f }).listen(0); return { s, url: `http://127.0.0.1:${(s.address() as any).port}/api/assessments` }; };
  const send = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const link = `https://www.figma.com/proto/${KEY}/Flow?node-id=1-2&starting-point-node-id=1-2`;

  it("fetches the linked frame and assesses it like an uploaded image", async () => {
    const { s, url } = withFigma("tok", fake());
    try {
      const r = await send(url, { figmaUrl: link, task: "Buy a product", audience: [A] });
      expect(r.status).toBe(200);
      const { id } = await r.json();
      const a = await (await fetch(`${base}/api/assessments/${id}`)).json();
      expect(a.prototype).toEqual({ kind: "figma_link", url: link });
      expect(a.screens).toEqual([{ name: "Checkout", mimeType: "image/png", source: "figma" }]);
      expect((await fetch(`${base}/api/assessments/${id}/image`)).status).toBe(200);
    } finally { s.close(); }
  });
  it("combines uploaded images with a link, and takes the first frames when the link names none", async () => {
    const { s, url } = withFigma("tok", fake());
    try {
      const r = await send(url, { figmaUrl: `https://figma.com/design/${KEY}/File`, screens: [upload], task: "t", audience: [A] });
      const a = await (await fetch(`${base}/api/assessments/${(await r.json()).id}`)).json();
      expect(a.screens.map((x: any) => x.source)).toEqual(["upload", "figma", "figma"]); // Home and Cart, not the text layer
    } finally { s.close(); }
  });
  it("says plainly what is wrong: no token, bad link, no access, not found", async () => {
    const none = withFigma(undefined, fake());
    try { const r = await send(none.url, { figmaUrl: link, task: "t", audience: [A] }); expect(r.status).toBe(422); expect((await r.json()).error).toMatch(/FIGMA_TOKEN/); } finally { none.s.close(); }
    const ok = withFigma("tok", fake());
    try { const r = await send(ok.url, { figmaUrl: "https://example.com/design/x", task: "t", audience: [A] }); expect(r.status).toBe(422); expect((await r.json()).error).toMatch(/Figma link/); } finally { ok.s.close(); }
    const denied = withFigma("tok", fake(403));
    try { const r = await send(denied.url, { figmaUrl: link, task: "t", audience: [A] }); expect(r.status).toBe(422); expect((await r.json()).error).toMatch(/won't let the access token/); } finally { denied.s.close(); }
    const missing = withFigma("tok", fake(404));
    try { const r = await send(missing.url, { figmaUrl: link, task: "t", audience: [A] }); expect(r.status).toBe(422); expect((await r.json()).error).toMatch(/couldn't find/i); } finally { missing.s.close(); }
  });
});

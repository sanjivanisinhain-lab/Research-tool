// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { listLinks } from "../sheets";

const HEAD = ["Participant ID", "Name", "Number", "Transcript", "Data available", "Study", "City", "Call date", "Call status (your sheet)", "Notes (your sheet)", "Match check"];
const T1 = "Interviewer: Kahan se shop karte ho?\n Participant: Mostly Myntra, aur Asha bhi mere saath dekhti hai. Reviews dekhti hoon pehle.";
const grid = (): (string | Date)[][] => [
  HEAD,
  ["GZI-01", "Asha", "", T1, "Transcript only", "Gen Z - In-person interviews", "Jaipur", new Date("2026-11-04"), "", "Machine-transcribed", "Audio greets Bimla"],
  [],
  ["CIN-01", "", "", "", "Notes only", "COD research - Calling Insights (Sept)", "Kota", "24-09-2026", "Connected", "no issues, uses cod because trust", ""],
];
async function xlsx(rows: (string | Date)[][], tab = "Participant hub", extra?: { title: string; rows: string[][] }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tab);
  rows.forEach((r, i) => { if (r.length) ws.getRow(i + 1).values = ["", ...r] as any; });
  if (extra) { const w2 = wb.addWorksheet(extra.title); extra.rows.forEach((r, i) => { w2.getRow(i + 1).values = ["", ...r] as any; }); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let db: Db; let server: Server; let base = ""; let dir: string;
beforeEach(() => { db = openDb(":memory:"); dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-up-")); server = createApp(db, { auth: { authDisabled: true }, termsPath: path.join(dir, "terms.json"), pendingDir: path.join(dir, "pending") }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
afterEach(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const put = (buf: Buffer, name = "Research data hub.xlsx") => fetch(`${base}/api/admin/upload?study=x&product=p&kind=cx_call&filename=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf as unknown as BodyInit });
const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const info = async () => (await (await fetch(base + "/api/admin/sheets")).json()) as { configured: boolean; links: any[] };

describe("a participant sheet uploaded as an Excel file", () => {
  it("is held for review first, and nothing is stored from it until Import", async () => {
    const r = await put(await xlsx(grid()));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "review", sourcesAdded: 0, format: "participant sheet" });
    expect((db.prepare("SELECT COUNT(*) n FROM sources").get() as { n: number }).n).toBe(0);
    const i = await info();
    expect(i.configured).toBe(false); // works without any Google setup
    expect(i.links[0]).toMatchObject({ source: "upload", name: "Research data hub", imported: false, lastStatus: "preview" });
    expect(i.links[0].preview).toMatchObject({ rows: 2, transcripts: 1, notes: 1 });
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(1); // the file waits here until it is imported
  });

  it("keeps real row numbers (blank rows count) and dates, imports on request, then deletes the held file", async () => {
    await put(await xlsx(grid()));
    const id = (await info()).links[0].id;
    const imp = await (await post(`/api/admin/sheets/${id}/sync`, { import: true })).json();
    expect(imp).toMatchObject({ ok: true, added: 2 });
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(0);
    const rows = db.prepare("SELECT external_id e, row_number n FROM sheet_rows ORDER BY row_number").all() as { e: string; n: number }[];
    expect(rows).toEqual([{ e: "GZI-01", n: 2 }, { e: "CIN-01", n: 4 }]); // row 3 was blank in the file
    expect(db.prepare("SELECT date FROM sources WHERE title='GZI-01 · transcript'").get()).toMatchObject({ date: "2026-11-04" });
    const view = await (await fetch(`${base}/api/sheets/${id}/view`)).json();
    expect(JSON.stringify(view)).not.toMatch(/Asha|Jaipur|Bimla/);
  });

  it("an updated file brings in only what changed, by Participant ID, without a second review", async () => {
    await put(await xlsx(grid()));
    const id = (await info()).links[0].id;
    await post(`/api/admin/sheets/${id}/sync`, { import: true });
    const next = grid();
    next[3]![9] = "uses cod because trust, but now also trusts prepaid after a good delivery";
    next.push(["GZP-01", "Meena", "9876543210", "", "Notes only", "Gen Z - Phone calls (tier 2/3)", "Udaipur", "05-11-2026", "connected", "Buys sarees online, does not trust prepaid", ""]);
    const r = await (await put(await xlsx(next), "Research data hub (1).xlsx")).json();
    expect(r).toMatchObject({ status: "processed" });
    expect(r.message).toMatch(/1 new, 1 edited/);
    expect((await info()).links).toHaveLength(1); // same link, not a second one
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(0);
  });

  it("walks through names and import with no Google client at all", async () => {
    const g = grid(); g[1]![3] = T1 + "\n Participant: Seema ne bhi dekha tha.";
    await put(await xlsx(g));
    const id = (await info()).links[0].id;
    const again = await (await post(`/api/admin/sheets/${id}/names`, { names: ["Seema"] })).json();
    expect(again.preview.names.map((n: any) => n.word)).not.toContain("Seema");
    await post(`/api/admin/sheets/${id}/sync`, { import: true });
    expect((db.prepare("SELECT group_concat(text,' ') t FROM utterances").get() as { t: string }).t).not.toContain("Seema");
  });

  it("asks again if the held file has gone, and ignores hidden tabs and non-participant tabs", async () => {
    await put(await xlsx(grid(), "Participant hub", { title: "Summary", rows: [["Study", "Count"], ["x", "1"]] }));
    const id = (await info()).links[0].id;
    expect(listLinks(db)[0]!.tabs).toEqual([]); // nothing imported yet
    fs.rmSync(path.join(dir, "pending"), { recursive: true });
    const r = await post(`/api/admin/sheets/${id}/sync`, { import: true });
    expect(r.status).toBe(422); expect((await r.json()).error).toMatch(/Upload it again/);
  });

  it("also reads a CSV export of that tab, and still reads old call-notes files the old way", async () => {
    const csv = grid().map((r) => r.map((c) => `"${String(c instanceof Date ? "2026-11-04" : c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const r = await (await put(Buffer.from(csv), "hub.csv")).json();
    expect(r).toMatchObject({ status: "review" });
    const old = await (await put(Buffer.from("Name,City,Product Name,Date,Notes\nRenu,Jaipur,Saree,12-11-2026,\"Renu ji bola discount dekhti hoon\""), "calls.csv")).json();
    expect(old).toMatchObject({ status: "processed", sourcesAdded: 1 });
  });
});

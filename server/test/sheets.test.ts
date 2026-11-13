// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { GoogleError, GoogleSheets, parseSheetUrl, type SheetsClient } from "../google";
import { createLink, listLinks, sheetRefs, sheetView, syncSheet } from "../sheets";
import { ingestCallsCsv } from "../ingest";

const HEAD = ["Name", "City", "Mobile Number", "Product Name", "Date", "Notes", "Type of user"];
const row = (n: number, name = "Renu", notes?: string) => [name, "Jaipur", "9876543210", "Saree", "12/11/2026", notes ?? `${name} ji bola discount dekhti hoon pehle, order ${n}`, "New"];
const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

/** A fake Google: `tabs` is what the sheet currently contains. */
function fake(tabs: Record<string, string[][]>, hidden: string[] = []): SheetsClient & { tabs: Record<string, string[][]>; fail?: GoogleError } {
  const c = {
    serviceAccountEmail: "robot@proj.iam.gserviceaccount.com", tabs, fail: undefined as GoogleError | undefined,
    async spreadsheet() { if (c.fail) throw c.fail; return { title: "CX calls", tabs: Object.keys(c.tabs).map((t, i) => ({ title: t, gid: String(100 + i), hidden: hidden.includes(t) })) }; },
    async values(_id: string, tab: string) { return c.tabs[tab]!.map((r) => [...r]); },
  };
  return c;
}
let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
const link = (name = "CX calls") => createLink(db, { url: `https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`, name });
const jobs = () => (db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='extract' AND status='queued'").get() as { n: number }).n;
const status = (sid: string) => (db.prepare("SELECT status FROM sources WHERE id=?").get(sid) as { status: string }).status;

describe("syncing a Google Sheet", () => {
  it("adds rows as research-team sources, queues them for reading, and keeps only a redacted copy", async () => {
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); const id = link();
    const r = await syncSheet(db, g, id);
    expect(r).toMatchObject({ ok: true, added: 2 });
    expect(jobs()).toBe(2);
    const v = sheetView(db, id, { tab: "Calls" })!;
    expect(v.header).toEqual(HEAD);
    expect(v.rows).toHaveLength(2);
    const [first] = v.rows;
    expect(first!.cells[0]).toBe("[removed]"); expect(first!.cells[1]).toBe("[removed]"); expect(first!.cells[2]).toBe("[removed]"); // name, city, number
    const all = JSON.stringify(v);
    for (const secret of ["Renu", "Meena", "Jaipur", "9876543210"]) expect(all).not.toContain(secret);
    expect(first!.cells[5]).toContain("discount dekhti hoon");
    expect(first!.participantId).toMatch(/^P\d+$/);
    const src = db.prepare("SELECT status, submitted_by, date FROM sources").get() as any;
    expect(src).toMatchObject({ status: "approved", submitted_by: "research_team", date: "2026-11-12" });
  });

  it("does nothing the second time, and adds only new rows after that", async () => {
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); const id = link();
    await syncSheet(db, g, id);
    expect(await syncSheet(db, g, id)).toMatchObject({ added: 0, edited: 0, removed: 0, unchanged: 2, message: "Synced: no changes." });
    g.tabs["Calls"]!.push(row(3, "Seema"));
    expect(await syncSheet(db, g, id)).toMatchObject({ added: 1, unchanged: 2 });
    expect((db.prepare("SELECT COUNT(*) n FROM sources").get() as { n: number }).n).toBe(3);
  });

  it("follows rows that move (sorting, inserting above) without re-reading them", async () => {
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena"), row(3, "Seema")] }); const id = link();
    await syncSheet(db, g, id);
    const [h, a, b, c] = g.tabs["Calls"]!; g.tabs["Calls"] = [h!, c!, b!, a!]; // reversed
    expect(await syncSheet(db, g, id)).toMatchObject({ added: 0, edited: 0, removed: 0, unchanged: 3 });
    const v = sheetView(db, id, {})!;
    expect(v.rows.map((x) => x.cells[5]!.match(/order (\d)/)![1])).toEqual(["3", "2", "1"]);
  });

  it("re-reads an edited row: the old reading is withdrawn and the new text becomes a new source", async () => {
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); const id = link();
    await syncSheet(db, g, id);
    const old = (db.prepare("SELECT source_id s FROM sheet_rows WHERE row_number=3").get() as { s: string }).s;
    db.prepare("INSERT INTO participants SELECT 'PX', id, '{}', 'x' FROM studies LIMIT 1").run();
    db.prepare("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES (?, 'PX','t','said','researcher_note','x','neutral','approved','x')").run(old);
    g.tabs["Calls"]![2] = row(2, "Meena", "Meena ji ne kaha delivery late hoti hai, mujhe COD chahiye");
    const r = await syncSheet(db, g, id);
    expect(r).toMatchObject({ edited: 1, added: 1 });
    expect(status(old)).toBe("rejected");
    expect((db.prepare("SELECT status, review_note n FROM evidence WHERE source_id=?").get(old) as any)).toMatchObject({ status: "rejected" });
    const now = (db.prepare("SELECT source_id s FROM sheet_rows WHERE row_number=3").get() as { s: string }).s;
    expect(now).not.toBe(old); expect(status(now)).toBe("approved");
    expect(sheetView(db, id, {})!.rows[1]!.cells[5]).toContain("COD chahiye");
  });

  it("flags removed rows instead of erasing them, and revives one that comes back", async () => {
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); const id = link();
    await syncSheet(db, g, id);
    const sid = (db.prepare("SELECT source_id s FROM sheet_rows WHERE row_number=3").get() as { s: string }).s;
    const kept = g.tabs["Calls"]!.pop()!;
    expect(await syncSheet(db, g, id)).toMatchObject({ removed: 1 });
    expect(status(sid)).toBe("approved"); // the evidence stays; the sheet row is flagged
    expect(sheetView(db, id, {})!.rows.map((x) => x.removed)).toEqual([false, true]);
    expect(sheetRefs(db, [sid]).get(sid)).toMatchObject({ row: 3, removed: true });
    g.tabs["Calls"]!.push(kept);
    expect(await syncSheet(db, g, id)).toMatchObject({ added: 0, unchanged: 2 });
    expect(sheetView(db, id, {})!.rows.map((x) => x.removed)).toEqual([false, false]);
  });

  it("stops and asks when many rows seem to have changed at once, and applies when told", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, "Asha"));
    const g = fake({ Calls: [HEAD, ...rows] }); const id = link();
    await syncSheet(db, g, id);
    for (let i = 1; i <= 4; i++) g.tabs["Calls"]![i] = row(i, "Asha", `Asha ji changed their mind about row ${i}`);
    const held = await syncSheet(db, g, id);
    expect(held).toMatchObject({ ok: false, status: "needs_confirmation", edited: 4 });
    expect((db.prepare("SELECT COUNT(*) n FROM sources WHERE status='rejected'").get() as { n: number }).n).toBe(0);
    expect(listLinks(db)[0]).toMatchObject({ lastStatus: "needs_confirmation" });
    expect(await syncSheet(db, g, id, { force: true })).toMatchObject({ ok: true, edited: 4, added: 4 });
  });

  it("recognises notes that were already imported from a file, and links them instead of duplicating", async () => {
    ingestCallsCsv(db, `Name,City,Product Name,Date,Notes\nRenu,Jaipur,Saree,12-11-2026,"Renu ji bola discount dekhti hoon pehle, order 1"`, { studyName: "CX calls", product: "Snapdeal" });
    const g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); const id = link();
    expect(await syncSheet(db, g, id)).toMatchObject({ added: 1, linked: 1 });
    expect((db.prepare("SELECT COUNT(*) n FROM sources").get() as { n: number }).n).toBe(2);
  });

  it("uses each visible tab that has a Notes column, and says so when none do", async () => {
    const g = fake({ Calls: [HEAD, row(1)], Hidden: [HEAD, row(9, "Zed")], Summary: [["Metric", "Value"], ["calls", "10"]] }, ["Hidden"]); const id = link();
    expect(await syncSheet(db, g, id)).toMatchObject({ ok: true, added: 1 });
    expect(listLinks(db)[0]!.tabs.map((t) => t.title)).toEqual(["Calls"]);
    const none = fake({ Summary: [["Metric", "Value"], ["calls", "10"]] });
    const db2 = db; db = openDb(":memory:"); const id2 = createLink(db, { url: SID, name: "x" });
    expect(await syncSheet(db, none, id2)).toMatchObject({ ok: false, status: "error", message: expect.stringMatching(/Notes/) });
    db = db2;
  });

  it("turns a Google refusal into a plain message and keeps what it had", async () => {
    const g = fake({ Calls: [HEAD, row(1)] }); const id = link();
    await syncSheet(db, g, id);
    g.fail = new GoogleError("Google won't let the service account open this sheet. Share it.");
    const r = await syncSheet(db, g, id);
    expect(r).toMatchObject({ ok: false, status: "error", message: expect.stringMatching(/Share it/) });
    expect(sheetView(db, id, {})!.rows).toHaveLength(1);
  });
});

describe("the sheet view and source links over the API", () => {
  let server: Server; let base = ""; let g: ReturnType<typeof fake>;
  beforeEach(() => { g = fake({ Calls: [HEAD, row(1), row(2, "Meena")] }); server = createApp(db, { auth: { authDisabled: true }, googleSheets: g }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
  afterEach(() => { server.close(); });
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("links a sheet, syncs it, serves the redacted grid, and attaches the row to evidence", async () => {
    const r = await post("/api/admin/sheets", { url: `https://docs.google.com/spreadsheets/d/${SID}/edit`, name: "CX calls Nov" });
    expect(r.status).toBe(200);
    const { id, sync } = await r.json();
    expect(sync).toMatchObject({ ok: true, added: 2 });
    const info = await (await fetch(base + "/api/admin/sheets")).json();
    expect(info).toMatchObject({ configured: true, serviceAccountEmail: "robot@proj.iam.gserviceaccount.com" });
    expect(info.links[0]).toMatchObject({ id, name: "CX calls Nov", rows: 2, lastStatus: "ok" });
    const view = await (await fetch(`${base}/api/sheets/${id}/view?tab=Calls&from=2&limit=1`)).json();
    expect(view.rows.map((x: any) => x.row)).toEqual([2]); expect(view.hasNext).toBe(true); expect(view.hasPrev).toBe(false); // the header row is row 1
    const later = await (await fetch(`${base}/api/sheets/${id}/view?tab=Calls&from=3&limit=1`)).json();
    expect(later.rows.map((x: any) => x.row)).toEqual([3]); expect(later.hasNext).toBe(false); expect(later.hasPrev).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/Renu|Jaipur|9876543210/);
    // evidence from that row points back to it
    const src = (db.prepare("SELECT source_id s, participant_id p FROM sheet_rows r JOIN sources so ON so.id=r.source_id WHERE row_number=3").get() as any);
    db.prepare("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES (?,?,?,'said','researcher_note','price','neutral','approved','x')").run(src.s, src.p, "discount dekhti hoon");
    const evId = (db.prepare("SELECT id FROM evidence").get() as { id: number }).id;
    const ev = await (await fetch(`${base}/api/evidence?ids=${evId}`)).json();
    expect(ev[0].sheet).toEqual({ linkId: id, name: "CX calls Nov", tab: "Calls", row: 3, removed: false });
  });
  it("explains each way linking can fail", async () => {
    const bad = await post("/api/admin/sheets", { url: "https://example.com/x", name: "x" });
    expect(bad.status).toBe(422); expect((await bad.json()).error).toMatch(/Google Sheets link/);
    g.fail = new GoogleError("Google won't let the service account open this sheet. Share robot@proj.iam.gserviceaccount.com as Viewer.");
    const denied = await post("/api/admin/sheets", { url: SID, name: "x" });
    expect(denied.status).toBe(422); expect((await denied.json()).error).toMatch(/robot@proj/);
    g.fail = undefined;
    await post("/api/admin/sheets", { url: SID, name: "x" });
    const twice = await post("/api/admin/sheets", { url: SID, name: "y" });
    expect((await twice.json()).error).toMatch(/already linked/);
    expect((await fetch(`${base}/api/sheets/nope/view`)).status).toBe(404);
  });
  it("can be paused, and 'apply anyway' passes through", async () => {
    const { id } = await (await post("/api/admin/sheets", { url: SID, name: "x" })).json();
    expect((await fetch(`${base}/api/admin/sheets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await (await fetch(base + "/api/admin/sheets")).json()).links[0].enabled).toBe(false);
    expect((await (await post(`/api/admin/sheets/${id}/sync`, { force: true })).json()).ok).toBe(true);
  });
});

describe("Google access", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  it("parses sheet links", () => {
    expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${SID}/edit#gid=0`)).toBe(SID);
    expect(parseSheetUrl(SID)).toBe(SID);
    for (const bad of ["", "https://example.com/spreadsheets/d/" + SID, "http://docs.google.com/spreadsheets/d/" + SID, "https://docs.google.com/document/d/" + SID]) expect(parseSheetUrl(bad)).toBeNull();
  });
  it("signs in as the service account, reads values, and names the account to share with on a refusal", async () => {
    const calls: { url: string; body?: string; auth?: string }[] = [];
    let denied = false;
    const g = new GoogleSheets({ client_email: "robot@proj.iam.gserviceaccount.com", private_key: privateKey }, async (url, init) => {
      calls.push({ url, ...(init?.body ? { body: init.body } : {}), ...(init?.headers?.["Authorization"] ? { auth: init.headers["Authorization"] } : {}) });
      if (url.startsWith("https://oauth2.googleapis.com")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      if (denied) return { ok: false, status: 403, json: async () => ({}) };
      if (url.includes("/values/")) return { ok: true, status: 200, json: async () => ({ values: [["Notes"], ["hello", null]] }) };
      return { ok: true, status: 200, json: async () => ({ properties: { title: "T" }, sheets: [{ properties: { title: "Calls", sheetId: 7 } }] }) };
    });
    expect(await g.spreadsheet(SID)).toEqual({ title: "T", tabs: [{ title: "Calls", gid: "7", hidden: false }] });
    expect(await g.values(SID, "Ca'lls")).toEqual([["Notes"], ["hello", ""]]);
    expect(calls[0]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(calls[0]!.body).get("assertion")!;
    expect(JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString())).toMatchObject({ iss: "robot@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/spreadsheets.readonly" });
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1); // the token is reused
    expect(calls[1]!.auth).toBe("Bearer tok");
    expect(decodeURIComponent(calls[2]!.url)).toContain("'Ca''lls'!A:ZZ"); // quotes in tab names are escaped
    denied = true;
    await expect(g.spreadsheet(SID)).rejects.toThrow(/robot@proj\.iam\.gserviceaccount\.com as a Viewer/);
  });
});

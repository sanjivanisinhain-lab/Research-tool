// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import type { SheetsClient } from "../google";
import { createLink, listLinks, sheetRefs, sheetView, syncSheet } from "../sheets";
import { ingestContribution } from "../ingest";

const HEAD = ["Participant ID", "Name", "Number", "Transcript", "Data available", "Study", "City", "Call date", "Call status (your sheet)", "Notes (your sheet)", "Match check"];
const TR1 = "Interviewer: Usually shop kahan se karte ho?\n Participant: Mostly Myntra, aur Asha bhi mere saath dekhti hai. Pehle reviews dekhti hoon, phir order karti hoon.\n Interviewer: Okay, aur delivery ka kya?\n Participant: Mere saath Seema ne bhi dekha, delivery late hoti hai to mood off ho jata hai.";
const TR2 = "Interviewer: Kya hua tha order mein?\n Participant: Size galat aaya tha, return karna pada, refund abhi tak nahi aaya, bahut pareshani hui.";
const rows = (): string[][] => [
  HEAD,
  ["GZI-01", "Asha", "", TR1, "Transcript only", "Gen Z - In-person interviews", "Jaipur", "04-11-2026", "", "Machine-transcribed, rough text. Matched to Bimla by content.", "Audio greets Bimla"],
  ["GZP-01", "Meena", "9876543210", TR2, "Transcript + notes", "Gen Z - Phone calls (tier 2/3)", "Udaipur", "05/11/2026", "connected", "PROFILE\n Age 27 tier 2. Buys sarees online.\n TRUST\n Does not trust prepaid.", "Verified"],
  ["CIN-01", "", "", "", "Notes only", "COD research - Calling Insights (Sept)", "Kota", "24-09-2026", "Connected", "no issues, uses cod because trust, got auto cancelled once", "Notes only - no transcript."],
  ["FTU-01", "", "", "", "Notes only", "FTU - Observed usability sessions", "", "", "Observed session", "Background: never used Snapdeal. She scrolled the homepage for a minute and tapped Buy Now.", "Your typed moderator notes only"],
  ["", "", "", "", "", "", "", "", "", "stray", ""],
  ["CIN-01", "", "", "", "Notes only", "COD research - Calling Insights (Sept)", "", "", "", "a duplicate id", ""],
];
function fake(tabs: Record<string, string[][]>): SheetsClient & { tabs: Record<string, string[][]> } {
  const c = { serviceAccountEmail: "robot@proj.iam.gserviceaccount.com", tabs,
    async spreadsheet() { return { title: "Research data hub", tabs: Object.keys(c.tabs).map((t, i) => ({ title: t, gid: String(i), hidden: false })) }; },
    async values(_i: string, t: string) { return c.tabs[t]!.map((r) => [...r]); } };
  return c;
}
const SID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
let db: Db; let terms: string; let dir: string;
beforeEach(() => { db = openDb(":memory:"); dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-hub-")); terms = path.join(dir, "terms.json"); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const link = () => createLink(db, { url: SID, name: "Research data hub" });
const src = (id: string) => db.prepare("SELECT * FROM sources WHERE title LIKE ?").all(`${id} ·%`) as any[];
const IMPORT = { termsPath: "", import: true };

describe("a sheet of participants", () => {
  it("is reviewed first: nothing is imported, and the report says what is in it", async () => {
    const g = fake({ "Participant hub": rows(), Summary: [["Study", "Count"], ["x", "1"]] }); const id = link();
    const r = await syncSheet(db, g, id, { termsPath: terms });
    expect(r).toMatchObject({ ok: false, status: "preview" });
    expect((db.prepare("SELECT COUNT(*) n FROM sources").get() as { n: number }).n).toBe(0);
    const p = r.preview!;
    expect(p).toMatchObject({ rows: 4, transcripts: 2, notes: 3 });
    expect(p.perStudy.map((s) => [s.study, s.rows])).toEqual([["Gen Z - In-person interviews", 1], ["Gen Z - Phone calls (tier 2/3)", 1], ["COD research - Calling Insights (Sept)", 1], ["FTU - Observed usability sessions", 1]]);
    expect(p.warnings.join(" ")).toMatch(/no Participant ID/); expect(p.warnings.join(" ")).toMatch(/CIN-01 appears more than once/);
    expect(p.names.map((n) => n.word)).toContain("Seema"); // a name that the Name column did not list
    expect(p.names.map((n) => n.word)).not.toContain("Myntra"); // a known app is not offered
    expect(p.names.map((n) => n.word)).not.toContain("Asha"); // already in the Name column
    expect(listLinks(db)[0]).toMatchObject({ imported: false, lastStatus: "preview" });
  });

  it("reads each row by what it says it has, ignores processing comments, and removes names and numbers", async () => {
    const g = fake({ "Participant hub": rows() }); const id = link();
    await syncSheet(db, g, id, { termsPath: terms });
    const r = await syncSheet(db, g, id, { termsPath: terms, import: true });
    expect(r).toMatchObject({ ok: true, added: 4 });
    expect(src("GZI-01").map((s) => s.title)).toEqual(["GZI-01 · transcript"]); // the Notes cell of a transcript-only row is a comment, not research
    expect(src("GZP-01").map((s) => s.title).sort()).toEqual(["GZP-01 · notes", "GZP-01 · transcript"]);
    expect(new Set(src("GZP-01").map((s) => s.participant_id)).size).toBe(1); // one person, two sources
    const gz = src("GZI-01")[0];
    expect(gz).toMatchObject({ origin: "verbatim_transcript", quality: "noisy_asr", status: "approved", submitted_by: "research_team", source_type: "interview" });
    expect(src("CIN-01")[0]).toMatchObject({ origin: "researcher_notes", source_type: "cx_call" });
    expect(src("FTU-01")[0]).toMatchObject({ source_type: "usability" });
    const study = (db.prepare("SELECT name FROM studies WHERE id=?").get(src("GZP-01")[0].study_id) as { name: string }).name;
    expect(study).toBe("Gen Z - Phone calls (tier 2/3)"); // the row names its own study
    const text = (db.prepare("SELECT group_concat(text, ' ') t FROM utterances").get() as { t: string }).t;
    for (const secret of ["Asha", "Meena", "Jaipur", "9876543210", "Bimla"]) expect(text).not.toContain(secret);
    expect(text).toContain("Seema"); // not confirmed as a name yet
    const v = sheetView(db, id, { tab: "Participant hub" })!;
    expect(v.header).toContain("Match check (hidden)");
    const first = v.rows[0]!; const col = (h: string) => v.header.indexOf(h);
    expect(first.cells[col("Name")]).toBe("[removed]"); expect(first.cells[col("City")]).toBe("[removed]");
    expect(first.cells[col("Match check (hidden)")]).toBe("(not shown)");
    expect(first.cells[col("Notes (your sheet)")]).toMatch(/not used/);
    expect(JSON.stringify(v)).not.toMatch(/Bimla|Asha|Meena|9876543210/);
    expect(first.participantId).toMatch(/^P\d+$/);
    expect(db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='extract' AND status='queued'").get()).toMatchObject({ n: 5 });
  });

  it("removes confirmed names from the first import onwards, and remembers words that are not names", async () => {
    const g = fake({ "Participant hub": rows() }); const id = link();
    await syncSheet(db, g, id, { termsPath: terms });
    const { addNamesToTerms } = await import("../sheetsHub");
    addNamesToTerms(terms, ["Seema"]);
    db.prepare("UPDATE sheet_links SET ignored_json=? WHERE id=?").run(JSON.stringify(["Pehle"]), id);
    const again = await syncSheet(db, g, id, { termsPath: terms });
    expect(again.preview!.names.map((n) => n.word)).not.toContain("Seema");
    await syncSheet(db, g, id, { termsPath: terms, import: true });
    const text = (db.prepare("SELECT group_concat(text, ' ') t FROM utterances").get() as { t: string }).t;
    expect(text).not.toContain("Seema"); expect(text).toContain("[NAME]");
  });

  it("finds earlier uploads that hold the same interview, and withdraws them only when told to", async () => {
    ingestContribution(db, TR1.replace("Seema", "Sunita"), { kind: "interview", studyName: "Old upload", submittedBy: "research_team", knownNames: ["Asha"] });
    ingestContribution(db, "Totally different note about delivery and refunds that is not in the sheet at all, written long ago by another team member.", { kind: "cx_call", studyName: "Old upload", submittedBy: "research_team" });
    const g = fake({ "Participant hub": rows() }); const id = link();
    const r = await syncSheet(db, g, id, { termsPath: terms });
    expect(r.preview!.overlaps.map((o) => [o.externalId, o.kind])).toEqual([["GZI-01", "transcript"]]);
    const oldId = r.preview!.overlaps[0]!.sourceId;
    await syncSheet(db, g, id, { termsPath: terms, import: true, withdrawOverlap: true });
    expect((db.prepare("SELECT status FROM sources WHERE id=?").get(oldId) as { status: string }).status).toBe("rejected");
    expect((db.prepare("SELECT COUNT(*) n FROM sources WHERE status='rejected'").get() as { n: number }).n).toBe(1); // the unrelated note is untouched
  });

  it("keeps both when not told to withdraw", async () => {
    ingestContribution(db, TR1, { kind: "interview", studyName: "Old upload", submittedBy: "research_team", knownNames: ["Asha"] });
    const g = fake({ "Participant hub": rows() }); const id = link();
    await syncSheet(db, g, id, { termsPath: terms });
    await syncSheet(db, g, id, { termsPath: terms, import: true });
    expect((db.prepare("SELECT COUNT(*) n FROM sources WHERE status='rejected'").get() as { n: number }).n).toBe(0);
  });

  it("follows later edits by Participant ID: only the part that changed is read again; removed rows are flagged", async () => {
    const g = fake({ "Participant hub": rows() }); const id = link();
    await syncSheet(db, g, id, { termsPath: terms }); await syncSheet(db, g, id, { termsPath: terms, import: true });
    expect(await syncSheet(db, g, id, { termsPath: terms })).toMatchObject({ added: 0, edited: 0, unchanged: 4 });
    const t = g.tabs["Participant hub"]!;
    const before = src("GZP-01").map((s) => s.id);
    t[2]![9] = "PROFILE\n Age 27. TRUST\n Now trusts prepaid after a good delivery.";
    expect(await syncSheet(db, g, id, { termsPath: terms })).toMatchObject({ edited: 1, unchanged: 3 });
    const after = src("GZP-01");
    expect(after.filter((s) => s.status === "approved").length).toBe(2);
    expect(after.find((s) => s.title.endsWith("transcript"))!.id).toBe(before.find((x) => after.find((s) => s.id === x)!.title.endsWith("transcript"))); // the transcript was not touched
    expect(after.filter((s) => s.status === "rejected").map((s) => s.title)).toEqual(["GZP-01 · notes"]);
    const removed = t.splice(4, 1)[0]!; // FTU-01
    expect(await syncSheet(db, g, id, { termsPath: terms })).toMatchObject({ removed: 1 });
    expect(src("FTU-01")[0].status).toBe("approved"); // flagged, not erased
    t.splice(4, 0, removed);
    expect(await syncSheet(db, g, id, { termsPath: terms })).toMatchObject({ removed: 0, edited: 0, unchanged: 4 });
  });

  it("links evidence to the exact row, whichever part it came from", async () => {
    const g = fake({ "Participant hub": rows() }); const id = link();
    await syncSheet(db, g, id, { termsPath: terms }); await syncSheet(db, g, id, { termsPath: terms, import: true });
    const notes = src("GZP-01").find((s) => s.title.endsWith("notes"))!, tr = src("GZP-01").find((s) => s.title.endsWith("transcript"))!;
    const refs = sheetRefs(db, [notes.id, tr.id]);
    expect(refs.get(notes.id)).toMatchObject({ row: 3, tab: "Participant hub", removed: false });
    expect(refs.get(tr.id)).toMatchObject({ row: 3 });
  });
});

describe("row details over the API", () => {
  let server: Server; let base = ""; let g: ReturnType<typeof fake>; let terms2: string;
  beforeEach(() => { terms2 = path.join(dir, "t2.json"); g = fake({ "Participant hub": rows() }); server = createApp(db, { auth: { authDisabled: true }, googleSheets: g, termsPath: terms2 }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
  afterEach(() => { server.close(); });
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  it("walks through link, review, confirm a name, import, and open a row with the cited quote", async () => {
    const made = await (await post("/api/admin/sheets", { url: SID, name: "Hub" })).json();
    expect(made.sync).toMatchObject({ status: "preview" });
    const afterNames = await (await post(`/api/admin/sheets/${made.id}/names`, { names: ["Seema"], notNames: ["Pehle"] })).json();
    expect(afterNames.preview.names.map((n: any) => n.word)).not.toContain("Seema");
    expect((await (await post(`/api/admin/sheets/${made.id}/sync`, { import: true })).json())).toMatchObject({ ok: true, added: 4 });
    expect(JSON.stringify(await (await fetch(base + "/api/admin/sheets")).json())).not.toMatch(/Seema/);
    const tr = db.prepare("SELECT id, participant_id p FROM sources WHERE title='GZI-01 · transcript'").get() as { id: string; p: string };
    db.prepare("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES (?,?,?,'said','participant_verbatim','reviews','neutral','approved','x')").run(tr.id, tr.p, "Pehle reviews dekhti hoon");
    const evId = (db.prepare("SELECT id FROM evidence").get() as { id: number }).id;
    const d = await (await fetch(`${base}/api/sheets/${made.id}/row?tab=Participant%20hub&row=2&evidence=${evId}`)).json();
    expect(d).toMatchObject({ row: 2, externalId: "GZI-01", quote: "Pehle reviews dekhti hoon" });
    expect(d.cells[d.header.indexOf("Transcript")]).toContain("Pehle reviews dekhti hoon"); // the quote can be found inside the full transcript
    const other = await (await fetch(`${base}/api/sheets/${made.id}/row?tab=Participant%20hub&row=3&evidence=${evId}`)).json();
    expect(other.quote).toBeNull(); // evidence from another row is not shown on this one
    const list = await (await fetch(`${base}/api/sheets/${made.id}/view?tab=Participant%20hub`)).json();
    expect(list.rows[0].cells.every((c: string) => c.length <= 281)).toBe(true); // long cells are shortened in the grid
    expect((await fetch(`${base}/api/sheets/${made.id}/row?tab=Participant%20hub&row=999`)).status).toBe(404);
    expect((await fetch(`${base}/api/sheets/${made.id}/row?row=2`)).status).toBe(400);
  });
});

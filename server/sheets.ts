// Keeps a Google Sheet of CX call notes in step with the tool, and lets people open the exact row an insight came from.
// Only a redacted copy of each row is stored: names, numbers and cities are removed before anything is saved or shown.
import crypto from "node:crypto";
import { audit, type Db } from "./db";
import { CALL_COLUMNS, ensureStudy, ingestCallRow, loadTerms, saveTerms } from "./ingest";
import { makeRedactor } from "./redact";
import { enqueueExtractions } from "./jobs";
import { GoogleError, parseSheetUrl, type SheetsClient } from "./google";
import { applyHub, buildPreview, findOverlaps, hubHeaderIndex, hubTerms, normaliseDate, parseHubTab, planHub, withdrawSources, type HubTab, type Preview } from "./sheetsHub";

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const nowIso = () => new Date().toISOString();
const PII = new Set(["Name", "City", "Mobile Number"]); // shown as [removed] in the in-tool view
const SHOWN_AS_REMOVED = "[removed]";
const CELL_PREVIEW = 280; // longer cells (a whole transcript) are shortened in the grid and shown in full in the row details

export type SheetLink = { id: string; source: "google" | "upload"; name: string; spreadsheetId: string; studyName: string; product: string; enabled: boolean; lastSyncedAt: string | null; lastStatus: string | null; lastMessage: string | null; imported: boolean; preview: Preview | null; rows: number; removedRows: number; tabs: { title: string; gid: string | null }[] };
export type SyncResult = { ok: boolean; status: "ok" | "error" | "needs_confirmation" | "preview"; message: string; added: number; edited: number; removed: number; linked: number; unchanged: number; preview?: Preview };
const result = (status: SyncResult["status"], message: string, n: Partial<SyncResult> = {}): SyncResult => ({ ok: status === "ok", status, message, added: 0, edited: 0, removed: 0, linked: 0, unchanged: 0, ...n });

type NewRow = { row: number; display: string[]; call: Record<string, string>; hash: string; hasNotes: boolean };
type ParsedTab = { title: string; gid: string; header: string[]; headerRow: number; rows: NewRow[] };
type OldRow = { id: number; row_number: number; content_hash: string; source_id: string | null; state: "live" | "removed" };

export function createLink(db: Db, o: { url: string; name: string; study?: string; product?: string; by?: string; title?: string }): string {
  const spreadsheetId = parseSheetUrl(o.url);
  if (!spreadsheetId) throw new GoogleError("That doesn't look like a Google Sheets link. Paste the link from the sheet's address bar.");
  if (db.prepare("SELECT 1 FROM sheet_links WHERE spreadsheet_id=?").get(spreadsheetId)) throw new GoogleError("That sheet is already linked.");
  const name = (o.name || o.title || "CX call notes").trim().slice(0, 80);
  const id = "SH-" + crypto.randomBytes(4).toString("hex");
  db.prepare("INSERT INTO sheet_links(id,name,spreadsheet_id,study_name,product,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, name, spreadsheetId, (o.study || name).trim().slice(0, 80), (o.product || "Snapdeal").trim().slice(0, 80), o.by ?? null, nowIso());
  audit(db, "sheet.link", { id, by: o.by });
  return id;
}

/** One logical link for sheets that arrive as uploaded files; uploading an updated file updates it (rows are recognised by Participant ID). */
export function fileLinkId(db: Db, name: string, by?: string): string {
  const have = db.prepare("SELECT id FROM sheet_links WHERE spreadsheet_id='upload:hub'").get() as { id: string } | undefined;
  if (have) return have.id;
  const id = "SH-" + crypto.randomBytes(4).toString("hex");
  const n = (name || "Uploaded research sheet").trim().slice(0, 80);
  db.prepare("INSERT INTO sheet_links(id,name,spreadsheet_id,study_name,product,created_by,created_at) VALUES (?,?,?,?,?,?,?)").run(id, n, "upload:hub", n, "Snapdeal", by ?? null, nowIso());
  audit(db, "sheet.file_link", { id, by });
  return id;
}

function parseTab(title: string, gid: string, values: string[][], redact: ReturnType<typeof makeRedactor>): ParsedTab | null {
  // The header is the first row, within the top five, that has a Notes column.
  let h = -1;
  for (let i = 0; i < Math.min(5, values.length); i++) if ((values[i] ?? []).some((c) => (CALL_COLUMNS[c.trim().toLowerCase()] ?? "") === "Notes")) { h = i; break; }
  if (h < 0) return null;
  const header = values[h]!.map((c) => c.trim());
  const canon = header.map((c) => CALL_COLUMNS[c.toLowerCase()] ?? "");
  const rows: NewRow[] = [];
  for (let i = h + 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    if (!raw.some((c) => c.trim())) continue;
    const call: Record<string, string> = {};
    const display = header.map((_, c) => {
      const v = (raw[c] ?? "").trim();
      const k = canon[c]!;
      if (k) call[k] = v;
      if (!v) return "";
      return PII.has(k) ? SHOWN_AS_REMOVED : redact(v).text;
    });
    if (call["Date"]) call["Date"] = normaliseDate(call["Date"]);
    const notes = redact(call["Notes"] ?? "").text;
    const product = redact(call["Product Name"] ?? "").text;
    rows.push({ row: i + 1, display, call, hash: sha(`${notes}|${product}|${call["Date"] ?? ""}`), hasNotes: !!(call["Notes"] ?? "").trim() });
  }
  return { title, gid, header, headerRow: h + 1, rows };
}

type TabPlan = { tab: ParsedTab; keep: { old: OldRow; row: NewRow }[]; edits: { old: OldRow; row: NewRow }[]; adds: NewRow[]; removes: OldRow[] };

function planTab(db: Db, linkId: string, tab: ParsedTab): TabPlan {
  const old = db.prepare("SELECT id,row_number,content_hash,source_id,state FROM sheet_rows WHERE link_id=? AND tab=? AND external_id IS NULL ORDER BY CASE state WHEN 'live' THEN 0 ELSE 1 END, row_number").all(linkId, tab.title) as unknown as OldRow[];
  const byHash = new Map<string, OldRow[]>();
  for (const o of old) { const l = byHash.get(o.content_hash) ?? []; l.push(o); byHash.set(o.content_hash, l); }
  const keep: TabPlan["keep"] = []; const unmatchedNew: NewRow[] = []; const taken = new Set<number>();
  for (const row of tab.rows) { // unchanged or moved (rows sorted, inserted above, or a removed row that came back)
    const o = byHash.get(row.hash)?.shift();
    if (o) { keep.push({ old: o, row }); taken.add(o.id); } else unmatchedNew.push(row);
  }
  const leftover = old.filter((o) => !taken.has(o.id) && o.state === "live");
  const edits: TabPlan["edits"] = []; const adds: NewRow[] = []; const usedOld = new Set<number>();
  for (const row of unmatchedNew) { // same place, different content: an edit
    const o = leftover.find((x) => x.row_number === row.row && !usedOld.has(x.id));
    if (o) { edits.push({ old: o, row }); usedOld.add(o.id); } else adds.push(row);
  }
  return { tab, keep, edits, adds, removes: leftover.filter((o) => !usedOld.has(o.id)) };
}

/** Read the sheet and bring the tool in line: new rows are added, edited rows re-read, removed rows flagged. */
export async function syncSheet(db: Db, client: SheetsClient, linkId: string, o: { termsPath?: string; force?: boolean; import?: boolean; withdrawOverlap?: boolean } = {}): Promise<SyncResult> {
  const link = db.prepare("SELECT * FROM sheet_links WHERE id=?").get(linkId) as { id: string; spreadsheet_id: string; study_name: string; product: string; imported: number; ignored_json: string } | undefined;
  if (!link) throw new Error("Unknown sheet link");
  const finish = (r: SyncResult) => { db.prepare("UPDATE sheet_links SET last_synced_at=?, last_status=?, last_message=? WHERE id=?").run(nowIso(), r.status, r.message, linkId); return r; };
  try {
    const book = await client.spreadsheet(link.spreadsheet_id);
    const tabs = book.tabs.filter((t) => !t.hidden);
    const read: { title: string; gid: string; values: string[][] }[] = [];
    for (const t of tabs) read.push({ title: t.title, gid: t.gid, values: await client.values(link.spreadsheet_id, t.title) });

    // Names and cities written in the sheet are added to the local removal list first, so they are also caught inside the text.
    const known = loadTerms(o.termsPath);
    const names = [...known.names], places = [...known.places];
    for (const t of read) {
      const hh = hubHeaderIndex(t.values);
      if (hh >= 0) { const x = hubTerms(t.values, hh); names.push(...x.names); places.push(...x.places); continue; }
      const h = (t.values.slice(0, 5).find((r) => r.some((c) => (CALL_COLUMNS[c.trim().toLowerCase()] ?? "") === "Notes")) ?? []).map((c) => CALL_COLUMNS[c.trim().toLowerCase()] ?? "");
      const ni = h.indexOf("Name"), ci = h.indexOf("City");
      for (const r of t.values) { if (ni >= 0 && r[ni]?.trim()) names.push(r[ni]!.trim()); if (ci >= 0 && r[ci]?.trim()) places.push(r[ci]!.trim()); }
    }
    const terms = { names, places }; saveTerms(o.termsPath, terms);
    const redact = makeRedactor(terms);

    const hubTabs: HubTab[] = []; const callTabs: ParsedTab[] = [];
    for (const t of read) {
      if (hubHeaderIndex(t.values) >= 0) hubTabs.push(parseHubTab(t.title, t.gid, t.values, redact));
      else { const pt = parseTab(t.title, t.gid, t.values, redact); if (pt) callTabs.push(pt); }
    }
    const usable = callTabs;
    if (!usable.length && !hubTabs.length) return finish(result("error", "No tab has a Notes column or a Participant ID column, so nothing was read. Add a header row with a Participant ID column and a Transcript or Notes column (or, for call notes, a Notes column)."));

    // A sheet of participants is reviewed before the first import: what it holds, what overlaps earlier uploads, which names may be left.
    if (hubTabs.length && !link.imported && !o.import) {
      const preview = buildPreview(db, hubTabs, o.termsPath, JSON.parse(link.ignored_json || "[]") as string[]);
      db.prepare("UPDATE sheet_links SET preview_json=? WHERE id=?").run(JSON.stringify(preview), linkId);
      return finish(result("preview", `Read ${preview.rows} participants. Nothing is imported yet: review the report, then press Import.`, { preview }));
    }
    const plans = usable.map((t) => planTab(db, linkId, t));
    const hubPlans = hubTabs.map((t) => planHub(db, linkId, t));

    // Safety: a sorting mistake or a reformatted column can look like many edits at once. Ask before rebuilding a lot.
    const total = plans.reduce((n, p) => n + p.keep.length + p.edits.length + p.removes.length, 0) + hubPlans.reduce((n, p) => n + p.keep.length + p.edits.length + p.removes.length, 0);
    const changed = plans.reduce((n, p) => n + p.edits.length + p.removes.length, 0) + hubPlans.reduce((n, p) => n + p.edits.length + p.removes.length, 0);
    if (!o.force && total >= 10 && changed / total > 0.3)
      return finish(result("needs_confirmation", `${changed} of ${total} existing rows look edited or removed. Nothing was changed. If that is right, press "Apply anyway"; otherwise check the sheet.`, { edited: plans.reduce((n, p) => n + p.edits.length, 0) + hubPlans.reduce((n, p) => n + p.edits.length, 0), removed: plans.reduce((n, p) => n + p.removes.length, 0) + hubPlans.reduce((n, p) => n + p.removes.length, 0) }));

    const studyId = ensureStudy(db, link.study_name, link.product);
    const r = result("ok", "");
    const rejectSource = (sid: string | null, rowId: number) => {
      if (!sid) return;
      const other = db.prepare("SELECT 1 FROM sheet_rows WHERE (source_id=? OR source2_id=?) AND state='live' AND id!=?").get(sid, sid, rowId); // still used by another row with identical text
      if (other) return;
      db.prepare("UPDATE sources SET status='rejected' WHERE id=?").run(sid);
      db.prepare("UPDATE evidence SET status='rejected', review_note='Replaced: the sheet row was edited' WHERE source_id=? AND status!='rejected'").run(sid);
    };
    const ingest = (row: NewRow): string | null => {
      if (!row.hasNotes) return null;
      const x = ingestCallRow(db, studyId, redact, row.call, "research_team");
      if (!x) return null;
      if (x.existing) r.linked++; else r.added++;
      return x.sourceId;
    };

    const overlapIds = o.withdrawOverlap && hubTabs.length ? findOverlaps(db, hubTabs).map((x) => x.sourceId) : []; // measured before anything new is stored
    db.exec("BEGIN");
    try {
      for (const hp of hubPlans) applyHub({ db, redact, linkId, product: link.product, defaultStudy: link.study_name, counts: r, rejectSource }, hp);
      if (overlapIds.length) withdrawSources(db, overlapIds, "Replaced: the same interview or notes came in from the Google Sheet");
      for (const p of plans) {
        db.prepare("INSERT INTO sheet_tabs(link_id,tab,gid,header_json,header_row) VALUES (?,?,?,?,?) ON CONFLICT(link_id,tab) DO UPDATE SET gid=excluded.gid, header_json=excluded.header_json, header_row=excluded.header_row")
          .run(linkId, p.tab.title, p.tab.gid, JSON.stringify(p.tab.header), p.tab.headerRow);
        for (const k of p.keep) {
          db.prepare("UPDATE sheet_rows SET row_number=?, cells_json=?, state='live', removed_at=NULL, updated_at=? WHERE id=?").run(k.row.row, JSON.stringify(k.row.display), nowIso(), k.old.id);
          r.unchanged++;
        }
        for (const e of p.edits) {
          rejectSource(e.old.source_id, e.old.id);
          db.prepare("UPDATE sheet_rows SET row_number=?, content_hash=?, source_id=?, cells_json=?, updated_at=? WHERE id=?").run(e.row.row, e.row.hash, ingest(e.row), JSON.stringify(e.row.display), nowIso(), e.old.id);
          r.edited++;
        }
        for (const row of p.adds)
          db.prepare("INSERT INTO sheet_rows(link_id,tab,row_number,content_hash,source_id,cells_json,updated_at) VALUES (?,?,?,?,?,?,?)").run(linkId, p.tab.title, row.row, row.hash, ingest(row), JSON.stringify(row.display), nowIso());
        for (const rem of p.removes) {
          db.prepare("UPDATE sheet_rows SET state='removed', removed_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), rem.id); // flagged, never silently erased
          r.removed++;
        }
      }
      db.prepare("UPDATE sheet_links SET imported=1, preview_json=NULL WHERE id=?").run(linkId);
      audit(db, "sheet.sync", { id: linkId, added: r.added, edited: r.edited, removed: r.removed, linked: r.linked, withdrawn: new Set(overlapIds).size });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    enqueueExtractions(db);
    const bits = [r.added && `${r.added} new`, r.edited && `${r.edited} edited`, r.removed && `${r.removed} removed from the sheet`, r.linked && `${r.linked} matched to data already in the tool`, overlapIds.length && `${new Set(overlapIds).size} earlier uploads withdrawn as duplicates`].filter(Boolean);
    r.message = bits.length ? `Synced: ${bits.join(", ")}.` : "Synced: no changes.";
    return finish(r);
  } catch (e) {
    if (e instanceof GoogleError) return finish(result("error", e.message));
    console.error("sheet sync failed:", (e as Error).message);
    return finish(result("error", "The sync failed unexpectedly. Check the server log."));
  }
}

export function listLinks(db: Db): SheetLink[] {
  const rows = db.prepare("SELECT * FROM sheet_links ORDER BY created_at").all() as any[];
  return rows.map((r) => ({
    id: r.id, source: String(r.spreadsheet_id).startsWith("upload:") ? "upload" : "google", name: r.name, spreadsheetId: r.spreadsheet_id, studyName: r.study_name, product: r.product, enabled: !!r.enabled,
    lastSyncedAt: r.last_synced_at, lastStatus: r.last_status, lastMessage: r.last_message, imported: !!r.imported, preview: r.preview_json ? (JSON.parse(r.preview_json) as Preview) : null,
    rows: Number((db.prepare("SELECT COUNT(*) n FROM sheet_rows WHERE link_id=? AND state='live'").get(r.id) as { n: number }).n),
    removedRows: Number((db.prepare("SELECT COUNT(*) n FROM sheet_rows WHERE link_id=? AND state='removed'").get(r.id) as { n: number }).n),
    tabs: (db.prepare("SELECT tab,gid FROM sheet_tabs WHERE link_id=? ORDER BY rowid").all(r.id) as { tab: string; gid: string | null }[]).map((t) => ({ title: t.tab, gid: t.gid })),
  }));
}

export type SheetView = {
  id: string; name: string; spreadsheetId: string; tab: string; gid: string | null; tabs: { title: string; gid: string | null }[]; header: string[];
  from: number; rows: { row: number; cells: string[]; removed: boolean; participantId: string | null }[]; hasPrev: boolean; hasNext: boolean; lastSyncedAt: string | null;
};

/** A window of the redacted copy, with the participant for each row. */
export function sheetView(db: Db, linkId: string, o: { tab?: string; from?: number; limit?: number }): SheetView | null {
  const link = db.prepare("SELECT id,name,spreadsheet_id,last_synced_at FROM sheet_links WHERE id=?").get(linkId) as { id: string; name: string; spreadsheet_id: string; last_synced_at: string | null } | undefined;
  if (!link) return null;
  const tabs = db.prepare("SELECT tab,gid,header_json FROM sheet_tabs WHERE link_id=? ORDER BY rowid").all(linkId) as { tab: string; gid: string | null; header_json: string }[];
  const t = tabs.find((x) => x.tab === o.tab) ?? tabs[0];
  if (!t) return null;
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 40)));
  const from = Math.max(1, Math.floor(o.from ?? 1));
  const rows = db.prepare(
    `SELECT r.row_number n, r.cells_json c, r.state s, COALESCE(r.participant_id, so.participant_id) p FROM sheet_rows r LEFT JOIN sources so ON so.id=r.source_id
     WHERE r.link_id=? AND r.tab=? AND r.row_number>=? AND (r.state='live' OR NOT EXISTS (SELECT 1 FROM sheet_rows x WHERE x.link_id=r.link_id AND x.tab=r.tab AND x.row_number=r.row_number AND x.state='live'))
     ORDER BY r.row_number LIMIT ?`).all(linkId, t.tab, from, limit + 1) as { n: number; c: string; s: string; p: string | null }[];
  const hasPrev = !!db.prepare("SELECT 1 FROM sheet_rows WHERE link_id=? AND tab=? AND row_number<?").get(linkId, t.tab, from);
  return {
    id: link.id, name: link.name, spreadsheetId: link.spreadsheet_id, tab: t.tab, gid: t.gid, tabs: tabs.map((x) => ({ title: x.tab, gid: x.gid })), header: JSON.parse(t.header_json),
    from, rows: rows.slice(0, limit).map((r) => ({ row: r.n, cells: (JSON.parse(r.c) as string[]).map((x) => (x.length > CELL_PREVIEW ? x.slice(0, CELL_PREVIEW) + "…" : x)), removed: r.s === "removed", participantId: r.p })), hasPrev, hasNext: rows.length > limit, lastSyncedAt: link.last_synced_at,
  };
}

export type SheetRowDetail = { header: string[]; cells: string[]; row: number; tab: string; removed: boolean; participantId: string | null; externalId: string | null; quote: string | null };

/** One row in full, with the quote an insight was built on when it belongs to this row. */
export function sheetRow(db: Db, linkId: string, o: { tab: string; row: number; evidenceId?: number }): SheetRowDetail | null {
  const t = db.prepare("SELECT header_json FROM sheet_tabs WHERE link_id=? AND tab=?").get(linkId, o.tab) as { header_json: string } | undefined;
  const r = db.prepare(`SELECT r.cells_json c, r.state s, r.external_id e, r.source_id s1, r.source2_id s2, COALESCE(r.participant_id, so.participant_id) p FROM sheet_rows r LEFT JOIN sources so ON so.id=r.source_id
    WHERE r.link_id=? AND r.tab=? AND r.row_number=? ORDER BY CASE r.state WHEN 'live' THEN 0 ELSE 1 END LIMIT 1`).get(linkId, o.tab, o.row) as { c: string; s: string; e: string | null; s1: string | null; s2: string | null; p: string | null } | undefined;
  if (!t || !r) return null;
  let quote: string | null = null;
  if (o.evidenceId) {
    const ev = db.prepare("SELECT original_text q, source_id sid FROM evidence WHERE id=?").get(o.evidenceId) as { q: string; sid: string } | undefined;
    if (ev && (ev.sid === r.s1 || ev.sid === r.s2)) quote = ev.q;
  }
  return { header: JSON.parse(t.header_json), cells: JSON.parse(r.c), row: o.row, tab: o.tab, removed: r.s === "removed", participantId: r.p, externalId: r.e, quote };
}

/** Where each source sits in a linked sheet, for "view source" links. */
export function sheetRefs(db: Db, sourceIds: string[]): Map<string, { linkId: string; name: string; tab: string; row: number; removed: boolean }> {
  const out = new Map<string, { linkId: string; name: string; tab: string; row: number; removed: boolean }>();
  if (!sourceIds.length) return out;
  type R = { sid: string; lid: string; name: string; tab: string; n: number; s: string };
  const ph = sourceIds.map(() => "?").join(",");
  const q = (col: "source_id" | "source2_id") => db.prepare(`SELECT r.${col} sid, r.link_id lid, l.name, r.tab, r.row_number n, r.state s FROM sheet_rows r JOIN sheet_links l ON l.id=r.link_id WHERE r.${col} IN (${ph})`).all(...sourceIds) as R[];
  const rows = [...q("source_id"), ...q("source2_id")].sort((a, b) => (a.s === "live" ? 0 : 1) - (b.s === "live" ? 0 : 1));
  for (const r of rows) if (!out.has(r.sid)) out.set(r.sid, { linkId: r.lid, name: r.name, tab: r.tab, row: r.n, removed: r.s === "removed" });
  return out;
}

/** Check each enabled sheet every few minutes. Sheets waiting for confirmation are left alone until someone presses "Apply anyway". */
export function startSheetSync(db: Db, client: SheetsClient, o: { minutes: number; termsPath?: string }): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const due = db.prepare("SELECT id FROM sheet_links WHERE enabled=1 AND imported=1 AND spreadsheet_id NOT LIKE 'upload:%' AND COALESCE(last_status,'')!='needs_confirmation' AND (last_synced_at IS NULL OR last_synced_at < ?)").all(new Date(Date.now() - o.minutes * 60_000).toISOString()) as { id: string }[];
      for (const l of due) await syncSheet(db, client, l.id, { ...(o.termsPath ? { termsPath: o.termsPath } : {}) });
    } finally { busy = false; }
  };
  const t = setInterval(tick, 60_000);
  void tick();
  return () => clearInterval(t);
}

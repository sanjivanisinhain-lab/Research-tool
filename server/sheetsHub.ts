// Sheets with one row per participant: Participant ID, Study, Data available, Transcript and/or Notes.
// A row is known by its Participant ID. Each row can carry a transcript, typed notes, or both, and names its own study.
import crypto from "node:crypto";
import type { Db } from "./db";
import { ingestHubSource, loadTerms, saveTerms, type TermsStore } from "./ingest";
import { NOT_NAMES } from "./redact";
import type { makeRedactor } from "./redact";

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
export const REMOVED = "[removed]";
type Redact = ReturnType<typeof makeRedactor>;

const KEYS: Record<string, string> = {
  "participant id": "id", "data available": "data", study: "study", name: "name", number: "number", "mobile number": "number", transcript: "transcript",
  city: "city", "call date": "date", date: "date", "call status": "status", notes: "notes", "match check": "qa",
};
/** Column names in a sheet vary a little ("Notes (your sheet)"): read them by their first words. */
const keyOf = (h: string) => KEYS[h.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim()] ?? "";

export function normaliseDate(s: string): string {
  const t = s.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${Number(m[1])}-${Number(m[2])}-${m[3]}`;
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  return m ? `${Number(m[3])}-${Number(m[2])}-${m[1]}` : t;
}

export type HubRow = {
  row: number; id: string; study: string; date: string; type: "interview" | "cx_call" | "usability"; noisy: boolean;
  transcript: string; notes: string; // the text that will be read (already redacted), empty if that part is not used
  tHash: string; nHash: string; display: string[];
};
export type HubTab = { title: string; gid: string; header: string[]; headerRow: number; rows: HubRow[]; warnings: string[]; noData: number };
export type HubOld = { id: number; external_id: string; row_number: number; content_hash: string; hash2: string | null; source_id: string | null; source2_id: string | null; participant_id: string | null; state: "live" | "removed" };

const typeOf = (study: string): HubRow["type"] => (/\b(ftu|observed|usability)\b/i.test(study) ? "usability" : /call|cod|insight/i.test(study) ? "cx_call" : "interview");

/** The header is the first of the top five rows that has a Participant ID column plus a Transcript or Notes column. */
export function hubHeaderIndex(values: string[][]): number {
  for (let i = 0; i < Math.min(5, values.length); i++) {
    const keys = (values[i] ?? []).map(keyOf);
    if (keys.includes("id") && (keys.includes("transcript") || keys.includes("notes"))) return i;
  }
  return -1;
}

/** Names and cities written in the sheet, so they can be removed from the text too. */
export function hubTerms(values: string[][], h: number): { names: string[]; places: string[] } {
  const keys = (values[h] ?? []).map(keyOf);
  const ni = keys.indexOf("name"), ci = keys.indexOf("city");
  const names: string[] = [], places: string[] = [];
  for (const r of values.slice(h + 1)) {
    const n = ni >= 0 ? (r[ni] ?? "").trim() : "";
    if (n) { names.push(n); for (const w of n.split(/\s+/)) if (w.length >= 3 && !NOT_NAMES.has(w.toLowerCase())) names.push(w); }
    const c = ci >= 0 ? (r[ci] ?? "").trim() : "";
    if (c) places.push(c);
  }
  return { names, places };
}

export function parseHubTab(title: string, gid: string, values: string[][], redact: Redact): HubTab {
  const h = hubHeaderIndex(values);
  const header = values[h]!.map((c) => c.trim());
  const keys = header.map(keyOf);
  const col = (k: string) => keys.indexOf(k);
  const warnings: string[] = []; const seen = new Set<string>(); const rows: HubRow[] = []; let noData = 0;
  for (let i = h + 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    if (!raw.some((c) => c.trim())) continue;
    const get = (k: string) => (col(k) >= 0 ? (raw[col(k)] ?? "").trim() : "");
    const id = get("id");
    if (!id) { warnings.push(`Row ${i + 1} has no Participant ID, so it was skipped.`); continue; }
    if (seen.has(id)) { warnings.push(`Participant ID ${id} appears more than once; only the first row (row ${rows.find((r) => r.id === id)!.row}) is used.`); continue; }
    seen.add(id);
    const data = get("data").toLowerCase();
    const wantT = data ? data.includes("transcript") : !!get("transcript");
    const wantN = data ? data.includes("notes") : !get("transcript") && !!get("notes"); // transcript-only rows keep processing comments in Notes: those are not research
    const tRaw = wantT ? get("transcript") : "", nRaw = wantN ? get("notes") : "";
    const study = get("study");
    const noisy = /machine[- ]transcrib|garbled|rough text/i.test(`${get("notes")} ${get("qa")}`);
    const t = tRaw ? redact(tRaw).text : "", n = nRaw ? redact(nRaw).text : "";
    if (!t && !n) { noData++; continue; } // listed, but nothing to read yet (for example a "still to find" list). It is picked up when a transcript or notes appear.
    const display = header.map((_, c) => {
      const k = keys[c]!, v = (raw[c] ?? "").trim();
      if (!v) return "";
      if (k === "name" || k === "number" || k === "city") return REMOVED;
      if (k === "qa") return "(not shown)";
      if (k === "notes") return wantN ? n : "(not used: processing comment)";
      if (k === "transcript") return wantT ? t : "";
      return redact(v).text;
    });
    rows.push({ row: i + 1, id, study, date: normaliseDate(get("date")), type: typeOf(study), noisy, transcript: t, notes: n, tHash: t ? sha(t) : "", nHash: n ? sha(n) : "", display });
  }
  return { title, gid, noData, header: header.map((x, c) => (keys[c] === "qa" ? `${x} (hidden)` : x)), headerRow: h + 1, rows, warnings };
}

export type HubPlan = { tab: HubTab; keep: { old: HubOld; row: HubRow }[]; edits: { old: HubOld; row: HubRow }[]; adds: HubRow[]; removes: HubOld[] };

export function planHub(db: Db, linkId: string, tab: HubTab): HubPlan {
  const old = db.prepare("SELECT id,external_id,row_number,content_hash,hash2,source_id,source2_id,participant_id,state FROM sheet_rows WHERE link_id=? AND tab=? AND external_id IS NOT NULL").all(linkId, tab.title) as unknown as HubOld[];
  const byId = new Map(old.map((o) => [o.external_id, o]));
  const plan: HubPlan = { tab, keep: [], edits: [], adds: [], removes: [] };
  const present = new Set<string>();
  for (const row of tab.rows) {
    present.add(row.id);
    const o = byId.get(row.id);
    if (!o) plan.adds.push(row);
    else if (o.content_hash === row.tHash && (o.hash2 ?? "") === row.nHash) plan.keep.push({ old: o, row });
    else plan.edits.push({ old: o, row });
  }
  plan.removes = old.filter((o) => o.state === "live" && !present.has(o.external_id));
  return plan;
}

// ---------- overlap with earlier uploads ----------
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const probes = (text: string): string[] => {
  const w = norm(text).split(" ").filter(Boolean);
  if (w.length < 12) return w.length ? [w.join(" ")] : [];
  const span = w.length - 12;
  return [0.15, 0.5, 0.85].map((f) => w.slice(Math.floor(span * f), Math.floor(span * f) + 12).join(" "));
};
export type Overlap = { externalId: string; kind: "transcript" | "notes"; sourceId: string; title: string; participantId: string | null; matched: string };

/** Earlier sources (not tied to a sheet row) whose wording appears in a sheet row: several short stretches must match, so a reformatted copy is still found. */
export function findOverlaps(db: Db, tabs: HubTab[]): Overlap[] {
  const rows = db.prepare(`SELECT u.source_id sid, u.text t, s.title, s.participant_id p FROM utterances u JOIN sources s ON s.id=u.source_id
    WHERE s.status!='rejected' AND s.id NOT IN (SELECT source_id FROM sheet_rows WHERE source_id IS NOT NULL UNION SELECT source2_id FROM sheet_rows WHERE source2_id IS NOT NULL) ORDER BY u.source_id, u.seq`).all() as { sid: string; t: string; title: string; p: string | null }[];
  const old = new Map<string, { title: string; p: string | null; text: string[] }>();
  for (const r of rows) { const e = old.get(r.sid) ?? { title: r.title, p: r.p, text: [] }; e.text.push(r.t); old.set(r.sid, e); }
  const index = [...old.entries()].map(([sid, e]) => ({ sid, title: e.title, p: e.p, text: norm(e.text.join(" ")) }));
  // A stretch of text that appears in several sheet rows is a scripted question or a shared boilerplate, not evidence that a row is a copy of an earlier upload.
  const parts = tabs.flatMap((t) => t.rows.flatMap((row) => ([["transcript", row.transcript], ["notes", row.notes]] as const).map(([kind, text]) => ({ id: row.id, kind, ps: probes(text) }))));
  const seen = new Map<string, number>();
  for (const x of parts) for (const p of new Set(x.ps)) seen.set(p, (seen.get(p) ?? 0) + 1);
  const out: Overlap[] = [];
  for (const x of parts) {
    const ps = x.ps.filter((p) => seen.get(p) === 1);
    if (!ps.length) continue;
    const need = Math.min(2, ps.length);
    for (const o of index) { const hit = ps.filter((p) => o.text.includes(p)).length; if (hit >= need) out.push({ externalId: x.id, kind: x.kind, sourceId: o.sid, title: o.title, participantId: o.p, matched: `${hit} of ${ps.length}` }); }
  }
  return out;
}

/** Take earlier sources out of answers: they stay in the database, marked as replaced. */
export function withdrawSources(db: Db, sourceIds: string[], note: string) {
  for (const sid of new Set(sourceIds)) {
    db.prepare("UPDATE sources SET status='rejected' WHERE id=?").run(sid);
    db.prepare("UPDATE evidence SET status='rejected', review_note=? WHERE source_id=? AND status!='rejected'").run(note, sid);
  }
}

// ---------- names that the Name column did not catch ----------
const STOP = new Set(["Snapdeal", "Myntra", "Meesho", "Amazon", "Flipkart", "Savana", "Littlebox", "Ajio", "Instagram", "Pinterest", "Google", "Phonepe", "Paytm", "Whatsapp", "Westside", "Nykaa", "Lenskart", "Youtube", "Facebook", "Android", "Interviewer", "Participant", "Speaker", "Other", "Hotspot", "Instahelp", "Citymall", "Reels", "Gemini", "Okay", "Yes", "Hmm", "Hello", "Notes", "Profile", "Trust", "Price", "Order", "Orders", "Segment", "Pain", "Follow", "Escalate", "Partial", "Habits", "Shopping", "Online", "Offline", "Platform", "Hindi", "English", "Tier", "India", "Gen"]);
const STOP_LC = new Set([...STOP].map((x) => x.toLowerCase()));

/** Capitalised words that sit in the middle of a sentence and are not known brands or already removed: the likeliest remaining names. Latin script only. */
export function possibleNames(texts: string[], known: TermsStore, ignored: string[]): { word: string; count: number }[] {
  const lower = new Set<string>(); const counts = new Map<string, number>();
  for (const t of texts) {
    for (const m of t.matchAll(/\p{Ll}{3,}/gu)) lower.add(m[0]);
    for (const m of t.matchAll(/(?<=[\p{Ll}\p{N},;)] )\p{Lu}\p{Ll}{2,}(?![\p{L}\p{N}])/gu)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  const skip = new Set([...known.names, ...known.places, ...ignored].map((x) => x.toLowerCase()));
  return [...counts.entries()].filter(([w]) => !lower.has(w.toLowerCase()) && !STOP_LC.has(w.toLowerCase()) && !skip.has(w.toLowerCase()))
    .map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 80);
}

export function addNamesToTerms(termsPath: string | undefined, names: string[]) {
  const t = loadTerms(termsPath);
  saveTerms(termsPath, { names: [...t.names, ...names.map((n) => n.trim()).filter(Boolean)], places: t.places });
}

export type Preview = {
  at: string; rows: number; noData: number; transcripts: number; notes: number;
  perStudy: { study: string; rows: number; transcripts: number; notes: number }[];
  warnings: string[]; overlaps: Overlap[]; names: { word: string; count: number }[];
};

export function buildPreview(db: Db, tabs: HubTab[], termsPath: string | undefined, ignored: string[]): Preview {
  const per = new Map<string, { rows: number; transcripts: number; notes: number }>();
  let transcripts = 0, notes = 0, rows = 0;
  for (const tab of tabs) for (const r of tab.rows) {
    rows++; if (r.transcript) transcripts++; if (r.notes) notes++;
    const e = per.get(r.study || "(no study)") ?? { rows: 0, transcripts: 0, notes: 0 };
    e.rows++; if (r.transcript) e.transcripts++; if (r.notes) e.notes++; per.set(r.study || "(no study)", e);
  }
  const texts = tabs.flatMap((t) => t.rows.flatMap((r) => [r.transcript, r.notes])).filter(Boolean);
  return {
    at: new Date().toISOString(), rows, noData: tabs.reduce((n, t) => n + t.noData, 0), transcripts, notes, perStudy: [...per.entries()].map(([study, v]) => ({ study, ...v })),
    warnings: tabs.flatMap((t) => t.warnings), overlaps: findOverlaps(db, tabs), names: possibleNames(texts, loadTerms(termsPath), ignored),
  };
}

export type IngestCtx = {
  db: Db; redact: Redact; linkId: string; product: string; defaultStudy: string;
  counts: { added: number; edited: number; removed: number; linked: number; unchanged: number };
  rejectSource: (sid: string | null, rowId: number) => void;
};

/** Write a plan: add new participants, re-read edited parts, flag removed rows. Runs inside the caller's transaction. */
export function applyHub(c: IngestCtx, plan: HubPlan) {
  const { db } = c; const now = () => new Date().toISOString();
  if (!plan.keep.length && !plan.edits.length && !plan.adds.length && !plan.removes.length) return; // a tab with nothing to read (a list of people still to find) leaves no trace
  const part = (row: HubRow, kind: "transcript" | "notes", participantId: string | null) => {
    const text = kind === "transcript" ? row.transcript : row.notes;
    if (!text) return null;
    return ingestHubSource(db, c.redact, { studyName: row.study || c.defaultStudy, product: c.product, externalId: row.id, participantId, text, kind, type: row.type, date: row.date || null, noisy: row.noisy });
  };
  db.prepare("INSERT INTO sheet_tabs(link_id,tab,gid,header_json,header_row) VALUES (?,?,?,?,?) ON CONFLICT(link_id,tab) DO UPDATE SET gid=excluded.gid, header_json=excluded.header_json, header_row=excluded.header_row")
    .run(c.linkId, plan.tab.title, plan.tab.gid, JSON.stringify(plan.tab.header), plan.tab.headerRow);
  for (const k of plan.keep) {
    db.prepare("UPDATE sheet_rows SET row_number=?, cells_json=?, state='live', removed_at=NULL, updated_at=? WHERE id=?").run(k.row.row, JSON.stringify(k.row.display), now(), k.old.id);
    c.counts.unchanged++;
  }
  for (const e of plan.edits) {
    const o = e.old; let pid = o.participant_id; let s1 = o.source_id, s2 = o.source2_id;
    if (o.content_hash !== e.row.tHash) { c.rejectSource(s1, o.id); const x = part(e.row, "transcript", pid); s1 = x?.sourceId ?? null; pid = pid ?? x?.participantId ?? null; if (x?.existing) c.counts.linked++; }
    if ((o.hash2 ?? "") !== e.row.nHash) { c.rejectSource(s2, o.id); const x = part(e.row, "notes", pid); s2 = x?.sourceId ?? null; pid = pid ?? x?.participantId ?? null; if (x?.existing) c.counts.linked++; }
    db.prepare("UPDATE sheet_rows SET row_number=?, content_hash=?, hash2=?, source_id=?, source2_id=?, participant_id=?, cells_json=?, state='live', removed_at=NULL, updated_at=? WHERE id=?")
      .run(e.row.row, e.row.tHash, e.row.nHash || null, s1, s2, pid, JSON.stringify(e.row.display), now(), o.id);
    c.counts.edited++;
  }
  for (const row of plan.adds) {
    const t = part(row, "transcript", null);
    const n = part(row, "notes", t?.participantId ?? null);
    for (const x of [t, n]) if (x?.existing) c.counts.linked++;
    const pid = t?.participantId || n?.participantId || null;
    db.prepare("INSERT INTO sheet_rows(link_id,tab,row_number,content_hash,hash2,source_id,source2_id,external_id,participant_id,cells_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(c.linkId, plan.tab.title, row.row, row.tHash, row.nHash || null, t?.sourceId ?? null, n?.sourceId ?? null, row.id, pid, JSON.stringify(row.display), now());
    if ((t && !t.existing) || (n && !n.existing)) c.counts.added++;
  }
  for (const rem of plan.removes) {
    db.prepare("UPDATE sheet_rows SET state='removed', removed_at=?, updated_at=? WHERE id=?").run(now(), now(), rem.id); // flagged, never silently erased
    c.counts.removed++;
  }
}

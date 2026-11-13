import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import mammoth from "mammoth";
import { audit, type Db } from "../db";
import { addCounts, makeRedactor, zeroCounts, type RedactionCounts } from "../redact";

export type SubmittedBy = "research_team" | "contributor";
export type IngestResult = { studyId: string; sourcesAdded: number; sourcesSkipped: number; participantsAdded: number; redaction: RedactionCounts };
/** Local-only list of removed names/places so later files are redacted consistently. Never stored in the DB, never sent to an AI. */
export type TermsStore = { names: string[]; places: string[] };
export function loadTerms(file?: string): TermsStore {
  if (!file || !fs.existsSync(file)) return { names: [], places: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function saveTerms(file: string | undefined, t: TermsStore) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ names: [...new Set(t.names)], places: [...new Set(t.places)] }), { mode: 0o600 });
}

export type Language = "en" | "hi" | "hinglish";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
const now = () => new Date().toISOString();

export function detectLanguage(text: string): Language {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return "en";
  const deva = text.match(/[ऀ-ॿ]/g)?.length ?? 0;
  if (deva / letters > 0.3) return "hi";
  const hinglishWords = /\b(hai|hain|nahi|nhi|kya|toh|to|ki|ke|ka|ko|se|main|mai|hum|aap|bhi|kar|karti|karta|aur|par|lekin|achha|accha|thoda|bahut|jab|tab|mera|mere|iska|wahi|matlab)\b/gi;
  const hits = text.match(hinglishWords)?.length ?? 0;
  const words = text.split(/\s+/).length || 1;
  return hits / words > 0.04 ? "hinglish" : "en";
}

export function ensureStudy(db: Db, name: string, product: string): string {
  const id = "S-" + sha(name).slice(0, 8);
  db.prepare("INSERT OR IGNORE INTO studies(id,name,product,created_at) VALUES (?,?,?,?)").run(id, name, product, now());
  return id;
}

function nextParticipantId(db: Db): string {
  const row = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,2) AS INTEGER)),0) AS n FROM participants").get() as { n: number };
  return "P" + String(row.n + 1).padStart(3, "0");
}

function addParticipant(db: Db, studyId: string, meta: Record<string, string>): string {
  const id = nextParticipantId(db);
  db.prepare("INSERT INTO participants(id,study_id,meta_json,created_at) VALUES (?,?,?,?)").run(id, studyId, JSON.stringify(meta), now());
  return id;
}

function parseDmy(s: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

function addSource(db: Db, row: {
  studyId: string; participantId: string; type: string; origin: string; title: string; date: string | null;
  lang: Language; key: string; counts: RedactionCounts; quality?: string; submittedBy: SubmittedBy;
}): string | null {
  const id = "SRC-" + row.key.slice(0, 10);
  const res = db.prepare(
    `INSERT OR IGNORE INTO sources(id,study_id,participant_id,source_type,origin,title,date,original_language,status,external_key,redaction_json,quality,created_at,submitted_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, row.studyId, row.participantId, row.type, row.origin, row.title, row.date, row.lang, row.submittedBy === "research_team" ? "approved" : "pending", row.key, JSON.stringify(row.counts), row.quality ?? null, now(), row.submittedBy);
  return res.changes ? id : null;
}

function addUtterances(db: Db, sourceId: string, participantId: string | null, turns: { speaker: string; text: string; start?: number }[]) {
  const ins = db.prepare("INSERT INTO utterances(source_id,participant_id,speaker,seq,text,start_sec) VALUES (?,?,?,?,?,?)");
  turns.forEach((t, i) => ins.run(sourceId, participantId, t.speaker, i, t.text, t.start ?? null));
}

export const CALL_COLUMNS: Record<string, string> = Object.fromEntries(
  ["Name", "City", "Mobile Number", "Product Name", "Date", "Status", "Notes", "Type of user", "Payment type", "Call duration"].map((c) => [c.toLowerCase(), c]));

/** One CX call-notes row (columns named as in CALL_COLUMNS). Returns the existing source if the same note was imported before. */
export function ingestCallRow(db: Db, studyId: string, redact: ReturnType<typeof makeRedactor>, r: Record<string, string>, submittedBy: SubmittedBy): { sourceId: string; participantId: string | null; counts: RedactionCounts; existing: boolean } | null {
  const red = redact(r["Notes"] ?? "");
  const product = redact(r["Product Name"] ?? "").text;
  const date = parseDmy(r["Date"] ?? "");
  const key = sha(`calls|${date}|${product}|${red.text}`);
  const dup = db.prepare("SELECT id, participant_id p FROM sources WHERE external_key=?").get(key) as { id: string; p: string | null } | undefined;
  if (dup) return { sourceId: dup.id, participantId: dup.p, counts: zeroCounts(), existing: true };
  const meta: Record<string, string> = {};
  for (const [k, v] of [["user_type", r["Type of user"]], ["payment_type", r["Payment type"]], ["call_status", r["Status"]], ["call_duration", r["Call duration"]], ["product", product]] as const) {
    if (v && v.trim()) meta[k] = v.trim();
  }
  const pid = addParticipant(db, studyId, meta);
  const sid = addSource(db, { studyId, participantId: pid, type: "cx_call", origin: "researcher_notes", title: `CX call notes · ${product.slice(0, 60)}`, date, lang: detectLanguage(red.text), key, counts: red.counts, submittedBy });
  if (!sid) return null;
  addUtterances(db, sid, pid, red.text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((text) => ({ speaker: "note", text })));
  return { sourceId: sid, participantId: pid, counts: red.counts, existing: false };
}

/** CX call-notes spreadsheet export (CSV). Names, numbers and cities are removed before storage. */
export function ingestCallsCsv(db: Db, csv: string, opts: { studyName: string; product: string; termsPath?: string; submittedBy?: SubmittedBy }): IngestResult {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true, transformHeader: (h) => CALL_COLUMNS[h.trim().toLowerCase()] ?? h.trim() });
  const rows = parsed.data.filter((r) => (r["Notes"] ?? "").trim());
  const known = loadTerms(opts.termsPath);
  const terms: TermsStore = {
    names: [...known.names, ...parsed.data.map((r) => r["Name"] ?? "").filter(Boolean)],
    places: [...known.places, ...parsed.data.map((r) => r["City"] ?? "").filter(Boolean)],
  };
  saveTerms(opts.termsPath, terms);
  const redact = makeRedactor(terms);
  const studyId = ensureStudy(db, opts.studyName, opts.product);
  const result: IngestResult = { studyId, sourcesAdded: 0, sourcesSkipped: 0, participantsAdded: 0, redaction: zeroCounts() };
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const o = ingestCallRow(db, studyId, redact, r, opts.submittedBy ?? "research_team");
      if (!o || o.existing) { result.sourcesSkipped++; continue; }
      result.sourcesAdded++; result.participantsAdded++;
      result.redaction = addCounts(result.redaction, o.counts);
    }
    audit(db, "ingest.calls_csv", { studyId, added: result.sourcesAdded, skipped: result.sourcesSkipped, redaction: result.redaction });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return result;
}

/** "Speaker A ............... 00:00:07" blocks as produced by the screen-recording transcription tool. */
export function parseSpeakerBlocks(raw: string): { speaker: string; text: string }[] {
  const turns: { speaker: string; text: string }[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const m = /^Speaker\s+([A-Z])\s*\.{2,}\s*[\d:]+\s*\n([\s\S]*)$/.exec(block.trim());
    if (m && m[2].trim()) turns.push({ speaker: `speaker_${m[1].toLowerCase()}`, text: m[2].trim() });
  }
  return turns;
}

/** Interview transcript with "Interviewer:" / "Participant:" turns, optionally several "File N" interviews in one document. */
// Joined exports separate recordings with "File N" lines and/or a transcription-tool marker such as
// "now for this Here is the verbatim transcript for the audio file:". Each segment is a separate interview.
const TOOL_MARKER = /(?:now for this[\s-]*)?Here is the verbatim transcript for the audio(?: file| provided)?\s*:/gi;
export function splitInterviews(raw: string): string[] {
  const parts = raw.split(/^\s*File\s+\d+\s*$/gim).flatMap((p) => p.split(TOOL_MARKER)).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [raw.trim()];
}
export function parseLabelledTurns(raw: string): { speaker: string; text: string }[] {
  const turns: { speaker: string; text: string }[] = [];
  if (!/^(Interviewer|Participant)\s*:/im.test(raw) && /Speaker\s+\d+\s*:/.test(raw)) {
    // Unlabelled call transcript embedded in the document: "Speaker 1: ... Speaker 2: ..." on one line
    for (const m of raw.matchAll(/Speaker\s+(\d+)\s*:\s*([\s\S]*?)(?=Speaker\s+\d+\s*:|$)/g)) if (m[2].trim()) turns.push({ speaker: `speaker_${m[1]}`, text: m[2].trim() });
    return turns;
  }
  for (const line of raw.split(/\n/)) {
    const m = /^(Interviewer|Participant)\s*:\s*(.*)$/i.exec(line.trim());
    if (m) turns.push({ speaker: m[1].toLowerCase(), text: m[2].trim() });
    else if (line.trim() && turns.length) turns[turns.length - 1].text += " " + line.trim();
  }
  return turns.filter((t) => t.text);
}

export type TranscriptOpts = { studyName: string; product: string; date?: string; knownNames?: string[]; termsPath?: string; submittedBy?: SubmittedBy; noisy?: boolean; quality?: string; format: "speaker_blocks" | "labelled" };

export function ingestTranscript(db: Db, raw: string, opts: TranscriptOpts): IngestResult {
  const studyId = ensureStudy(db, opts.studyName, opts.product);
  const known = loadTerms(opts.termsPath);
  const terms: TermsStore = { names: [...known.names, ...(opts.knownNames ?? [])], places: known.places };
  saveTerms(opts.termsPath, terms);
  const redact = makeRedactor(terms);
  const result: IngestResult = { studyId, sourcesAdded: 0, sourcesSkipped: 0, participantsAdded: 0, redaction: zeroCounts() };
  const interviews = opts.format === "labelled" ? splitInterviews(raw) : [raw];
  db.exec("BEGIN");
  try {
    interviews.forEach((body, idx) => {
      const turns = opts.format === "labelled" ? parseLabelledTurns(body) : parseSpeakerBlocks(body);
      if (!turns.length) return;
      let counts = zeroCounts();
      const red = turns.map((t) => { const r = redact(t.text); counts = addCounts(counts, r.counts); return { speaker: t.speaker, text: r.text }; });
      const key = sha(`transcript|${opts.studyName}|${red.map((t) => t.text).join("\n")}`);
      if (db.prepare("SELECT 1 FROM sources WHERE external_key=?").get(key)) { result.sourcesSkipped++; return; }
      const pid = addParticipant(db, studyId, {});
      const sid = addSource(db, { studyId, participantId: pid, type: "interview", origin: "verbatim_transcript", title: `${opts.studyName} · interview ${idx + 1}`, date: opts.date ?? null, lang: detectLanguage(red.map((t) => t.text).join(" ")), key, counts, quality: opts.quality ?? (opts.noisy ? "noisy_asr" : undefined), submittedBy: opts.submittedBy ?? "research_team" });
      if (!sid) { result.sourcesSkipped++; return; }
      addUtterances(db, sid, pid, red);
      result.sourcesAdded++; result.participantsAdded++;
      result.redaction = addCounts(result.redaction, counts);
    });
    audit(db, "ingest.transcript", { studyId, added: result.sourcesAdded, skipped: result.sourcesSkipped, redaction: result.redaction });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return result;
}

export async function docxToText(buf: Buffer): Promise<string> {
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

/** Free-text input from CX or any team member. Always lands as a pending contributor source; never counts as evidence until approved. */
export function ingestContribution(db: Db, text: string, opts: { kind: "cx_call" | "interview"; termsPath?: string; submittedBy?: SubmittedBy; studyName?: string; product?: string; date?: string | null; knownNames?: string[] }): { sourceId: string; participantId: string } | null {
  const known = loadTerms(opts.termsPath);
  const terms: TermsStore = { names: [...known.names, ...(opts.knownNames ?? [])], places: known.places };
  if (opts.knownNames?.length) saveTerms(opts.termsPath, terms);
  const red = makeRedactor(terms)(text.trim().slice(0, 200000));
  if (!red.text) return null;
  const studyId = ensureStudy(db, opts.studyName ?? "Team contributions", opts.product ?? "");
  const key = sha(`contrib|${red.text}`);
  if (db.prepare("SELECT 1 FROM sources WHERE external_key=?").get(key)) return null; // duplicate
  db.exec("BEGIN");
  try {
    const pid = addParticipant(db, studyId, {});
    const sid = addSource(db, { studyId, participantId: pid, type: opts.kind, origin: "researcher_notes", title: opts.studyName ? `${opts.studyName} · notes` : `Contribution · ${new Date().toISOString().slice(0, 10)}`, date: opts.date === undefined ? new Date().toISOString().slice(0, 10) : opts.date, lang: detectLanguage(red.text), key, counts: red.counts, submittedBy: opts.submittedBy ?? "contributor" });
    if (!sid) { db.exec("ROLLBACK"); return null; }
    addUtterances(db, sid, pid, red.text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ speaker: "note", text: t })));
    audit(db, "contribution.received", { sourceId: sid, redaction: red.counts });
    db.exec("COMMIT");
    return { sourceId: sid, participantId: pid };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** A transcript produced by machine transcription of a recording: already split into timed turns. One recording = one participant. */
export function ingestTimedTranscript(db: Db, turns: { speaker: string; text: string; start?: number }[], opts: { studyName: string; product: string; kind: "interview" | "cx_call"; date?: string | null; knownNames?: string[]; termsPath?: string; submittedBy?: SubmittedBy; mediaSha?: string; quality?: string }): { sourceId: string; participantId: string; redaction: RedactionCounts } | null {
  const known = loadTerms(opts.termsPath);
  const terms: TermsStore = { names: [...known.names, ...(opts.knownNames ?? [])], places: known.places };
  if (opts.knownNames?.length) saveTerms(opts.termsPath, terms);
  const redact = makeRedactor(terms);
  let counts = zeroCounts();
  const red = turns.map((t) => { const r = redact(t.text.trim()); counts = addCounts(counts, r.counts); return { speaker: t.speaker, text: r.text, start: t.start }; }).filter((t) => t.text);
  if (!red.length) return null;
  const studyId = ensureStudy(db, opts.studyName, opts.product);
  const key = sha(`media|${opts.mediaSha ?? red.map((t) => t.text).join("\n")}`);
  if (db.prepare("SELECT 1 FROM sources WHERE external_key=?").get(key)) return null;
  db.exec("BEGIN");
  try {
    const pid = addParticipant(db, studyId, {});
    const sid = addSource(db, { studyId, participantId: pid, type: opts.kind, origin: "verbatim_transcript", title: `${opts.studyName} · recording`, date: opts.date ?? null, lang: detectLanguage(red.map((t) => t.text).join(" ")), key, counts, quality: opts.quality ?? "asr_gemini", submittedBy: opts.submittedBy ?? "research_team" });
    if (!sid) { db.exec("ROLLBACK"); return null; }
    addUtterances(db, sid, pid, red);
    audit(db, "ingest.recording", { studyId, redaction: counts });
    db.exec("COMMIT");
    return { sourceId: sid, participantId: pid, redaction: counts };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

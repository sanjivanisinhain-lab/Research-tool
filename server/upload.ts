import path from "node:path";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import { PDFParse } from "pdf-parse";
import type { Db } from "./db";
import { audit } from "./db";
import { addCounts, zeroCounts, type RedactionCounts } from "./redact";
import { syncSheet, fileLinkId } from "./sheets";
import { FileSheets, clearPending, savePending, type FileTab } from "./sheetsFile";
import { hubHeaderIndex } from "./sheetsHub";
import { CALL_COLUMNS, docxToText, ingestCallsCsv, ingestContribution, ingestTranscript, type IngestResult } from "./ingest";

export type UploadMeta = { study: string; product: string; kind: "interview" | "cx_call"; date?: string | null; names: string[]; termsPath?: string; pendingDir?: string };
export type UploadResult = {
  status: "processed" | "partial" | "failed" | "unsupported" | "queued" | "review"; message: string; format?: string;
  sourcesAdded: number; sourcesSkipped: number; participantsAdded: number; redaction: RedactionCounts;
};

const AUDIO_VIDEO = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".mkv", ".webm", ".avi"]);
/** Text of a spreadsheet cell, whatever its kind (plain, rich text, formula result, hyperlink, date). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
    return "";
  }
  return String(v);
}

const empty = (): Omit<UploadResult, "status" | "message"> => ({ sourcesAdded: 0, sourcesSkipped: 0, participantsAdded: 0, redaction: zeroCounts() });
const fail = (status: UploadResult["status"], message: string): UploadResult => ({ status, message, ...empty() });

export function detectTranscriptFormat(text: string): "speaker_blocks" | "labelled" | "plain" {
  if (/^Speaker\s+[A-Z]\s*\.{2,}/m.test(text)) return "speaker_blocks";
  if (/^(Interviewer|Participant)\s*:/im.test(text)) return "labelled";
  return "plain";
}
const fromIngest = (r: IngestResult, format: string): UploadResult => ({
  status: r.sourcesAdded + r.sourcesSkipped === 0 ? "failed" : "processed", format, sourcesAdded: r.sourcesAdded, sourcesSkipped: r.sourcesSkipped, participantsAdded: r.participantsAdded, redaction: r.redaction,
  message: r.sourcesAdded + r.sourcesSkipped === 0 ? "Nothing could be read from this file." : r.sourcesAdded === 0 ? "Already imported: nothing new to add." : `Added ${r.sourcesAdded} source${r.sourcesAdded === 1 ? "" : "s"}.`,
});

async function ingestText(db: Db, text: string, meta: UploadMeta, noisyHint = false): Promise<UploadResult> {
  const fmt = detectTranscriptFormat(text);
  const common = { studyName: meta.study, product: meta.product, termsPath: meta.termsPath, knownNames: meta.names, date: meta.date ?? undefined, submittedBy: "research_team" as const };
  if (fmt === "speaker_blocks") return fromIngest(ingestTranscript(db, text, { ...common, noisy: true, format: "speaker_blocks" }), "transcript (speaker blocks)");
  if (fmt === "labelled") return fromIngest(ingestTranscript(db, text, { ...common, noisy: noisyHint, format: "labelled" }), "transcript (interviewer/participant)");
  const r = ingestContribution(db, text, { kind: meta.kind, termsPath: meta.termsPath, submittedBy: "research_team", studyName: meta.study, product: meta.product, date: meta.date ?? null, knownNames: meta.names });
  return r ? { status: "processed", format: "plain text / notes", sourcesAdded: 1, sourcesSkipped: 0, participantsAdded: 1, redaction: zeroCounts(), message: "Added 1 source (plain notes: treated as researcher notes, not verbatim quotes)." }
    : { status: "failed", format: "plain text / notes", ...empty(), message: "Empty or already imported." };
}

function ingestCsvText(db: Db, csv: string, meta: UploadMeta): IngestResult | null {
  if (!meta.study.trim()) throw new Error("This is a call-notes sheet (no Participant ID column), so it needs a study name. Type one above and upload it again.");
  const head = Papa.parse<string[]>(csv, { preview: 1 }).data[0] ?? [];
  if (!head.some((h) => (CALL_COLUMNS[String(h).trim().toLowerCase()] ?? "") === "Notes")) return null;
  return ingestCallsCsv(db, csv, { studyName: meta.study, product: meta.product, termsPath: meta.termsPath, submittedBy: "research_team" });
}

/** A sheet with one row per participant (Participant ID plus Transcript and/or Notes). Returns null if the tabs are not that layout. */
async function importParticipantSheet(db: Db, tabs: FileTab[], fileName: string, meta: UploadMeta): Promise<UploadResult | null> {
  if (!tabs.some((t) => hubHeaderIndex(t.values) >= 0)) return null;
  if (!meta.pendingDir) return fail("failed", "This server isn't set up to hold a sheet for review.");
  const name = path.basename(fileName, path.extname(fileName)).replace(/\s*\(\d+\)$/, "") || "Uploaded research sheet";
  const linkId = fileLinkId(db, name);
  savePending(meta.pendingDir, linkId, tabs);
  const r = await syncSheet(db, new FileSheets(tabs, name), linkId, { ...(meta.termsPath ? { termsPath: meta.termsPath } : {}) });
  const base = { format: "participant sheet", sourcesSkipped: r.unchanged, participantsAdded: r.added, redaction: zeroCounts() };
  if (r.status === "preview") return { ...base, status: "review", sourcesAdded: 0, participantsAdded: 0, sourcesSkipped: 0, message: `Read ${r.preview?.rows ?? 0} participants. Nothing is imported yet: open the Google Sheets tab, review the report, then press Import.` };
  if (r.status === "needs_confirmation") return { ...base, status: "review", sourcesAdded: 0, message: `${r.message} Open the Google Sheets tab to apply it.` };
  if (!r.ok) { clearPending(meta.pendingDir, linkId); return fail("failed", r.message); }
  clearPending(meta.pendingDir, linkId);
  return { ...base, status: "processed", sourcesAdded: r.added + r.edited, message: r.message };
}

/** Detect the format, redact, store. Never stores the filename (it can contain a participant's name). */
export async function processUpload(db: Db, file: { name: string; buf: Buffer }, meta: UploadMeta): Promise<UploadResult> {
  const ext = path.extname(file.name).toLowerCase();
  let result: UploadResult;
  try {
    if (AUDIO_VIDEO.has(ext)) result = fail("unsupported", "Recordings are uploaded through the upload screen (they are transcribed in the background).");
    else if (ext === ".csv") {
      const text = file.buf.toString("utf8");
      const grid = Papa.parse<string[]>(text, { skipEmptyLines: false }).data;
      const hub = await importParticipantSheet(db, [{ title: "Participant hub", values: grid.map((r) => r.map((c) => String(c ?? ""))) }], file.name, meta);
      const r = hub ? null : ingestCsvText(db, text, meta);
      if (hub) result = hub; else result = r ? fromIngest(r, "CX call notes (CSV)") : fail("failed", "No 'Notes' column found. A call-notes sheet needs a Notes column (plus any of: Name, City, Mobile Number, Product Name, Date, Type of user, Payment type, Call duration).");
    } else if (ext === ".xls") {
      result = fail("unsupported", "Old .xls files aren't supported. Open it and Save As .xlsx (or CSV), then upload that.");
    } else if (ext === ".xlsx") {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buf as unknown as ArrayBuffer);
      const tabs: FileTab[] = [];
      for (const sheet of wb.worksheets) { // keep real row numbers: blank rows stay as empty rows, so "row 42" means row 42 in the file
        if (sheet.state === "hidden" || sheet.state === "veryHidden") continue;
        const values: string[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row, n) => { values[n - 1] = ((row.values as unknown[]).slice(1)).map(cellText); });
        for (let i = 0; i < values.length; i++) values[i] ??= [];
        tabs.push({ title: sheet.name, values });
      }
      const hubResult = await importParticipantSheet(db, tabs, file.name, meta);
      if (hubResult) return finishUpload(db, ext, hubResult);
      let total: UploadResult = { ...fail("failed", ""), format: "CX call notes (Excel)" }; let used = 0; const skipped: string[] = [];
      for (const sheet of wb.worksheets) {
        const rows: string[][] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => { rows.push(((row.values as unknown[]).slice(1)).map(cellText)); });
        const r = ingestCsvText(db, Papa.unparse(rows), meta);
        if (!r) { skipped.push(sheet.name); continue; }
        used++; total = { ...total, sourcesAdded: total.sourcesAdded + r.sourcesAdded, sourcesSkipped: total.sourcesSkipped + r.sourcesSkipped, participantsAdded: total.participantsAdded + r.participantsAdded, redaction: addCounts(total.redaction, r.redaction) };
      }
      total.status = used === 0 ? "failed" : skipped.length ? "partial" : "processed";
      total.message = used === 0 ? "No sheet has a 'Notes' column, so nothing was imported." : `Imported ${used} sheet${used === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.length} sheet(s) with no Notes column (${skipped.length} not processed)` : ""}. Added ${total.sourcesAdded} source(s).`;
      result = total;
    } else if (ext === ".txt" || ext === ".md") result = await ingestText(db, file.buf.toString("utf8"), meta);
    else if (ext === ".docx") result = await ingestText(db, await docxToText(file.buf), meta);
    else if (ext === ".pdf") {
      const parser = new PDFParse({ data: new Uint8Array(file.buf) });
      const pdf = await parser.getText();
      await parser.destroy();
      const text = pdf.text.trim();
      result = text.length < 40 * Math.max(1, pdf.total ?? 1) ? fail("failed", "This PDF looks scanned (no readable text). Scanned PDFs need OCR, which isn't built yet. Upload a text version, or ask for OCR to be added.") : await ingestText(db, text, meta);
    } else result = fail("unsupported", `Files of type '${ext || "unknown"}' aren't supported. Use csv, xlsx, txt, docx or pdf.`);
  } catch (e) {
    result = fail("failed", `Could not process this file: ${(e as Error).message.slice(0, 160)}`);
  }
  return finishUpload(db, ext, result);
}

function finishUpload(db: Db, ext: string, result: UploadResult): UploadResult {
  audit(db, "upload", { ext, status: result.status, added: result.sourcesAdded, skipped: result.sourcesSkipped, redaction: result.redaction });
  return result;
}

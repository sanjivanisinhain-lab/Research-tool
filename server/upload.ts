import path from "node:path";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import type { Db } from "./db";
import { audit } from "./db";
import { addCounts, zeroCounts, type RedactionCounts } from "./redact";
import { CALL_COLUMNS, docxToText, ingestCallsCsv, ingestContribution, ingestTranscript, type IngestResult } from "./ingest";

export type UploadMeta = { study: string; product: string; kind: "interview" | "cx_call"; date?: string | null; names: string[]; termsPath?: string };
export type UploadResult = {
  status: "processed" | "partial" | "failed" | "unsupported" | "queued"; message: string; format?: string;
  sourcesAdded: number; sourcesSkipped: number; participantsAdded: number; redaction: RedactionCounts;
};

const AUDIO_VIDEO = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".mp4", ".mov", ".mkv", ".webm", ".avi"]);
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
  const head = Papa.parse<string[]>(csv, { preview: 1 }).data[0] ?? [];
  if (!head.some((h) => (CALL_COLUMNS[String(h).trim().toLowerCase()] ?? "") === "Notes")) return null;
  return ingestCallsCsv(db, csv, { studyName: meta.study, product: meta.product, termsPath: meta.termsPath, submittedBy: "research_team" });
}

/** Detect the format, redact, store. Never stores the filename (it can contain a participant's name). */
export async function processUpload(db: Db, file: { name: string; buf: Buffer }, meta: UploadMeta): Promise<UploadResult> {
  const ext = path.extname(file.name).toLowerCase();
  let result: UploadResult;
  try {
    if (AUDIO_VIDEO.has(ext)) result = fail("unsupported", "Recordings are uploaded through the upload screen (they are transcribed in the background).");
    else if (ext === ".csv") {
      const r = ingestCsvText(db, file.buf.toString("utf8"), meta);
      result = r ? fromIngest(r, "CX call notes (CSV)") : fail("failed", "No 'Notes' column found. A call-notes sheet needs a Notes column (plus any of: Name, City, Mobile Number, Product Name, Date, Type of user, Payment type, Call duration).");
    } else if (ext === ".xlsx" || ext === ".xls") {
      const wb = XLSX.read(file.buf, { type: "buffer" });
      let total: UploadResult = { ...fail("failed", ""), format: "CX call notes (Excel)" }; let used = 0; const skipped: string[] = [];
      for (const name of wb.SheetNames) {
        const r = ingestCsvText(db, XLSX.utils.sheet_to_csv(wb.Sheets[name]), meta);
        if (!r) { skipped.push(name); continue; }
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
  audit(db, "upload", { ext, status: result.status, added: result.sourcesAdded, skipped: result.sourcesSkipped, redaction: result.redaction });
  return result;
}

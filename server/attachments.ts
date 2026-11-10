import path from "node:path";
import { PDFParse } from "pdf-parse";
import { docxToText } from "./ingest";
import type { Attachment } from "../src/types/research";

const MAX_BYTES = 10 * 1024 * 1024;

/** Readable text of an attachment (pasted text, .txt/.md, .docx, text-based .pdf). Empty string when there is nothing to read. */
export async function attachmentText(a: Attachment): Promise<string> {
  if (a.text) return a.text;
  if (!a.data) return "";
  const buf = Buffer.from(a.data, "base64");
  if (buf.length > MAX_BYTES) throw new Error(`${a.name} is larger than 10 MB`);
  const ext = path.extname(a.name).toLowerCase();
  if (ext === ".txt" || ext === ".md" || a.mimeType?.startsWith("text/")) return buf.toString("utf8");
  if (ext === ".docx") return docxToText(buf);
  if (ext === ".pdf") {
    const p = new PDFParse({ data: new Uint8Array(buf) });
    try { return (await p.getText()).text; } finally { await p.destroy(); }
  }
  return "";
}

export async function attachmentsText(list: Attachment[] | undefined): Promise<string> {
  const parts: string[] = [];
  for (const a of list ?? []) { const t = (await attachmentText(a)).trim(); if (t) parts.push(t); }
  return parts.join("\n\n");
}

/** Does this look like a research script / interview guide / questionnaire rather than a question about users? */
export function looksLikeScript(question: string, scriptText: string): boolean {
  const body = scriptText || question;
  const qMarks = (body.match(/\?/g) ?? []).length;
  const lines = body.split(/\n+/).filter((l) => l.trim().length > 8);
  const mentions = /\b(script|interview guide|discussion guide|questionnaire|survey questions?|moderator guide|review (my|this|these) questions)\b/i.test(question);
  if (scriptText.length > 60 && (qMarks >= 3 || mentions)) return true; // attached/pasted material with several questions
  return mentions && qMarks >= 3 && lines.length >= 3;
}

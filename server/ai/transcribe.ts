import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { ingestTimedTranscript } from "../ingest";
import { toAudioChunks } from "../media";

export type TranscribePayload = { path: string; sha256: string; study: string; product: string; kind: "interview" | "cx_call"; date: string | null; names: string[]; termsPath?: string };

const SYSTEM = `You transcribe a recording of a user-research interview or customer call (India; Hindi, Hinglish, English).
Rules:
- Transcribe EXACTLY what is said, in order. Do not summarise, correct, translate or add anything. Write Hindi words in Roman script (Hinglish) and English words in English, the way people type Hinglish.
- Split into turns each time the speaker changes. speaker = "interviewer" (the person asking the questions / moderating / the agent making the call), "participant" (the customer or person being interviewed), or "other" (anyone else). If you cannot tell, use "participant".
- start_seconds = when the turn starts, measured from the start of THIS audio clip.
- Privacy: replace any personal name spoken (of a person, not a brand) with [NAME], any phone number with [PHONE], any email with [EMAIL], and any street address with [ADDRESS].
- Mark unclear speech as [unclear]. If there is no speech, return no turns.`;
const SCHEMA = { type: "OBJECT", properties: { turns: { type: "ARRAY", items: { type: "OBJECT", properties: { speaker: { type: "STRING", enum: ["interviewer", "participant", "other"] }, start_seconds: { type: "NUMBER" }, text: { type: "STRING" } }, required: ["speaker", "start_seconds", "text"] } } }, required: ["turns"] };

const mimeOf = () => "audio/mp3"; // chunks are always re-encoded to mp3

export type TranscribeResult = { sourceId: string | null; turns: number; chunks: number; duplicate: boolean };

/** Transcribe one recording (audio or video) into a stored, redacted transcript, then queue it for evidence extraction. */
export async function transcribeRecording(db: Db, ai: AiProvider, p: TranscribePayload, progress: (note: string) => void = () => {}): Promise<TranscribeResult> {
  const dup = db.prepare("SELECT source_id FROM media_hashes WHERE sha256=?").get(p.sha256) as { source_id: string | null } | undefined;
  if (dup) return { sourceId: dup.source_id, turns: 0, chunks: 0, duplicate: true };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rh-media-"));
  try {
    const chunks = await toAudioChunks(p.path, work);
    const turns: { speaker: string; text: string; start: number }[] = [];
    for (const [i, c] of chunks.entries()) {
      progress(`Transcribing part ${i + 1} of ${chunks.length}`);
      const out = await ai.generateJsonWithMedia<{ turns: { speaker: string; start_seconds: number; text: string }[] }>(
        { system: SYSTEM, schema: SCHEMA, prompt: "Transcribe this audio clip." }, [{ mimeType: mimeOf(), data: fs.readFileSync(c.file) }]);
      for (const t of out.turns ?? []) if (t.text?.trim()) turns.push({ speaker: t.speaker, text: t.text, start: Math.max(0, t.start_seconds ?? 0) + c.offset });
    }
    if (!turns.length) throw new Error("No speech was found in this recording");
    const r = ingestTimedTranscript(db, turns, { studyName: p.study, product: p.product, kind: p.kind, date: p.date, knownNames: p.names, termsPath: p.termsPath, mediaSha: p.sha256 });
    db.prepare("INSERT OR REPLACE INTO media_hashes(sha256, source_id, created_at) VALUES (?,?,?)").run(p.sha256, r?.sourceId ?? null, new Date().toISOString());
    audit(db, "transcribe", { chunks: chunks.length, turns: turns.length, redaction: r?.redaction ?? null });
    return { sourceId: r?.sourceId ?? null, turns: turns.length, chunks: chunks.length, duplicate: !r };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export const newUploadPath = (dir: string, ext: string) => { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${crypto.randomUUID()}${ext}`); };

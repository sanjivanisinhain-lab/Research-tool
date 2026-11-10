import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { ingestTimedTranscript } from "../ingest";
import { streamKinds, toAudioChunks, toVideoChunks } from "../media";

export type TranscribePayload = { path: string; sha256: string; study: string; product: string; kind: "interview" | "cx_call"; date: string | null; names: string[]; termsPath?: string; screen?: boolean };

const SYSTEM = `You transcribe a recording of a user-research interview or customer call (India; Hindi, Hinglish, English).
Rules:
- Transcribe EXACTLY what is said, in order. Do not summarise, correct, translate or add anything. Write Hindi words in Roman script (Hinglish) and English words in English, the way people type Hinglish.
- Split into turns each time the speaker changes. speaker = "interviewer" (the person asking the questions / moderating / the agent making the call), "participant" (the customer or person being interviewed), or "other" (anyone else). If you cannot tell, use "participant".
- start_seconds = when the turn starts, measured from the start of THIS audio clip.
- Privacy: replace any personal name spoken (of a person, not a brand) with [NAME], any phone number with [PHONE], any email with [EMAIL], and any street address with [ADDRESS].
- Mark unclear speech as [unclear]. If there is no speech, return no turns.`;
const SCHEMA = { type: "OBJECT", properties: { turns: { type: "ARRAY", items: { type: "OBJECT", properties: { speaker: { type: "STRING", enum: ["interviewer", "participant", "other"] }, start_seconds: { type: "NUMBER" }, text: { type: "STRING" } }, required: ["speaker", "start_seconds", "text"] } } }, required: ["turns"] };

const SCREEN_SYSTEM = `You watch a screen recording of a person using an app during a user-research session and write down WHAT THEY DID on screen, as factual observations.
- Only describe what is visible: which screen, what was tapped, typed, scrolled, or read off the screen (UI labels exactly as shown, prices included). Do NOT guess feelings or intentions.
- Say "taps" or "types" only when a touch or typing is visible. If the screen simply changes, write "The screen changes to ...". Never claim an action you cannot see.
- start_seconds = when it happens in this clip. One observation per distinct action or screen state; merge repeated scrolling into one.
- A period where nothing changes for 4 seconds or more is a "wait": say what was on screen and for how long. Set friction: hesitation (a long pause before acting), backtrack (going back or undoing), error, abandon (leaving the task), else none.
- Each description is one plain sentence starting with "The participant" or "The screen shows".
- Privacy: never copy a person's name, phone number, address, email or payment details seen on screen; write [NAME], [PHONE], [ADDRESS] or [EMAIL] instead.`;
const SCREEN_SCHEMA = { type: "OBJECT", properties: { observations: { type: "ARRAY", items: { type: "OBJECT", properties: {
  start_seconds: { type: "NUMBER" }, action: { type: "STRING", enum: ["open_app", "search", "type", "tap", "scroll", "navigate_back", "wait", "view", "error", "close_app", "other"] },
  friction: { type: "STRING", enum: ["none", "hesitation", "backtrack", "error", "abandon"] }, description: { type: "STRING" } }, required: ["start_seconds", "action", "friction", "description"] } } }, required: ["observations"] };

const mimeOf = () => "audio/mp3"; // chunks are always re-encoded to mp3

export type TranscribeResult = { sourceId: string | null; turns: number; chunks: number; duplicate: boolean };

/** Transcribe one recording (audio or video) into a stored, redacted transcript, then queue it for evidence extraction. */
export async function transcribeRecording(db: Db, ai: AiProvider, p: TranscribePayload, progress: (note: string) => void = () => {}): Promise<TranscribeResult> {
  const dup = db.prepare("SELECT source_id FROM media_hashes WHERE sha256=?").get(p.sha256) as { source_id: string | null } | undefined;
  if (dup) return { sourceId: dup.source_id, turns: 0, chunks: 0, duplicate: true };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rh-media-"));
  try {
    const kinds = await streamKinds(p.path);
    if (p.screen && !kinds.video) throw new Error("This file has no picture, so the screen can't be analysed");
    if (!p.screen && !kinds.audio) throw new Error("This file has no audio track (tick the screen analysis option to use the picture instead)");
    const turns: { speaker: string; text: string; start: number }[] = [];
    let parts = 0;
    if (kinds.audio) {
      const chunks = await toAudioChunks(p.path, path.join(work, "audio"));
      parts += chunks.length;
      for (const [i, c] of chunks.entries()) {
        progress(`Transcribing speech, part ${i + 1} of ${chunks.length}`);
        const out = await ai.generateJsonWithMedia<{ turns: { speaker: string; start_seconds: number; text: string }[] }>(
          { system: SYSTEM, schema: SCHEMA, prompt: "Transcribe this audio clip." }, [{ mimeType: mimeOf(), data: fs.readFileSync(c.file) }]);
        for (const t of out.turns ?? []) if (t.text?.trim()) turns.push({ speaker: t.speaker, text: t.text, start: Math.max(0, t.start_seconds ?? 0) + c.offset });
      }
    }
    if (p.screen) {
      const clips = await toVideoChunks(p.path, path.join(work, "video"));
      parts += clips.length;
      for (const [i, c] of clips.entries()) {
        progress(`Analysing the screen, part ${i + 1} of ${clips.length}`);
        const out = await ai.generateJsonWithMedia<{ observations: { start_seconds: number; friction: string; description: string }[] }>(
          { system: SCREEN_SYSTEM, schema: SCREEN_SCHEMA, prompt: "Describe what the participant did on screen." }, [{ mimeType: "video/mp4", data: fs.readFileSync(c.file) }]);
        for (const o of out.observations ?? []) if (o.description?.trim()) turns.push({ speaker: "screen", text: o.friction && o.friction !== "none" ? `${o.description.trim()} Friction: ${o.friction}.` : o.description.trim(), start: Math.max(0, o.start_seconds ?? 0) + c.offset });
      }
    }
    if (!turns.length) throw new Error(p.screen ? "No speech or on-screen activity was found in this recording" : "No speech was found in this recording");
    turns.sort((a, b) => a.start - b.start); // stable: speech and screen events interleave in time order
    const r = ingestTimedTranscript(db, turns, { studyName: p.study, product: p.product, kind: p.kind, date: p.date, knownNames: p.names, termsPath: p.termsPath, mediaSha: p.sha256, quality: p.screen ? "asr_screen_gemini" : "asr_gemini" });
    db.prepare("INSERT OR REPLACE INTO media_hashes(sha256, source_id, created_at) VALUES (?,?,?)").run(p.sha256, r?.sourceId ?? null, new Date().toISOString());
    audit(db, "transcribe", { parts, turns: turns.length, screen: !!p.screen, redaction: r?.redaction ?? null });
    return { sourceId: r?.sourceId ?? null, turns: turns.length, chunks: parts, duplicate: !r };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export const newUploadPath = (dir: string, ext: string) => { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, `${crypto.randomUUID()}${ext}`); };

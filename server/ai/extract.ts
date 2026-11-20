import { audit, type Db } from "../db";
import { GeminiError, type AiProvider } from "./provider";

export const PROMPT_VERSION = "extract-v2";
const MAX_CHUNK_CHARS = 12000; // one call per chunk: long transcripts used to take dozens of calls, and each short note a call of its own, which is what made reading slow
export const SMALL_SOURCE_CHARS = 3500; // short sources (most notes) are read several to a call

type Utt = { id: number; speaker: string; text: string };
export type Finding = {
  utterance_id: number; quote: string; translation?: string; kind: "said" | "did";
  theme: string; sentiment: "positive" | "negative" | "neutral" | "mixed";
  pain_point?: string; need?: string; job_to_be_done?: string; emotion?: string; speaker_uncertain?: boolean;
};

const SYSTEM = `You extract atomic research evidence from redacted user-research material about online shopping (mostly India; Hindi, Hinglish and English).
Rules:
- Use ONLY the text given. Never use outside knowledge about users. Never invent anything.
- "quote" MUST be copied character-for-character from one numbered line (a contiguous substring, in its original language/script). If unsure, omit the finding.
- Lines from speaker "screen" are AI-written observations of what appeared on the participant's screen (not their words). Extract concrete on-screen behaviours and friction from them as kind="did" (e.g. paused 10 seconds on the cart, went back, abandoned), quoting an exact sentence from the line.
- Only extract what the PARTICIPANT or CUSTOMER said or reported doing. Ignore interviewer questions and instructions. Lines marked "note" are a researcher's summary of a call: extract the participant's reported statements and behaviours from them.
- kind="said" for stated opinions, reasons, beliefs, feelings. kind="did" for reported or observed behaviour (ordered, cancelled, returned, switched app, paid COD...).
- Give a short theme (2-4 words, English, lowercase), sentiment toward the product/platform/experience described, and where clearly supported: pain_point, need, job_to_be_done, emotion. Leave them out when not clearly supported.
- translation: a faithful English rendering of the quote (it is NOT verbatim).
- Placeholders like [NAME], [CITY], [PHONE] are redactions; keep them as is.
- Some transcripts are noisy machine transcriptions with unreliable speaker labels. If you cannot tell the participant from the interviewer, set speaker_uncertain=true.
- From researcher notes, ALSO extract concrete reported behaviours and outcomes (kept/returned/cancelled the order, payment mode and why, stopped ordering, switched or compared apps, did not complain and why, how they discover products). Use a contiguous sentence or phrase from the note as the quote, kind="did".
- Aim for roughly 3-8 findings per call note or per 3,000 characters of transcript, each about a different point, and never more than 30 in one reply. Skip filler, greetings and anything not about shopping or the platform.
- Several sources may be given, each introduced by a line starting with "--- Source". Take each finding from the numbered line it really comes from; do not mix people up.`;

const SCHEMA = {
  type: "OBJECT",
  properties: { findings: { type: "ARRAY", items: { type: "OBJECT", properties: {
    utterance_id: { type: "INTEGER" }, quote: { type: "STRING" }, translation: { type: "STRING" },
    kind: { type: "STRING", enum: ["said", "did"] }, theme: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["positive", "negative", "neutral", "mixed"] },
    pain_point: { type: "STRING" }, need: { type: "STRING" }, job_to_be_done: { type: "STRING" }, emotion: { type: "STRING" },
    speaker_uncertain: { type: "BOOLEAN" },
  }, required: ["utterance_id", "quote", "kind", "theme", "sentiment"] } } },
  required: ["findings"],
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function chunkUtterances(utts: Utt[], max = MAX_CHUNK_CHARS): Utt[][] {
  const chunks: Utt[][] = []; let cur: Utt[] = []; let size = 0;
  for (const u of utts) {
    if (size + u.text.length > max && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(u); size += u.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** True when the quote sits inside double quotes in the note, i.e. the researcher recorded the participant's own words. */
export function isQuotedVerbatim(utteranceText: string, quote: string): boolean {
  const t = norm(utteranceText);
  const i = t.indexOf(norm(quote));
  if (i < 0) return false;
  const before = t.slice(0, i).replace(/[^"“”]/g, "").length;
  return before % 2 === 1;
}

export type ExtractResult = { sourceId: string; proposed: number; kept: number; droppedUnverified: number; cached: boolean };
type SrcInfo = { id: string; participant_id: string; origin: string; quality: string | null; submitted_by: string };
type U = Utt & { sid: string };

/** The text of a source, in the same order it is read. */
export const sourceChars = (db: Db, sourceId: string): number => Number((db.prepare("SELECT COALESCE(SUM(LENGTH(text)),0) n FROM utterances WHERE source_id=?").get(sourceId) as { n: number }).n);

export async function extractSource(db: Db, ai: AiProvider, sourceId: string): Promise<ExtractResult> {
  return (await extractSources(db, ai, [sourceId]))[0]!;
}

/** Read one or more sources. Short sources share a call, long ones are cut into large pieces. Every finding is checked against the exact line it claims to quote. */
export async function extractSources(db: Db, ai: AiProvider, sourceIds: string[]): Promise<ExtractResult[]> {
  const results = new Map<string, ExtractResult>(); const todo: SrcInfo[] = [];
  for (const sourceId of sourceIds) {
    const cached = db.prepare("SELECT proposed,kept,dropped_unverified d FROM extraction_runs WHERE source_id=? AND model=? AND prompt_version=?").get(sourceId, ai.model, PROMPT_VERSION) as { proposed: number; kept: number; d: number } | undefined;
    if (cached) { results.set(sourceId, { sourceId, proposed: cached.proposed, kept: cached.kept, droppedUnverified: cached.d, cached: true }); continue; }
    const src = db.prepare("SELECT id,participant_id,origin,quality,submitted_by FROM sources WHERE id=?").get(sourceId) as SrcInfo | undefined;
    if (!src) throw new Error(`Unknown source ${sourceId}`);
    todo.push(src);
  }
  const info = new Map(todo.map((x) => [x.id, x]));
  const utts: U[] = todo.flatMap((src) => (db.prepare("SELECT id,speaker,text FROM utterances WHERE source_id=? ORDER BY seq").all(src.id) as Utt[]).map((u) => ({ ...u, sid: src.id })));
  const byId = new Map(utts.map((u) => [u.id, u]));
  const tally = new Map(todo.map((x) => [x.id, { proposed: 0, kept: 0, dropped: 0 }]));
  const ins = db.prepare(`INSERT OR IGNORE INTO evidence(source_id,participant_id,utterance_id,original_text,translation,kind,provenance,theme,sentiment,pain_point,need,job_to_be_done,emotion,flags,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const promptFor = (chunk: U[]) => {
    let last = ""; const lines: string[] = [];
    for (const u of chunk) { if (u.sid !== last) { last = u.sid; lines.push(`--- Source ${u.sid} (origin: ${info.get(u.sid)!.origin}) ---`); } lines.push(`[${u.id}] ${u.speaker}: ${u.text}`); }
    return `Material:\n${lines.join("\n")}`;
  };
  // A piece that Gemini cannot answer in one go (the reply is cut off) is split in two and read again, rather than asked again unchanged.
  const readChunk = async (chunk: U[], depth = 0): Promise<void> => {
    let out: { findings: Finding[] };
    try { out = await ai.generateJson<{ findings: Finding[] }>({ system: SYSTEM, prompt: promptFor(chunk), schema: SCHEMA }); }
    catch (e) {
      if (e instanceof GeminiError && e.kind === "format" && depth < 3 && chunk.length > 1) { const mid = Math.ceil(chunk.length / 2); await readChunk(chunk.slice(0, mid), depth + 1); await readChunk(chunk.slice(mid), depth + 1); return; }
      throw e;
    }
    for (const f of out.findings ?? []) {
      const q = norm(f.quote ?? "");
      // Integrity check: the quote must be a verbatim substring of a line in this piece. Anything else is dropped.
      let utt = chunk.find((u) => u.id === f.utterance_id);
      if (!utt || !norm(utt.text).includes(q)) utt = chunk.find((u) => norm(u.text).includes(q));
      const t = tally.get(utt?.sid ?? byId.get(f.utterance_id)?.sid ?? chunk[0]!.sid)!;
      t.proposed++;
      if (!q || !utt) { t.dropped++; continue; }
      const src = info.get(utt.sid)!;
      const onScreen = utt.speaker === "screen"; // an AI description of the recording, never the participant's own words
      const provenance = onScreen ? "screen_observation" : src.origin === "researcher_notes" && !isQuotedVerbatim(utt.text, q) ? "researcher_note" : "participant_verbatim";
      const flags = [f.speaker_uncertain ? "speaker_uncertain" : "", onScreen ? "ai_observation" : "", src.quality ?? ""].filter(Boolean).join(",");
      // Research-team uploads are trusted (approved on extraction); contributor input waits in the review queue.
      const status = src.submitted_by === "research_team" ? "approved" : "pending";
      const r = ins.run(src.id, src.participant_id, utt.id, q, f.translation ?? null, onScreen ? "did" : f.kind, provenance, f.theme.toLowerCase(), f.sentiment, f.pain_point ?? null, f.need ?? null, f.job_to_be_done ?? null, f.emotion ?? null, flags, status, new Date().toISOString());
      t.kept += Number(r.changes);
    }
  };
  // Pack whole short sources together; a long source is cut into pieces at line boundaries.
  const chunks: U[][] = []; let cur: U[] = []; let size = 0;
  for (const src of todo) {
    const mine = utts.filter((u) => u.sid === src.id);
    const total = mine.reduce((n, u) => n + u.text.length, 0);
    if (total > MAX_CHUNK_CHARS || total > SMALL_SOURCE_CHARS) { if (cur.length) { chunks.push(cur); cur = []; size = 0; } for (const c of chunkUtterances(mine) as U[][]) chunks.push(c); continue; }
    if (size + total > MAX_CHUNK_CHARS && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(...mine); size += total;
  }
  if (cur.length) chunks.push(cur);
  for (const chunk of chunks) await readChunk(chunk);

  for (const src of todo) {
    const t = tally.get(src.id)!;
    db.prepare("INSERT INTO extraction_runs(source_id,model,prompt_version,proposed,kept,dropped_unverified,created_at) VALUES (?,?,?,?,?,?,?)").run(src.id, ai.model, PROMPT_VERSION, t.proposed, t.kept, t.dropped, new Date().toISOString());
    audit(db, "extract", { sourceId: src.id, model: ai.model, proposed: t.proposed, kept: t.kept, dropped: t.dropped });
    results.set(src.id, { sourceId: src.id, proposed: t.proposed, kept: t.kept, droppedUnverified: t.dropped, cached: false });
  }
  return sourceIds.map((id) => results.get(id)!);
}

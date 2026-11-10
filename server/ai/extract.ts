import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";

export const PROMPT_VERSION = "extract-v2";
const MAX_CHUNK_CHARS = 3500;

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
- Only extract what the PARTICIPANT or CUSTOMER said or reported doing. Ignore interviewer questions and instructions. Lines marked "note" are a researcher's summary of a call: extract the participant's reported statements and behaviours from them.
- kind="said" for stated opinions, reasons, beliefs, feelings. kind="did" for reported or observed behaviour (ordered, cancelled, returned, switched app, paid COD...).
- Give a short theme (2-4 words, English, lowercase), sentiment toward the product/platform/experience described, and where clearly supported: pain_point, need, job_to_be_done, emotion. Leave them out when not clearly supported.
- translation: a faithful English rendering of the quote (it is NOT verbatim).
- Placeholders like [NAME], [CITY], [PHONE] are redactions; keep them as is.
- Some transcripts are noisy machine transcriptions with unreliable speaker labels. If you cannot tell the participant from the interviewer, set speaker_uncertain=true.
- From researcher notes, ALSO extract concrete reported behaviours and outcomes (kept/returned/cancelled the order, payment mode and why, stopped ordering, switched or compared apps, did not complain and why, how they discover products). Use a contiguous sentence or phrase from the note as the quote, kind="did".
- Aim for roughly 3-8 findings per call note or per 3,000 characters of transcript, each about a different point. Skip filler, greetings and anything not about shopping or the platform.`;

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

export async function extractSource(db: Db, ai: AiProvider, sourceId: string): Promise<ExtractResult> {
  const cached = db.prepare("SELECT proposed,kept,dropped_unverified d FROM extraction_runs WHERE source_id=? AND model=? AND prompt_version=?").get(sourceId, ai.model, PROMPT_VERSION) as { proposed: number; kept: number; d: number } | undefined;
  if (cached) return { sourceId, proposed: cached.proposed, kept: cached.kept, droppedUnverified: cached.d, cached: true };

  const src = db.prepare("SELECT id,participant_id,origin,quality,submitted_by FROM sources WHERE id=?").get(sourceId) as { id: string; participant_id: string; origin: string; quality: string | null; submitted_by: string } | undefined;
  if (!src) throw new Error(`Unknown source ${sourceId}`);
  const utts = db.prepare("SELECT id,speaker,text FROM utterances WHERE source_id=? ORDER BY seq").all(sourceId) as Utt[];
  const byId = new Map(utts.map((u) => [u.id, u]));
  let proposed = 0, dropped = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO evidence(source_id,participant_id,utterance_id,original_text,translation,kind,provenance,theme,sentiment,pain_point,need,job_to_be_done,emotion,flags,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Research-team uploads are trusted (approved on extraction); contributor input waits in the review queue.
  const evStatus = src.submitted_by === "research_team" ? "approved" : "pending";
  let kept = 0;
  for (const chunk of chunkUtterances(utts)) {
    const prompt = chunk.map((u) => `[${u.id}] ${u.speaker}: ${u.text}`).join("\n");
    const out = await ai.generateJson<{ findings: Finding[] }>({ system: SYSTEM, prompt: `Material (origin: ${src.origin}):\n${prompt}`, schema: SCHEMA });
    for (const f of out.findings ?? []) {
      proposed++;
      const q = norm(f.quote ?? "");
      // Integrity check: quote must be a verbatim substring of an utterance in this chunk. Anything else is dropped.
      let utt = byId.get(f.utterance_id);
      if (!utt || !norm(utt.text).includes(q)) utt = chunk.find((u) => norm(u.text).includes(q));
      if (!q || !utt) { dropped++; continue; }
      const provenance = src.origin === "researcher_notes" && !isQuotedVerbatim(utt.text, q) ? "researcher_note" : "participant_verbatim";
      const flags = [f.speaker_uncertain ? "speaker_uncertain" : "", src.quality ?? ""].filter(Boolean).join(",");
      const r = ins.run(sourceId, src.participant_id, utt.id, q, f.translation ?? null, f.kind, provenance, f.theme.toLowerCase(), f.sentiment, f.pain_point ?? null, f.need ?? null, f.job_to_be_done ?? null, f.emotion ?? null, flags, evStatus, new Date().toISOString());
      kept += Number(r.changes);
    }
  }
  db.prepare("INSERT INTO extraction_runs(source_id,model,prompt_version,proposed,kept,dropped_unverified,created_at) VALUES (?,?,?,?,?,?,?)").run(sourceId, ai.model, PROMPT_VERSION, proposed, kept, dropped, new Date().toISOString());
  audit(db, "extract", { sourceId, model: ai.model, proposed, kept, dropped });
  return { sourceId, proposed, kept, droppedUnverified: dropped, cached: false };
}

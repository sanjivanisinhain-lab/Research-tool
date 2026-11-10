import type { Db } from "./db";
import type { AudienceRef } from "../src/types/research";
import type { AiProvider } from "./ai/provider";
import { overviewEvidence, participantsOfStudies, searchEvidence, type Hit, type ThemeLine } from "./search";

const SYS_INTENT = `You prepare a search over a user-research evidence store (Hindi, Hinglish and English; online shopping in India).
Return:
- keywords: 8-20 short search keywords/phrases: English terms AND likely Hinglish/Hindi (romanised) words users would say for the same ideas. No personal data.
- studies: if the question is about a particular body of research or group listed under "Studies available" (e.g. "Gen Z" for "Gen Z shopping interviews", "call notes" for CX calls), give that study's exact name(s); otherwise an empty list.
- audiences: if "Audiences available" is listed, the 1-2 audience names (exact) that the question is clearly about (e.g. a question about Gen Z -> the Gen Z group; about first-time buyers -> that group). Empty if the question is general or no audience clearly fits. Never invent names.
- broad: true if the question asks about general or typical behaviour, habits, preferences, or "what do we know about" a group (these share few words with specific evidence); false if it asks about one specific feature, concept or detail.`;
const SCHEMA_INTENT = { type: "OBJECT", properties: { keywords: { type: "ARRAY", items: { type: "STRING" } }, studies: { type: "ARRAY", items: { type: "STRING" } }, audiences: { type: "ARRAY", items: { type: "STRING" } }, broad: { type: "BOOLEAN" } }, required: ["keywords"] };

export type Scope = { terms: string[]; studyIds: string[]; broad: boolean; audience?: AudienceRef[] };

/** Work out what to look for: search words, which study the question is about, and whether it is a broad question. */
export async function searchScope(db: Db, ai: AiProvider, question: string, extra = "", pickAudience = false): Promise<Scope> {
  const options = pickAudience ? availableAudiences(db) : [];
  const studies = db.prepare("SELECT id, name FROM studies ORDER BY name").all() as { id: string; name: string }[];
  const intent = await ai.generateJson<{ keywords: string[]; studies?: string[]; audiences?: string[]; broad?: boolean }>({ system: SYS_INTENT, schema: SCHEMA_INTENT,
    prompt: `Studies available: ${studies.map((s) => s.name).join("; ") || "(none)"}\n${options.length ? `Audiences available: ${options.map((o) => o.ref.name).join("; ")}\n` : ""}${extra}Question: ${question}` });
  const named = new Set((intent.audiences ?? []).map((n) => n.trim().toLowerCase()));
  const audience = options.filter((o) => named.has(o.ref.name.toLowerCase()) && o.size >= MIN_AUTO).slice(0, 2).map((o) => o.ref);
  const wanted = new Set((intent.studies ?? []).map((n) => n.trim().toLowerCase()));
  return { terms: [question, ...(intent.keywords ?? [])], studyIds: studies.filter((s) => wanted.has(s.name.toLowerCase())).map((s) => s.id), broad: !!intent.broad, ...(pickAudience ? { audience } : {}) };
}

const MIN_AUTO = 5; // never auto-pick a group of fewer than 5 participants
/** Segments and personas from the latest synthesis, with their size. */
function availableAudiences(db: Db): { ref: AudienceRef; size: number }[] {
  const run = db.prepare("SELECT id FROM synthesis_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (!run) return [];
  const seg = db.prepare("SELECT s.id, s.name, (SELECT COUNT(*) FROM segment_participants WHERE segment_id=s.id) n FROM segments s WHERE s.run_id=?").all(run.id) as { id: string; name: string; n: number }[];
  const per = db.prepare("SELECT p.id, p.name, (SELECT COUNT(*) FROM persona_participants WHERE persona_id=p.id) n FROM personas p WHERE p.run_id=?").all(run.id) as { id: string; name: string; n: number }[];
  return [...seg.map((r) => ({ ref: { kind: "segment", id: r.id, name: r.name, participants: r.n } as AudienceRef, size: r.n })), ...per.map((r) => ({ ref: { kind: "persona", id: r.id, name: r.name, participants: r.n } as AudienceRef, size: r.n }))];
}

export type Gathered = { hits: Hit[]; themes: ThemeLine[]; usedOverview: boolean };
const ENOUGH = 8; // distinct participants a keyword search should reach before we stop looking

/** Keyword evidence first. For broad questions that found little, add a theme-balanced overview of the audience's research. */
export function gatherEvidence(db: Db, o: { scope: Scope; participants: string[] | null; statuses: string[]; limit?: number }): Gathered {
  let members = o.participants;
  if (!members && o.scope.studyIds.length) members = participantsOfStudies(db, o.scope.studyIds); // "Gen Z ..." with no audience chosen: look in the Gen Z research
  const keyword = searchEvidence(db, { terms: o.scope.terms, participants: members, statuses: o.statuses, limit: o.limit ?? 40 });
  const reached = new Set(keyword.map((h) => h.participantId)).size;
  if (!(o.scope.broad || o.scope.studyIds.length) || reached >= ENOUGH) return { hits: keyword, themes: [], usedOverview: false };
  const ov = overviewEvidence(db, { participants: members, statuses: o.statuses, preferStudyIds: o.scope.studyIds });
  const have = new Set(keyword.map((h) => h.id));
  return { hits: [...keyword, ...ov.hits.filter((h) => !have.has(h.id))], themes: ov.themes, usedOverview: ov.hits.length > 0 };
}

/** Numbered evidence lines for a prompt; overview samples are marked so the model treats them as general context. */
export const evidenceLines = (hits: Hit[], withKind = true) => hits.map((h) => `#${h.id} (${h.participantId}${withKind ? `, ${h.kind}` : ""}${h.provenance === "researcher_note" ? ", researcher note" : ""})${h.overview ? " [overview]" : ""} ${h.translation ?? h.quote}`).join("\n");
export const overviewNote = (g: Gathered) => g.usedOverview ? `\nOverview of this audience's research, themes by number of participants (computed, not opinion): ${g.themes.map((t) => `${t.theme} (${t.participants})`).join("; ")}\nItems marked [overview] are a general sample of that research, not matched to the question. For broad questions, summarise the recurring themes they show and cite them; do not over-claim from a handful.\n` : "";

/** Evidence numbers belong in the citations, not in the sentence. Removes things like "[468, 505]" or "(#12)" if a model writes them anyway. */
export const stripEvidenceMarkers = (text: string) =>
  text.replace(/\s*[\[(]\s*#?\d+(?:\s*[,;]\s*#?\d+)*\s*[\])]/g, "").replace(/\s+#\d+\b/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();

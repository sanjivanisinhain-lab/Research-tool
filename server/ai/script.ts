import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { audienceParticipants, emptyImps } from "./shared";
import { confidenceLabel } from "../../src/config/confidence";
import { searchEvidence } from "../search";
import type { Answer, AudienceRef, ScriptQuestion } from "../../src/types/research";

const SYS = `You are a senior UX research methodologist reviewing an interview or usability-test script before it is used with participants.
For EACH question in the script (up to 30), return:
- original: the question copied EXACTLY, character for character, from the script.
- status: "good" (neutral, open, one idea), "improve" (workable but weak), or "leading" (suggests or presumes an answer).
- issue (only when status is not good): one of "Leading", "Double-barrelled", "Hypothetical", "Vague".
- note: one short sentence (under 25 words) on why.
- rewrite (only when status is not good): a neutral, open, single-idea rewrite, in the same language/register as the original (Hindi/Hinglish stays Hinglish).
- topic: 4-8 search keywords for what the question is about (English and likely Hinglish words), used to look up existing evidence.
Rules: judge wording and method only; never claim anything about what users think. Do not invent questions that are not in the script. If the text contains no research questions, return an empty list.
Use the audience's own phrases (given) only to choose simple, familiar wording for rewrites; do not assume facts about them.`;
const SCHEMA = { type: "OBJECT", properties: { questions: { type: "ARRAY", items: { type: "OBJECT", properties: {
  original: { type: "STRING" }, status: { type: "STRING", enum: ["good", "improve", "leading"] }, issue: { type: "STRING", enum: ["Leading", "Double-barrelled", "Hypothetical", "Vague"] },
  note: { type: "STRING" }, rewrite: { type: "STRING" }, topic: { type: "ARRAY", items: { type: "STRING" } } }, required: ["original", "status", "topic"] } } }, required: ["questions"] };

type Raw = { questions: { original: string; status: "good" | "improve" | "leading"; issue?: ScriptQuestion["issue"]; note?: string; rewrite?: string; topic: string[] }[] };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const STRONG = 10, THIN = 4; // distinct participants
// Words that appear in nearly every piece of shopping research and so say nothing about whether a topic is covered.
const GENERIC = new Set(["snapdeal", "amazon", "flipkart", "meesho", "myntra", "app", "apps", "online", "order", "orders", "product", "products", "shopping", "shop", "buy", "user", "users", "customer", "like", "feel", "think", "usually", "time", "does", "what", "when", "how", "why"]);
const words = (t: string[]) => [...new Set(t.flatMap((x) => x.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)).filter((w) => w.length >= 3))];
/** An evidence item counts as covering a question only if it mentions enough of the question's specific topic words. */
export function coversTopic(text: string, topic: string[]): boolean {
  const specific = words(topic).filter((w) => !GENERIC.has(w));
  if (!specific.length) return false;
  const need = Math.min(2, specific.length), t = text.toLowerCase();
  return specific.filter((w) => t.includes(w)).length >= need;
}
const stripNumbering = (q: string) => q.replace(/^\s*(?:\d+[.)]|[-*\u2022])\s*/, "");

export type ScriptOpts = { question: string; script: string; audience: AudienceRef[]; includeUnreviewed?: boolean };

/** Review a script's wording with the AI, then check each question against what the audience research already covers (computed, not AI). */
export async function reviewScript(db: Db, ai: AiProvider, o: ScriptOpts): Promise<Answer | null> {
  const statuses = o.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = audienceParticipants(db, o.audience);
  const phrases = (db.prepare(`SELECT e.original_text q FROM evidence e WHERE e.provenance='participant_verbatim' AND e.status IN (${statuses.map(() => "?").join(",")}) ORDER BY e.id LIMIT 400`).all(...statuses) as { q: string }[])
    .map((r) => r.q).filter((q, i) => i % 8 === 0).slice(0, 12).filter((q) => q.length < 140);
  const raw = await ai.generateJson<Raw>({ system: SYS, schema: SCHEMA,
    prompt: `Audience: ${o.audience.map((a) => a.name).join(" + ") || "All users"}\nPhrases this audience has used (for wording only):\n${phrases.map((p) => `- ${p}`).join("\n") || "(none)"}\n\nScript:\n${o.script.slice(0, 30000)}` });

  const scriptNorm = norm(o.script);
  const questions: ScriptQuestion[] = []; let n = 0;
  const cover: { id: string; participants: number; people: Set<string>; evidenceIds: number[] }[] = [];
  for (const q of raw.questions ?? []) {
    const rawOriginal = norm(q.original ?? "");
    if (!rawOriginal || !scriptNorm.includes(rawOriginal)) continue; // must really be in the script
    const original = stripNumbering(rawOriginal);
    const id = `q${++n}`;
    const bad = q.status !== "good";
    questions.push({ id, original, status: q.status, ...(bad && q.issue ? { issue: q.issue } : {}), ...(q.note ? { note: q.note } : {}), ...(bad && q.rewrite ? { rewrite: q.rewrite } : {}) });
    const hits = searchEvidence(db, { terms: q.topic ?? [], participants: members, statuses, limit: 80 })
      .filter((h) => coversTopic(`${h.translation ?? ""} ${h.quote} ${h.theme}`, q.topic ?? []));
    cover.push({ id, participants: new Set(hits.map((h) => h.participantId)).size, people: new Set(hits.map((h) => h.participantId)), evidenceIds: hits.slice(0, 4).map((h) => h.id) });
  }
  if (!questions.length) return null;

  const counts = { good: 0, improve: 0, leading: 0 };
  for (const q of questions) counts[q.status]++;
  const total = questions.length, weak = counts.improve + counts.leading;
  const readiness = counts.leading >= 2 || weak / total > 0.5 ? "Needs revision before use" : weak > 0 ? "Good, with changes recommended" : "Ready to use";

  const num = (ids: string[]) => ids.map((i) => i.slice(1)).join(", ");
  const strong = cover.filter((c) => c.participants >= STRONG), thin = cover.filter((c) => c.participants < THIN);
  const allEvidence = [...new Set(strong.flatMap((c) => c.evidenceIds))].slice(0, 6);
  const overlap = !cover.some((c) => c.participants > 0)
    ? { title: "No existing evidence on these topics", body: `We found no research for ${o.audience.map((a) => a.name).join(" + ") || "this audience"} on the topics in this script, so every question is new ground.`, evidenceIds: [] as string[] }
    : strong.length
      ? { title: "You may be asking something we already know",
          body: `Question${strong.length === 1 ? "" : "s"} ${num(strong.map((c) => c.id))} cover${strong.length === 1 ? "s" : ""} topics where we already have strong evidence (${Math.min(...strong.map((c) => c.participants))} to ${Math.max(...strong.map((c) => c.participants))} participants).` +
            (thin.length ? ` Evidence is thin for question${thin.length === 1 ? "" : "s"} ${num(thin.map((c) => c.id))}: consider giving that more session time.` : " Consider spending the session on gaps instead."),
          evidenceIds: allEvidence.map(String) }
      : { title: "Existing evidence is limited", body: `No question here reaches ${STRONG} participants of existing evidence for this audience; the most covered has ${Math.max(...cover.map((c) => c.participants))}. The script is mostly new ground.`, evidenceIds: [] as string[] };

  const covered = new Set(cover.flatMap((c) => [...c.people])).size; // distinct participants the overlap check rests on
  const sample = Math.round(100 * (1 - Math.exp(-covered / 10)));
  const id = "ans-" + crypto.randomBytes(5).toString("hex");
  const result: Answer = {
    id, question: o.question, audience: o.audience, variant: "script_review",
    headline: `${total} question${total === 1 ? "" : "s"} reviewed: ${counts.leading} leading, ${counts.improve} to improve`,
    summary: `${readiness}. Wording and method are judged against research good practice, not against evidence about your users. The overlap check below uses your research repository.`,
    // Confidence here = how much existing evidence the overlap check rests on (sample strength only); the wording review is methodological.
    confidence: { score: sample, label: confidenceLabel(sample), participants: covered, factors: { sample, agreement: 0, recency: 0, contradictions: 0 }, methodStatus: "computed_v1" },
    sources: 0, patterns: [], unknowns: [], implications: emptyImps(),
    scriptReview: { readiness, counts, questions, overlap },
    evidenceStatus: o.includeUnreviewed ? "includes_unreviewed" : "approved_only", savedAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,includes_unreviewed,answer_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, o.question, "script_review", JSON.stringify(o.audience), o.includeUnreviewed ? 1 : 0, JSON.stringify(result), result.savedAt);
  audit(db, "script_review", { id, questions: total, counts });
  return result;
}

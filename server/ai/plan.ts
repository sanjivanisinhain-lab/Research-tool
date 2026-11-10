import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { audienceParticipants, emptyImps, ROLES } from "./shared";
import { coversTopic } from "./script";
import { confidenceLabel } from "../../src/config/confidence";
import { searchEvidence, type Hit } from "../search";
import { evidenceLines, gatherEvidence, overviewNote, type Scope } from "../retrieve";
import type { Answer, AudienceRef, Implications, KnownItem, StudyPlan } from "../../src/types/research";

/** Does this question ask for a test/study plan rather than for what users think? */
export function wantsStudyPlan(question: string): boolean {
  return /\b(how (should|can|do|would) (i|we) (test|validate|research|study)|(plan|design|build|create|suggest|recommend|draft) (a|an|the|my|our)?\s*(usability )?(test|study|research plan|test plan|experiment)|what should (i|we) (test|research|study|validate) next|test plan|research plan|next (test|study))\b/i.test(question);
}

const METHODS = ["Moderated usability test", "Unmoderated usability test", "In-depth interviews", "Diary study", "A/B test", "Survey", "Contextual inquiry"] as const;
const SAMPLE: Record<(typeof METHODS)[number], string> = {
  "Moderated usability test": "5 to 8 participants", "Unmoderated usability test": "10 to 15 participants", "In-depth interviews": "6 to 10 participants",
  "Diary study": "8 to 12 participants over 1 to 2 weeks", "A/B test": "enough traffic for the metric (size it with a power calculation)", Survey: "100 or more respondents", "Contextual inquiry": "4 to 6 participants",
};

const SYS = `You help a product team plan the NEXT piece of user research. You have the question or concept, the audience, and the existing research evidence (numbered). Plan a study that fills the gaps, and do not re-research what the evidence already settles.
Return:
- method: exactly one of ${METHODS.join(" | ")}. Choose by what is unknown AND how mature the evidence is: when existing relevant evidence is thin (fewer than about 8 participants) or the concept is new, start qualitative (moderated usability test, interviews or contextual inquiry) to learn WHY before measuring HOW MUCH; use an A/B test or survey only when a built variant or a clear measurable hypothesis exists and a qualitative base is already there. Explain in method_reason (1-2 sentences), mentioning how much evidence exists.
- objective: one sentence on what the study must learn.
- task: the concrete task participants will do (for interviews, the scenario to explore).
- watch_for: 2-4 behaviours or signals the moderator should watch for, in one short paragraph.
- questions: 6-10 neutral, open, single-idea questions (no leading, double-barrelled or hypothetical wording), in plain language suited to the audience.
- well_understood: findings the existing evidence already supports, each with title, body (one sentence) and evidence_ids from the list ONLY. Omit anything the evidence does not clearly support.
- needs_validation: 2-5 things the evidence does NOT settle and the study should test, each with title, body (one sentence) and topic (4-6 keywords, English and Hinglish, used to count existing evidence).
- implications: for each role, keep / change / watch (one short sentence).
Never state facts about users that the evidence does not show. If there is no evidence, say everything needs validation.`;
const imp = { type: "OBJECT", properties: { keep: { type: "STRING" }, change: { type: "STRING" }, watch: { type: "STRING" } }, required: ["keep", "change", "watch"] };
const SCHEMA = { type: "OBJECT", properties: {
  method: { type: "STRING", enum: [...METHODS] }, method_reason: { type: "STRING" }, objective: { type: "STRING" }, task: { type: "STRING" }, watch_for: { type: "STRING" },
  questions: { type: "ARRAY", items: { type: "STRING" } },
  well_understood: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, body: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["title", "body", "evidence_ids"] } },
  needs_validation: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, body: { type: "STRING" }, topic: { type: "ARRAY", items: { type: "STRING" } } }, required: ["title", "body", "topic"] } },
  implications: { type: "OBJECT", properties: Object.fromEntries(ROLES.map((r) => [r, imp])), required: ROLES },
}, required: ["method", "method_reason", "objective", "task", "watch_for", "questions", "well_understood", "needs_validation", "implications"] };

type Raw = { method: (typeof METHODS)[number]; method_reason: string; objective: string; task: string; watch_for: string; questions: string[];
  well_understood: { title: string; body: string; evidence_ids: number[] }[]; needs_validation: { title: string; body: string; topic: string[] }[]; implications: Implications };

export type PlanOpts = { question: string; audience: AudienceRef[]; includeUnreviewed?: boolean; context?: Answer | null; scope: Scope };
const plural = (n: number) => `${n} participant${n === 1 ? "" : "s"}`;

export async function planStudy(db: Db, ai: AiProvider, o: PlanOpts): Promise<Answer> {
  const statuses = o.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = audienceParticipants(db, o.audience);
  const subject = o.context ? o.context.question : o.question;
  const gathered = gatherEvidence(db, { scope: { ...o.scope, terms: [subject, ...o.scope.terms] }, participants: members, statuses, limit: 40 });
  const hits = gathered.hits;
  const byId = new Map<number, Hit>(hits.map((h) => [h.id, h]));
  const audienceName = o.audience.map((a) => a.name).join(" + ") || "All users";
  const ctx = o.context ? `\nEarlier question: ${o.context.question}\nEarlier finding: ${o.context.headline}. ${o.context.summary}\nKnown gaps already noted: ${o.context.unknowns.map((u) => u.title).join("; ") || "none"}` : "";
  const raw = await ai.generateJson<Raw>({ system: SYS, schema: SCHEMA,
    prompt: `What the team wants to learn: ${subject}\nAudience: ${audienceName}${ctx}\nStrength of existing evidence: ${new Set(hits.map((h) => h.participantId)).size} participant${new Set(hits.map((h) => h.participantId)).size === 1 ? "" : "s"} with anything possibly relevant (matching is loose, so the truly relevant number is lower).\n${overviewNote(gathered)}\nExisting evidence (${hits.length} items):\n` + (evidenceLines(hits) || "(none)") });

  // Integrity: "well understood" must cite real retrieved evidence from enough different people; otherwise it needs validation instead.
  const known: KnownItem[] = []; const needs: { title: string; body: string }[] = [];
  const covered = new Set<string>();
  for (const w of raw.well_understood ?? []) {
    const ids = [...new Set(w.evidence_ids ?? [])].filter((i) => byId.has(i));
    const people = new Set(ids.map((i) => byId.get(i)!.participantId));
    if (people.size >= 3) { known.push({ title: w.title, body: `${w.body} (${plural(people.size)})`, label: "evidence", evidenceIds: ids.map(String) }); people.forEach((p) => covered.add(p)); }
    else needs.push({ title: w.title, body: `${w.body} The existing evidence is too thin to rely on (${plural(people.size)}).` });
  }
  for (const n of raw.needs_validation ?? []) {
    // existing evidence on this unknown is counted in code, so "evidence strength" is never a model opinion
    const count = new Set(searchEvidence(db, { terms: n.topic ?? [], participants: members, statuses, limit: 80 }).filter((h) => coversTopic(`${h.translation ?? ""} ${h.quote} ${h.theme}`, n.topic ?? [])).map((h) => h.participantId)).size;
    needs.push({ title: n.title, body: `${n.body} Existing evidence: ${count === 0 ? "none found" : plural(count)}.` });
  }
  const method = METHODS.includes(raw.method) ? raw.method : "Moderated usability test";
  const questions = (raw.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 12);
  const sample = Math.round(100 * (1 - Math.exp(-covered.size / 10)));
  const id = "ans-" + crypto.randomBytes(5).toString("hex");
  const studyPlan: StudyPlan = { method, rationale: raw.method_reason, objective: raw.objective, audience: `${audienceName}. Suggested sample: ${SAMPLE[method]}`, task: raw.task, watchFor: raw.watch_for, questions };
  const result: Answer = {
    id, question: o.question, audience: o.audience, variant: "study_plan", headline: `Recommended next test: ${method}`, summary: raw.method_reason,
    // Confidence = how much existing evidence the plan's "already understood" part rests on (sample strength only).
    confidence: { score: sample, label: confidenceLabel(sample), participants: covered.size, factors: { sample, agreement: 0, recency: 0, contradictions: 0 }, methodStatus: "computed_v1" },
    sources: new Set(known.flatMap((k) => (k.evidenceIds ?? []).map((i) => byId.get(Number(i))!.sourceId))).size, patterns: [], known, unknowns: needs,
    studyPlan, implications: { ...emptyImps(), ...raw.implications }, evidenceStatus: o.includeUnreviewed ? "includes_unreviewed" : "approved_only", savedAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,includes_unreviewed,answer_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, o.question, "study_plan", JSON.stringify(o.audience), o.includeUnreviewed ? 1 : 0, JSON.stringify(result), result.savedAt);
  audit(db, "study_plan", { id, method, known: known.length, needs: needs.length, questions: questions.length });
  return result;
}

import crypto from "node:crypto";
import type { Db } from "../db";
import { audit } from "../db";
import type { AiProvider } from "./provider";
import { computeConfidence, type Signal } from "../confidence";
import { searchEvidence, type Hit } from "../search";
import type { Answer, AudienceRef, ClaimLabel, Implications, Role } from "../../src/types/research";

const ROLES: Role[] = ["designer", "researcher", "pm", "marketing", "cx", "other"];

const SYS_INTENT = `You prepare a search over a user-research evidence store (Hindi, Hinglish and English; online shopping in India).
Return 8-20 short search keywords/phrases: English terms AND likely Hinglish/Hindi (romanised) words users would say for the same ideas. No personal data.`;
const SCHEMA_INTENT = { type: "OBJECT", properties: { keywords: { type: "ARRAY", items: { type: "STRING" } } }, required: ["keywords"] };

const SYS_ANSWER = `You answer a product team's question about a user audience using ONLY the numbered evidence below. Never use outside knowledge or guess about users.
- Cite evidence by its number. Every claim labelled "evidence" must cite at least one number; if you infer something beyond the evidence, label it "inference"; if the evidence is silent on something relevant, say so under unknowns and use label "no_evidence".
- "signals": for each evidence item RELEVANT to the question, say whether the participant's evidence points toward a positive, negative or neutral reaction to the thing being asked about. Omit irrelevant items.
- patterns: 2-5 reasons/themes. signal: strong (consistent support), mixed, or risk (a threat or barrier).
- conflict: evidence that contradicts the main conclusion, if any (cite numbers), else null.
- unknowns: what the evidence cannot tell us.
- implications: for each role, keep / change / watch (one short sentence each; designer, researcher, pm, marketing, cx, other).
- headline: a direct answer in under 12 words. It MUST agree with your own signals: if most relevant participants signal negative, the headline says the likely reaction is negative (and vice versa); only say "mixed" if the signals are genuinely split. summary: 1-3 sentences, also consistent with the signals. Quote nothing yourself; quotes are shown separately.
- Be tentative when the evidence is thin.`;

const imp = { type: "OBJECT", properties: { keep: { type: "STRING" }, change: { type: "STRING" }, watch: { type: "STRING" } }, required: ["keep", "change", "watch"] };
const SCHEMA_ANSWER = { type: "OBJECT", properties: {
  headline: { type: "STRING" }, summary: { type: "STRING" },
  signals: { type: "ARRAY", items: { type: "OBJECT", properties: { evidence_id: { type: "INTEGER" }, signal: { type: "STRING", enum: ["positive", "negative", "neutral"] } }, required: ["evidence_id", "signal"] } },
  patterns: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, signal: { type: "STRING", enum: ["strong", "mixed", "risk"] }, label: { type: "STRING", enum: ["evidence", "inference", "no_evidence"] }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["title", "summary", "signal", "label", "evidence_ids"] } },
  conflict: { type: "OBJECT", nullable: true, properties: { title: { type: "STRING" }, body: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } } },
  unknowns: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, body: { type: "STRING" } }, required: ["title", "body"] } },
  implications: { type: "OBJECT", properties: Object.fromEntries(ROLES.map((r) => [r, imp])), required: ROLES },
}, required: ["headline", "summary", "signals", "patterns", "unknowns", "implications"] };

const SYS_REWRITE = `Rewrite the draft headline and summary so they agree with the computed finding. The headline (under 12 words) states the likely direction plainly. Keep the nuance (the minority view, conditions) in the summary. Add no new facts, numbers or claims beyond the draft.`;
const SCHEMA_REWRITE = { type: "OBJECT", properties: { headline: { type: "STRING" }, summary: { type: "STRING" } }, required: ["headline", "summary"] };

type Raw = {
  headline: string; summary: string; signals: { evidence_id: number; signal: Signal }[];
  patterns: { title: string; summary: string; signal: "strong" | "mixed" | "risk"; label: ClaimLabel; evidence_ids: number[] }[];
  conflict?: { title: string; body: string; evidence_ids: number[] } | null;
  unknowns: { title: string; body: string }[]; implications: Implications;
};

export function audienceParticipants(db: Db, audience: AudienceRef[]): string[] | null {
  if (!audience.length) return null; // everyone
  const out = new Set<string>();
  for (const a of audience) {
    const sql = a.kind === "persona" ? "SELECT participant_id p FROM persona_participants WHERE persona_id=?" : "SELECT participant_id p FROM segment_participants WHERE segment_id=?";
    for (const r of db.prepare(sql).all(a.id) as { p: string }[]) out.add(r.p);
  }
  return [...out]; // union of distinct participants, never summed
}

const emptyImps = (): Implications => Object.fromEntries(ROLES.map((r) => [r, { keep: "—", change: "—", watch: "—" }])) as Implications;

export type AskOpts = { question: string; audience: AudienceRef[]; includeUnreviewed?: boolean; now?: Date };

export async function answerQuestion(db: Db, ai: AiProvider, opts: AskOpts): Promise<Answer> {
  const statuses = opts.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = audienceParticipants(db, opts.audience);
  const id = "ans-" + crypto.randomBytes(5).toString("hex");
  const base = { id, question: opts.question, audience: opts.audience, savedAt: new Date().toISOString(), evidenceStatus: opts.includeUnreviewed ? "includes_unreviewed" as const : "approved_only" as const };

  const intent = await ai.generateJson<{ keywords: string[] }>({ system: SYS_INTENT, schema: SCHEMA_INTENT, prompt: `Question: ${opts.question}` });
  const hits = searchEvidence(db, { terms: [opts.question, ...(intent.keywords ?? [])], participants: members, statuses, limit: 40 });

  let result: Answer;
  if (!hits.length) {
    result = insufficient(base, computeConfidence([], opts.now), "We don't have research that speaks to this question for this audience.");
  } else {
    const byId = new Map(hits.map((h) => [h.id, h]));
    const raw = await ai.generateJson<Raw>({ system: SYS_ANSWER, schema: SCHEMA_ANSWER,
      prompt: `Question: ${opts.question}\nAudience: ${opts.audience.map((a) => a.name).join(" + ") || "All users"}\n\nEvidence:\n` +
        hits.map((h) => `#${h.id} (${h.participantId}, ${h.kind}${h.provenance === "researcher_note" ? ", researcher note" : ""}) ${h.translation ?? h.quote}`).join("\n") });
    // Integrity: only signals on retrieved evidence count; confidence is computed here, not by the model.
    const seen = new Set<number>();
    const items = (raw.signals ?? []).filter((s) => byId.has(s.evidence_id) && !seen.has(s.evidence_id) && seen.add(s.evidence_id))
      .map((s) => ({ participantId: byId.get(s.evidence_id)!.participantId, signal: s.signal, date: byId.get(s.evidence_id)!.date }));
    const conf = computeConfidence(items, opts.now);
    const valid = (ids: number[] = []) => [...new Set(ids)].filter((i) => byId.has(i)).map(String);
    const patterns = (raw.patterns ?? []).map((p, i) => {
      const ev = valid(p.evidence_ids);
      const label: ClaimLabel = p.label === "evidence" && !ev.length ? "inference" : p.label; // uncited "evidence" is downgraded
      return { id: `p${i + 1}`, title: p.title, summary: p.summary, signal: p.signal, label, evidenceIds: ev };
    });
    const conflict = raw.conflict && valid(raw.conflict.evidence_ids).length ? { title: raw.conflict.title, body: raw.conflict.body, evidenceIds: valid(raw.conflict.evidence_ids) } : undefined;
    const cited = new Set([...patterns.flatMap((p) => p.evidenceIds), ...(conflict?.evidenceIds ?? [])].map(Number));
    const sources = new Set([...cited].map((i) => byId.get(i)!.sourceId)).size;
    // Consistency guard: the headline must not contradict the computed direction (e.g. "mixed" while 92% point one way).
    if (conf.direction && conf.direction.label !== "Mixed" && /\b(mixed|split|divided|varied|ambivalent)\b/i.test(raw.headline)) {
      const fix = await ai.generateJson<{ headline: string; summary: string }>({ system: SYS_REWRITE, schema: SCHEMA_REWRITE,
        prompt: `Computed finding: ${conf.direction.pct}% of ${conf.participants} relevant participants point toward a ${conf.direction.label.toLowerCase()} reaction.\nQuestion: ${opts.question}\nDraft headline: ${raw.headline}\nDraft summary: ${raw.summary}` });
      if (fix.headline && fix.summary) { raw.headline = fix.headline; raw.summary = fix.summary; }
    }
    const main = conf.direction?.label === "Negative" ? "negative" : "positive";
    const evidenceStances: Record<string, "supports" | "contradicts"> = {};
    for (const s of raw.signals ?? []) if (byId.has(s.evidence_id)) evidenceStances[String(s.evidence_id)] = s.signal === "neutral" || s.signal === main ? "supports" : "contradicts";
    const confidence = { score: conf.score, label: conf.label, participants: conf.participants, factors: conf.factors, methodStatus: conf.methodStatus };
    const implications = { ...emptyImps(), ...raw.implications };
    if (conf.withheld) {
      result = { ...insufficient(base, confidence, "The evidence we have is too thin to predict a reaction."), known: patterns.map((p) => ({ title: p.title, body: p.summary, label: p.label, evidenceIds: p.evidenceIds })), unknowns: raw.unknowns ?? [], sources, implications };
    } else {
      result = { ...base, variant: "standard", headline: raw.headline, summary: raw.summary, direction: conf.direction, confidence, sources, patterns, conflict, evidenceStances, unknowns: raw.unknowns ?? [], implications };
    }
  }
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,includes_unreviewed,answer_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, opts.question, result.variant, JSON.stringify(opts.audience), opts.includeUnreviewed ? 1 : 0, JSON.stringify(result), result.savedAt);
  audit(db, "answer", { id, variant: result.variant, participants: result.confidence.participants, score: result.confidence.score });
  return result;
}

function insufficient(base: Pick<Answer, "id" | "question" | "audience" | "savedAt" | "evidenceStatus">, confidence: Answer["confidence"] | ReturnType<typeof computeConfidence>, why: string): Answer {
  const c = confidence as Answer["confidence"];
  return { ...base, variant: "insufficient", headline: "Insufficient evidence", summary: why + " Don't make a decision from a prediction here; this needs direct validation.",
    confidence: { score: c.score, label: c.label, participants: c.participants, factors: c.factors, methodStatus: "computed_v1" }, sources: 0, patterns: [], unknowns: [{ title: "No reliable evidence", body: why }], implications: emptyImps() };
}

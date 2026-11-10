import crypto from "node:crypto";
import type { Db } from "../db";
import { audit } from "../db";
import type { AiProvider } from "./provider";
import { computeConfidence, type Signal } from "../confidence";
import { audienceParticipants, emptyImps, ROLES } from "./shared";
import { attachmentsText, looksLikeScript } from "../attachments";
import { reviewScript } from "./script";
import { planStudy, wantsStudyPlan } from "./plan";
import { ftsQuery, searchEvidence, type Hit } from "../search";
import type { Answer, Attachment, AudienceRef, ClaimLabel, ComparisonColumn, FollowUp, Implications, Pattern, Role } from "../../src/types/research";


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



export type AskOpts = { question: string; audience: AudienceRef[]; includeUnreviewed?: boolean; now?: Date; attachments?: Attachment[]; contextAnswerId?: string };

type Assessed = {
  raw: Raw; conf: ReturnType<typeof computeConfidence>; confidence: Answer["confidence"];
  patterns: Pattern[]; conflict?: { title: string; body: string; evidenceIds: string[] };
  evidenceStances: Record<string, "supports" | "contradicts">; sources: number; implications: Implications; empty: boolean;
};

const statusesOf = (o: { includeUnreviewed?: boolean }) => (o.includeUnreviewed ? ["approved", "pending"] : ["approved"]);
const toConfidence = (c: ReturnType<typeof computeConfidence>): Answer["confidence"] => ({ score: c.score, label: c.label, participants: c.participants, factors: c.factors, methodStatus: c.methodStatus });

async function searchTerms(ai: AiProvider, question: string): Promise<string[]> {
  const intent = await ai.generateJson<{ keywords: string[] }>({ system: SYS_INTENT, schema: SCHEMA_INTENT, prompt: `Question: ${question}` });
  return [question, ...(intent.keywords ?? [])];
}

/** Retrieve evidence for one audience, have the AI cite and label it, then compute confidence in code and verify every citation. */
async function assessAudience(db: Db, ai: AiProvider, o: { question: string; terms: string[]; audience: AudienceRef[]; includeUnreviewed?: boolean; now?: Date }): Promise<Assessed> {
  const hits = searchEvidence(db, { terms: o.terms, participants: audienceParticipants(db, o.audience), statuses: statusesOf(o), limit: 40 });
  if (!hits.length) {
    const conf = computeConfidence([], o.now);
    return { raw: { headline: "", summary: "", signals: [], patterns: [], unknowns: [], implications: emptyImps() }, conf, confidence: toConfidence(conf), patterns: [], evidenceStances: {}, sources: 0, implications: emptyImps(), empty: true };
  }
  const byId = new Map(hits.map((h) => [h.id, h]));
  const raw = await ai.generateJson<Raw>({ system: SYS_ANSWER, schema: SCHEMA_ANSWER,
    prompt: `Question: ${o.question}\nAudience: ${o.audience.map((a) => a.name).join(" + ") || "All users"}\n\nEvidence:\n` +
      hits.map((h) => `#${h.id} (${h.participantId}, ${h.kind}${h.provenance === "researcher_note" ? ", researcher note" : ""}) ${h.translation ?? h.quote}`).join("\n") });
  // Integrity: only signals on retrieved evidence count; confidence is computed here, not by the model.
  const seen = new Set<number>();
  const items = (raw.signals ?? []).filter((x) => byId.has(x.evidence_id) && !seen.has(x.evidence_id) && seen.add(x.evidence_id))
    .map((x) => ({ participantId: byId.get(x.evidence_id)!.participantId, signal: x.signal, date: byId.get(x.evidence_id)!.date }));
  const conf = computeConfidence(items, o.now);
  // Consistency guard: the headline must not contradict the computed direction (e.g. "mixed" while 92% point one way).
  if (conf.direction && conf.direction.label !== "Mixed" && /\b(mixed|split|divided|varied|ambivalent)\b/i.test(raw.headline)) {
    const fix = await ai.generateJson<{ headline: string; summary: string }>({ system: SYS_REWRITE, schema: SCHEMA_REWRITE,
      prompt: `Computed finding: ${conf.direction.pct}% of ${conf.participants} relevant participants point toward a ${conf.direction.label.toLowerCase()} reaction.\nQuestion: ${o.question}\nDraft headline: ${raw.headline}\nDraft summary: ${raw.summary}` });
    if (fix.headline && fix.summary) { raw.headline = fix.headline; raw.summary = fix.summary; }
  }
  const main = conf.direction?.label === "Negative" ? "negative" : "positive";
  const evidenceStances: Record<string, "supports" | "contradicts"> = {};
  for (const x of raw.signals ?? []) if (byId.has(x.evidence_id)) evidenceStances[String(x.evidence_id)] = x.signal === "neutral" || x.signal === main ? "supports" : "contradicts";
  const valid = (ids: number[] = []) => [...new Set(ids)].filter((i) => byId.has(i)).map(String);
  const patterns: Pattern[] = (raw.patterns ?? []).map((p, i) => {
    const ev = valid(p.evidence_ids);
    const label: ClaimLabel = p.label === "evidence" && !ev.length ? "inference" : p.label; // uncited "evidence" is downgraded
    return { id: `p${i + 1}`, title: p.title, summary: p.summary, signal: p.signal, label, evidenceIds: ev };
  });
  const conflict = raw.conflict && valid(raw.conflict.evidence_ids).length ? { title: raw.conflict.title, body: raw.conflict.body, evidenceIds: valid(raw.conflict.evidence_ids) } : undefined;
  const cited = new Set([...patterns.flatMap((p) => p.evidenceIds), ...(conflict?.evidenceIds ?? [])].map(Number));
  const sources = new Set([...cited].map((i) => byId.get(i)!.sourceId)).size;
  return { raw, conf, confidence: toConfidence(conf), patterns, conflict, evidenceStances, sources, implications: { ...emptyImps(), ...raw.implications }, empty: false };
}

function save(db: Db, result: Answer, includeUnreviewed?: boolean) {
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,includes_unreviewed,answer_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(result.id, result.question, result.variant, JSON.stringify(result.audience), includeUnreviewed ? 1 : 0, JSON.stringify(result), result.savedAt);
  audit(db, "answer", { id: result.id, variant: result.variant, participants: result.confidence.participants, score: result.confidence.score });
}

export async function answerQuestion(db: Db, ai: AiProvider, opts: AskOpts): Promise<Answer> {
  // A pasted/attached research script is reviewed, not answered as a question about users.
  const scriptText = await attachmentsText(opts.attachments);
  if (looksLikeScript(opts.question, scriptText)) {
    const review = await reviewScript(db, ai, { question: opts.question, script: scriptText || opts.question, audience: opts.audience, ...(opts.includeUnreviewed ? { includeUnreviewed: true } : {}) });
    if (review) return review;
  }
  // "How should I test this?" and similar: plan the next study from what we know and don't know.
  if (wantsStudyPlan(opts.question)) {
    const prev = opts.contextAnswerId ? (db.prepare("SELECT answer_json j FROM answers WHERE id=?").get(opts.contextAnswerId) as { j: string } | undefined) : undefined;
    const context = prev ? (JSON.parse(prev.j) as Answer) : null;
    const audience = opts.audience.length || !context ? opts.audience : context.audience;
    const terms = await searchTerms(ai, context ? context.question : opts.question);
    return planStudy(db, ai, { question: opts.question, audience, terms, context, ...(opts.includeUnreviewed ? { includeUnreviewed: true } : {}) });
  }
  const id = "ans-" + crypto.randomBytes(5).toString("hex");
  const base = { id, question: opts.question, audience: opts.audience, savedAt: new Date().toISOString(), evidenceStatus: opts.includeUnreviewed ? "includes_unreviewed" as const : "approved_only" as const };
  const terms = await searchTerms(ai, opts.question);
  const a = await assessAudience(db, ai, { question: opts.question, terms, audience: opts.audience, includeUnreviewed: opts.includeUnreviewed, now: opts.now });
  let result: Answer;
  if (a.empty) {
    result = insufficient(base, a.confidence, "We don't have research that speaks to this question for this audience.");
  } else if (a.conf.withheld) {
    result = { ...insufficient(base, a.confidence, "The evidence we have is too thin to predict a reaction."), known: a.patterns.map((p) => ({ title: p.title, body: p.summary, label: p.label, evidenceIds: p.evidenceIds })), unknowns: a.raw.unknowns ?? [], sources: a.sources, implications: a.implications, evidenceStances: a.evidenceStances };
  } else {
    result = { ...base, variant: "standard", headline: a.raw.headline, summary: a.raw.summary, direction: a.conf.direction, confidence: a.confidence, sources: a.sources, patterns: a.patterns, conflict: a.conflict, evidenceStances: a.evidenceStances, unknowns: a.raw.unknowns ?? [], implications: a.implications };
  }
  save(db, result, opts.includeUnreviewed);
  return result;
}

const SYS_COMPARE = `You compare how several user audiences are likely to react to the same question, using ONLY the per-audience findings given (each already cites real evidence). Add no new facts.
- dimensions: 3-5 shared aspects (e.g. price, trust, delivery) that matter for this question. For EACH audience give a signal (strong = favourable/consistent support, mixed, risk = barrier) and one short sentence drawn from that audience's findings. If an audience's findings say nothing about a dimension, use signal "mixed" and say there is no evidence on it.
- biggestDifference: the single most important way the audiences differ (1-2 sentences). designImplication: what this means for the work (1-2 sentences), flagged as a suggestion to validate.
- implications: for each role, keep / change / watch (one short sentence each).
Use the audience names exactly as given.`;
const SCHEMA_COMPARE = { type: "OBJECT", properties: {
  dimensions: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, per_audience: { type: "ARRAY", items: { type: "OBJECT", properties: { audience: { type: "STRING" }, signal: { type: "STRING", enum: ["strong", "mixed", "risk"] }, summary: { type: "STRING" } }, required: ["audience", "signal", "summary"] } } }, required: ["name", "per_audience"] } },
  biggestDifference: { type: "STRING" }, designImplication: { type: "STRING" },
  implications: { type: "OBJECT", properties: Object.fromEntries(ROLES.map((r) => [r, imp])), required: ROLES },
}, required: ["dimensions", "biggestDifference", "designImplication", "implications"] };
type CompareRaw = { dimensions: { name: string; per_audience: { audience: string; signal: "strong" | "mixed" | "risk"; summary: string }[] }[]; biggestDifference: string; designImplication: string; implications: Implications };

/** Compare 2-3 audiences on the same question. Each is assessed separately; weak-evidence audiences make the comparison inconclusive. */
export async function compareAudiences(db: Db, ai: AiProvider, opts: AskOpts): Promise<Answer> {
  const audiences = opts.audience.slice(0, 3);
  if (audiences.length < 2) throw new Error("Comparison needs at least two audiences");
  const id = "ans-" + crypto.randomBytes(5).toString("hex");
  const terms = await searchTerms(ai, opts.question);
  const assessed: Assessed[] = [];
  for (const aud of audiences) assessed.push(await assessAudience(db, ai, { question: opts.question, terms, audience: [aud], includeUnreviewed: opts.includeUnreviewed, now: opts.now }));

  const inconclusive = assessed.some((a) => a.empty || a.conf.withheld);
  const columns: ComparisonColumn[] = audiences.map((aud, i) => ({
    audience: aud, direction: inconclusive ? undefined : assessed[i].conf.direction, confidence: assessed[i].confidence,
    dimensions: assessed[i].patterns.slice(0, 4).map((p) => ({ name: p.title, signal: p.signal, summary: p.summary })),
  }));
  let biggestDifference = "", designImplication = "", implications: Implications = emptyImps();
  if (inconclusive) {
    biggestDifference = "Comparison inconclusive: at least one audience has too little evidence to compare reliably.";
    designImplication = "Gather more evidence for the weaker audience before deciding.";
  } else {
    const payload = audiences.map((aud, i) => `AUDIENCE: ${aud.name} (reaction ${assessed[i].conf.direction?.pct}% ${assessed[i].conf.direction?.label}, confidence ${assessed[i].confidence.score}, ${assessed[i].confidence.participants} participants)\n` +
      assessed[i].patterns.map((p) => `- [${p.signal}] ${p.title}: ${p.summary}`).join("\n")).join("\n\n");
    const raw = await ai.generateJson<CompareRaw>({ system: SYS_COMPARE, schema: SCHEMA_COMPARE, prompt: `Question: ${opts.question}\n\n${payload}` });
    const names = audiences.map((a) => a.name);
    columns.forEach((col, i) => {
      const dims = (raw.dimensions ?? []).map((d) => { const m = d.per_audience.find((x) => x.audience === names[i]); return m ? { name: d.name, signal: m.signal, summary: m.summary } : null; }).filter((d): d is NonNullable<typeof d> => !!d);
      if (dims.length) col.dimensions = dims;
    });
    biggestDifference = raw.biggestDifference; designImplication = raw.designImplication; implications = { ...emptyImps(), ...raw.implications };
  }
  const worst = assessed.reduce((a, b) => ((a.confidence.score ?? -1) <= (b.confidence.score ?? -1) ? a : b));
  const union = new Set(audienceParticipants(db, audiences) ?? []);
  const headline = inconclusive ? "Comparison inconclusive" : columns.map((c) => `${c.audience.name}: ${c.direction ? `${c.direction.pct}% ${c.direction.label.toLowerCase()}` : "no clear direction"}`).join(" vs ");
  const result: Answer = {
    id, question: opts.question, audience: audiences, variant: "comparison", headline, summary: biggestDifference,
    confidence: { ...worst.confidence, participants: union.size ? Math.min(union.size, assessed.reduce((n, a) => n + a.confidence.participants, 0)) : worst.confidence.participants },
    sources: assessed.reduce((n, a) => n + a.sources, 0), patterns: [], unknowns: [...new Map(assessed.flatMap((a) => a.raw.unknowns ?? []).map((u) => [u.title, u])).values()].slice(0, 4),
    implications, comparison: { columns, biggestDifference, designImplication },
    evidenceStances: Object.assign({}, ...assessed.map((a) => a.evidenceStances)), savedAt: new Date().toISOString(),
    evidenceStatus: opts.includeUnreviewed ? "includes_unreviewed" : "approved_only",
  };
  save(db, result, opts.includeUnreviewed);
  return result;
}

const SYS_FOLLOW = `You answer a follow-up question about a user audience using ONLY the numbered evidence below, in the context of the earlier answer. Never use outside knowledge.
- reply: 1-4 sentences. Cite nothing in prose; list the evidence numbers you relied on in evidence_ids.
- label: "evidence" if the reply rests directly on cited evidence; "inference" if it goes beyond what the evidence says (say so in the reply); "no_evidence" if the evidence does not address the question (then say what we don't know).
- If fewer than 5 participants support the reply, sound tentative.`;
const SCHEMA_FOLLOW = { type: "OBJECT", properties: { reply: { type: "STRING" }, label: { type: "STRING", enum: ["evidence", "inference", "no_evidence"] }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["reply", "label", "evidence_ids"] };

/** Answer a follow-up inside an existing answer's audience and evidence scope, and append it to that answer. */
export async function followUp(db: Db, ai: AiProvider, answerId: string, question: string, now = new Date()): Promise<FollowUp | null> {
  const row = db.prepare("SELECT answer_json j, includes_unreviewed u FROM answers WHERE id=?").get(answerId) as { j: string; u: number } | undefined;
  if (!row) return null;
  const answer = JSON.parse(row.j) as Answer;
  const terms = await searchTerms(ai, question);
  const scope = { participants: audienceParticipants(db, answer.audience), statuses: statusesOf({ includeUnreviewed: !!row.u }) };
  // Search on the follow-up's own terms first; use the earlier question's context only to pad a thin result
  // or when the follow-up itself has nothing searchable (e.g. "why?").
  let hits: Hit[];
  if (!ftsQuery(terms)) hits = searchEvidence(db, { ...scope, terms: [answer.question], limit: 25 });
  else {
    const own = searchEvidence(db, { ...scope, terms, limit: 25 });
    hits = own.length === 0 || own.length >= 3 ? own : [...own, ...searchEvidence(db, { ...scope, terms: [answer.question], limit: 25 }).filter((h) => !own.some((o) => o.id === h.id))].slice(0, 25);
  }
  let fu: FollowUp;
  const base = { id: "fu-" + crypto.randomBytes(4).toString("hex"), question, createdAt: now.toISOString() };
  if (!hits.length) {
    fu = { ...base, reply: "We don't have research that speaks to this for this audience. A direct study would be needed to answer it.", label: "no_evidence", evidenceIds: [] };
  } else {
    const byId = new Map(hits.map((h) => [h.id, h]));
    const out = await ai.generateJson<{ reply: string; label: ClaimLabel; evidence_ids: number[] }>({ system: SYS_FOLLOW, schema: SCHEMA_FOLLOW,
      prompt: `Earlier question: ${answer.question}\nEarlier answer: ${answer.headline}. ${answer.summary}\nFollow-up: ${question}\nAudience: ${answer.audience.map((a) => a.name).join(" + ") || "All users"}\n\nEvidence:\n` +
        hits.map((h) => `#${h.id} (${h.participantId}, ${h.kind}) ${h.translation ?? h.quote}`).join("\n") });
    const ids = [...new Set(out.evidence_ids ?? [])].filter((i) => byId.has(i)).map(String);
    const label: ClaimLabel = out.label === "evidence" && !ids.length ? "inference" : out.label; // uncited "evidence" is downgraded
    fu = { ...base, reply: out.reply, label, evidenceIds: ids };
  }
  answer.followUps = [...(answer.followUps ?? []), fu];
  db.prepare("UPDATE answers SET answer_json=? WHERE id=?").run(JSON.stringify(answer), answerId);
  audit(db, "followup", { answerId, label: fu.label, cited: fu.evidenceIds.length });
  return fu;
}

function insufficient(base: Pick<Answer, "id" | "question" | "audience" | "savedAt" | "evidenceStatus">, confidence: Answer["confidence"], why: string): Answer {
  return { ...base, variant: "insufficient", headline: "Insufficient evidence", summary: why + " Don't make a decision from a prediction here; this needs direct validation.",
    confidence: { ...confidence, methodStatus: "computed_v1" }, sources: 0, patterns: [], unknowns: [{ title: "No reliable evidence", body: why }], implications: emptyImps() };
}

export { audienceParticipants };

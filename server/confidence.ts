// Confidence v1 (approved by the product owner). Pure, deterministic, no AI.
// The AI only labels each piece of evidence; every number below is computed here from those labels.
import { confidenceLabel, shouldWithhold } from "../src/config/confidence";

export const CONFIDENCE_CONFIG = {
  version: "v1",
  weights: { sample: 0.35, agreement: 0.3, recency: 0.15, contradictions: 0.2 },
  sampleScale: 10,          // sample = 100 * (1 - exp(-n / sampleScale)): n=5 -> 39, n=10 -> 63, n=20 -> 86
  recencyHalfLifeDays: 180, // evidence loses half its weight every 180 days
  undatedWeight: 0.5,       // evidence with no date counts as half-fresh, never as fully fresh
  minParticipantsForDirection: 5,
} as const;

export type Signal = "positive" | "negative" | "neutral";
export type EvidenceInput = { participantId: string; signal: Signal; date: string | null };
export type ConfidenceResult = {
  score: number | null; label: ReturnType<typeof confidenceLabel>; participants: number;
  factors: { sample: number; agreement: number; recency: number; contradictions: number };
  direction?: { label: "Positive" | "Negative" | "Mixed"; pct: number };
  withheld: boolean; methodStatus: "computed_v1";
};

const round = (n: number) => Math.round(n);

export function computeConfidence(items: EvidenceInput[], now = new Date()): ConfidenceResult {
  const c = CONFIDENCE_CONFIG;
  const byP = new Map<string, EvidenceInput[]>();
  for (const e of items) byP.set(e.participantId, [...(byP.get(e.participantId) ?? []), e]);
  const n = byP.size; // distinct participants, never mentions

  // Participant stance = majority of their non-neutral evidence (ties = neutral).
  const stances = [...byP.values()].map((list) => {
    const pos = list.filter((e) => e.signal === "positive").length, neg = list.filter((e) => e.signal === "negative").length;
    return pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
  });
  const pos = stances.filter((s) => s === "positive").length, neg = stances.filter((s) => s === "negative").length;
  const directional = pos + neg;

  const sample = n === 0 ? 0 : 100 * (1 - Math.exp(-n / c.sampleScale));
  const agreement = directional === 0 ? 0 : (100 * Math.max(pos, neg)) / directional;
  const contradictions = directional === 0 ? 0 : 100 * (1 - Math.min(pos, neg) / directional);
  const weights = items.map((e) => {
    if (!e.date) return c.undatedWeight;
    const age = Math.max(0, (now.getTime() - new Date(e.date).getTime()) / 86_400_000);
    return Math.pow(0.5, age / c.recencyHalfLifeDays);
  });
  const recency = weights.length ? (100 * weights.reduce((a, b) => a + b, 0)) / weights.length : 0;

  const w = c.weights;
  const raw = w.sample * sample + w.agreement * agreement + w.recency * recency + w.contradictions * contradictions;
  const score = n === 0 || directional === 0 ? null : round(raw);
  const withheld = shouldWithhold(score) || n < c.minParticipantsForDirection;

  let direction: ConfidenceResult["direction"];
  if (!withheld && directional > 0) {
    const top = Math.max(pos, neg), share = round((100 * top) / directional);
    direction = share < 60 ? { label: "Mixed", pct: share } : { label: pos >= neg ? "Positive" : "Negative", pct: share };
  }
  return { score, label: confidenceLabel(score), participants: n, factors: { sample: round(sample), agreement: round(agreement), recency: round(recency), contradictions: round(contradictions) }, direction, withheld, methodStatus: "computed_v1" };
}

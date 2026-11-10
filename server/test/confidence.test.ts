// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeConfidence, type EvidenceInput } from "../confidence";

const NOW = new Date("2026-11-10");
const mk = (n: number, signal: EvidenceInput["signal"], date: string | null, from = 0): EvidenceInput[] =>
  Array.from({ length: n }, (_, i) => ({ participantId: `P${from + i}`, signal, date }));

describe("confidence v1", () => {
  it("counts participants, not mentions", () => {
    const items = [...mk(1, "positive", "2026-11-01"), ...mk(1, "positive", "2026-11-01"), ...mk(1, "positive", "2026-11-01")];
    expect(computeConfidence(items, NOW).participants).toBe(1);
  });
  it("is deterministic and rewards larger agreeing recent samples", () => {
    const small = computeConfidence(mk(5, "positive", "2026-10-30"), NOW);
    const big = computeConfidence(mk(25, "positive", "2026-10-30"), NOW);
    expect(computeConfidence(mk(5, "positive", "2026-10-30"), NOW)).toEqual(small);
    expect(big.score!).toBeGreaterThan(small.score!);
    expect(big.factors).toMatchObject({ agreement: 100, contradictions: 100 });
    expect(big.direction).toEqual({ label: "Positive", pct: 100 });
  });
  it("lowers confidence with contradictions and old data", () => {
    const clean = computeConfidence(mk(20, "positive", "2026-10-30"), NOW);
    const split = computeConfidence([...mk(14, "positive", "2026-10-30"), ...mk(6, "negative", "2026-10-30", 14)], NOW);
    const old = computeConfidence(mk(20, "positive", "2024-01-01"), NOW);
    expect(split.score!).toBeLessThan(clean.score!);
    expect(split.factors.contradictions).toBe(70);
    expect(old.factors.recency).toBeLessThan(10);
    expect(old.score!).toBeLessThan(clean.score!);
  });
  it("treats undated evidence as half-fresh, not fresh", () => {
    expect(computeConfidence(mk(10, "positive", null), NOW).factors.recency).toBe(50);
  });
  it("withholds the prediction when evidence is thin, but still reports confidence", () => {
    const r = computeConfidence(mk(3, "positive", "2026-11-01"), NOW);
    expect(r.withheld).toBe(true);
    expect(r.direction).toBeUndefined();
    expect(computeConfidence([], NOW)).toMatchObject({ score: null, label: "very_low", withheld: true, participants: 0 });
  });
  it("reports Mixed when no direction dominates", () => {
    const r = computeConfidence([...mk(8, "positive", "2026-11-01"), ...mk(7, "negative", "2026-11-01", 8)], NOW);
    expect(r.direction?.label).toBe("Mixed");
  });
});

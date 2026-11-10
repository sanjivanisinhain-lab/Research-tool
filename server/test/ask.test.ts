// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { answerQuestion } from "../ai/ask";
import { MockProvider } from "../ai/provider";

function seed(n: number) {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  for (let i = 1; i <= n; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','2026-01-01');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('SRC${i}','S','${p}','cx_call','researcher_notes','t','2026-10-20','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('SRC${i}','${p}','delivery late ${i}','delivery arrives late','said','participant_verbatim','delivery delay','negative','approved','x');`);
  }
  return db;
}
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const make = (n: number, kw = ["delivery", "late"]) => new MockProvider((req) => req.system.includes("search over")
  ? { keywords: kw }
  : { headline: "Delivery delay hurts", summary: "s",
      signals: [...Array.from({ length: n }, (_, i) => ({ evidence_id: i + 1, signal: "negative" })), { evidence_id: 9999, signal: "positive" }],
      patterns: [{ title: "Late", summary: "x", signal: "risk", label: "evidence", evidence_ids: [1, 2, 9999] }, { title: "Uncited", summary: "y", signal: "mixed", label: "evidence", evidence_ids: [777] }],
      conflict: { title: "fake", body: "b", evidence_ids: [888] }, unknowns: [{ title: "u", body: "b" }], implications: imps });

describe("headline consistency", () => {
  it("rewrites a headline that says mixed when the computed direction is one-sided", async () => {
    const ai = new MockProvider((req) => req.system.includes("search over") ? { keywords: ["delivery"] }
      : req.system.includes("Rewrite the draft") ? { headline: "Likely negative reaction", summary: "Most point negative; a few differ." }
      : { headline: "Trust is mixed", summary: "mixed", signals: Array.from({ length: 12 }, (_, i) => ({ evidence_id: i + 1, signal: "negative" })), patterns: [], unknowns: [], implications: imps });
    const a = await answerQuestion(seed(12), ai, { question: "late delivery?", audience: [], now: new Date("2026-11-10") });
    expect(a.headline).toBe("Likely negative reaction");
    expect(ai.calls).toBe(3);
  });
});

describe("ask pipeline", () => {
  it("computes confidence in code, drops fake citations, downgrades uncited claims", async () => {
    const a = await answerQuestion(seed(12), make(12), { question: "Will late delivery matter?", audience: [], now: new Date("2026-11-10") });
    expect(a.variant).toBe("standard");
    expect(a.confidence).toMatchObject({ participants: 12, methodStatus: "computed_v1" });
    expect(a.direction).toEqual({ label: "Negative", pct: 100 });
    expect(a.patterns[0].evidenceIds).toEqual(["1", "2"]);
    expect(a.patterns[1]).toMatchObject({ label: "inference", evidenceIds: [] });
    expect(a.conflict).toBeUndefined();
    expect(a.evidenceStatus).toBe("approved_only");
  });
  it("returns the insufficient state (no prediction) when evidence is thin", async () => {
    const a = await answerQuestion(seed(3), make(3), { question: "late delivery?", audience: [] });
    expect(a.variant).toBe("insufficient");
    expect(a.direction).toBeUndefined();
    expect(a.confidence.participants).toBe(3);
  });
  it("says no evidence when nothing matches, without calling the answer model", async () => {
    const ai = make(0, ["gesture", "swipe"]); const a = await answerQuestion(seed(5), ai, { question: "gesture navigation zzzz", audience: [] });
    expect(a.variant).toBe("insufficient");
    expect(a.confidence.participants).toBe(0);
    expect(ai.calls).toBe(1);
  });
  it("ignores pending evidence unless explicitly allowed, and flags it", async () => {
    const db = seed(12); db.exec("UPDATE evidence SET status='pending'");
    expect((await answerQuestion(db, make(12), { question: "late delivery", audience: [] })).variant).toBe("insufficient");
    expect((await answerQuestion(db, make(12), { question: "late delivery", audience: [], includeUnreviewed: true })).evidenceStatus).toBe("includes_unreviewed");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { answerQuestion } from "../ai/ask";
import { wantsStudyPlan } from "../ai/plan";
import { MockProvider } from "../ai/provider";

const A = { kind: "persona" as const, id: "PER-A", name: "Cash Cautious", participants: 12 };
function seed(delivery = true) {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,12,12); INSERT INTO personas(id,run_id,name,description) VALUES ('PER-A',1,'Cash Cautious','d')");
  for (let i = 1; i <= 12; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x'); INSERT INTO persona_participants VALUES ('PER-A','${p}');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-25','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','cod hi chahiye','${delivery ? "prefers cash on delivery because of trust" : "unrelated"}','said','participant_verbatim','payment','neutral','approved','x');`);
  }
  return db;
}
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const plan = (calls: { n: number } = { n: 0 }) => new MockProvider((req) => {
  calls.n++;
  if (req.system.includes("search over")) return { keywords: ["cash", "delivery", "trust"] };
  return { method: "Moderated usability test", method_reason: "Evidence on payment is strong; the gesture flow is untested.", objective: "Learn whether users find the new flow", task: "Complete a COD order", watch_for: "Hesitation at payment",
    questions: ["  How did you decide how to pay? ", "", "What did you expect to happen next?"],
    well_understood: [
      { title: "Prefers cash", body: "They prefer cash on delivery.", evidence_ids: [1, 2, 3, 4, 5, 999] },
      { title: "Thin claim", body: "Only two people.", evidence_ids: [1, 2] },
      { title: "Invented", body: "No real evidence.", evidence_ids: [888] }],
    needs_validation: [{ title: "Trust in prepaid", body: "Do they trust prepaid with a discount?", topic: ["trust", "cash"] }, { title: "Gesture discoverability", body: "Can they find the swipe?", topic: ["swipe", "gesture"] }],
    implications: imps };
});

describe("planner intent", () => {
  it("recognises requests for a test plan, not ordinary questions", () => {
    for (const q of ["How should I test this?", "Plan a usability test for the new COD flow", "What should we test next?", "Can you build a test plan for checkout", "suggest a study for returns"]) expect(wantsStudyPlan(q), q).toBe(true);
    for (const q of ["Why do users abandon their cart?", "Would these users trust prepaid offers?", "How do users test products before buying?", "Does the test group prefer COD?"]) expect(wantsStudyPlan(q), q).toBe(false);
  });
});

describe("study planner", () => {
  it("separates what is already understood (verified, counted) from what needs validation (counted in code)", async () => {
    const a = await answerQuestion(seed(), plan(), { question: "How should I test the new gesture checkout?", audience: [A] });
    expect(a.variant).toBe("study_plan");
    expect(a.headline).toBe("Recommended next test: Moderated usability test");
    expect(a.studyPlan!.audience).toBe("Cash Cautious. Suggested sample: 5 to 8 participants");
    expect(a.studyPlan!.questions).toEqual(["How did you decide how to pay?", "What did you expect to happen next?"]);
    expect(a.known).toHaveLength(1);
    expect(a.known![0]).toMatchObject({ title: "Prefers cash", label: "evidence", evidenceIds: ["1", "2", "3", "4", "5"] }); // fake id dropped
    expect(a.known![0].body).toContain("(5 participants)");
    const needs = a.unknowns.map((u) => u.title);
    expect(needs).toEqual(expect.arrayContaining(["Thin claim", "Invented", "Trust in prepaid", "Gesture discoverability"])); // unsupported "knowns" demoted
    expect(a.unknowns.find((u) => u.title === "Trust in prepaid")!.body).toContain("Existing evidence: 12 participants.");
    expect(a.unknowns.find((u) => u.title === "Gesture discoverability")!.body).toContain("none found");
    expect(a.confidence).toMatchObject({ participants: 5, methodStatus: "computed_v1" });
  });
  it("still plans when there is no evidence at all: everything needs validation", async () => {
    const a = await answerQuestion(seed(false), plan(), { question: "What should we test next?", audience: [A] });
    expect(a.variant).toBe("study_plan");
    expect(a.known).toEqual([]);
    expect(a.unknowns.every((u) => /none found|too thin/.test(u.body))).toBe(true);
  });
  it("uses the earlier answer as context and inherits its audience", async () => {
    const db = seed();
    const first = await answerQuestion(db, new MockProvider((r) => r.system.includes("search over") ? { keywords: ["cash"] } : { headline: "Cash preferred", summary: "s", signals: [], patterns: [], unknowns: [{ title: "Gesture", body: "b" }], implications: imps }), { question: "Do they prefer cash?", audience: [A] });
    let prompt = "";
    const ai = new MockProvider((req) => { if (req.system.includes("NEXT piece")) prompt = req.prompt; return plan().responder(req); });
    const a = await answerQuestion(db, ai, { question: "How should I test this?", audience: [], contextAnswerId: first.id });
    expect(prompt).toContain("Earlier question: Do they prefer cash?");
    expect(prompt).toContain("Known gaps already noted: Gesture");
    expect(a.audience.map((x) => x.name)).toEqual(["Cash Cautious"]);
  });
});

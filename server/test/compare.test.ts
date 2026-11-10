// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { answerQuestion, compareAudiences, followUp } from "../ai/ask";
import { MockProvider } from "../ai/provider";

const A = { kind: "persona" as const, id: "PER-A", name: "Delivery Worriers", participants: 12 };
const B = { kind: "persona" as const, id: "PER-B", name: "Deal Lovers", participants: 12 };
const T = { kind: "persona" as const, id: "PER-T", name: "Tiny Group", participants: 3 };

function seed() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  db.exec(`INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,24,24);
    INSERT INTO personas(id,run_id,name,description) VALUES ('PER-A',1,'Delivery Worriers','d'),('PER-B',1,'Deal Lovers','d'),('PER-T',1,'Tiny Group','d');`);
  for (let i = 1; i <= 24; i++) {
    const p = `P${String(i).padStart(3, "0")}`; const neg = i <= 12;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-25','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','q${i}','${neg ? "delivery was late and offer felt risky" : "great discount offer on delivery"}','said','participant_verbatim','offer','neutral','approved','x');
      INSERT INTO persona_participants VALUES ('${neg ? "PER-A" : "PER-B"}','${p}');`);
    if (i <= 3) db.exec(`INSERT INTO persona_participants VALUES ('PER-T','${p}')`);
  }
  return db;
}
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const ai = () => new MockProvider((req) => {
  if (req.system.includes("search over")) return { keywords: ["delivery", "offer"] };
  if (req.system.includes("You compare how several")) return { dimensions: [{ name: "Trust", per_audience: [{ audience: "Delivery Worriers", signal: "risk", summary: "worry" }, { audience: "Deal Lovers", signal: "strong", summary: "like" }] }], biggestDifference: "Trust differs", designImplication: "Validate", implications: imps };
  if (req.system.includes("follow-up question")) return { reply: "They mostly worry about lateness.", label: "evidence", evidence_ids: [1, 2, 9999] };
  const ids = [...req.prompt.matchAll(/#(\d+) \(P(\d+),/g)].map((m) => ({ id: Number(m[1]), n: Number(m[2]) }));
  return { headline: "h", summary: "s", signals: ids.map((x) => ({ evidence_id: x.id, signal: x.n <= 12 ? "negative" : "positive" })),
    patterns: [{ title: "Pattern", summary: "p", signal: "risk", label: "evidence", evidence_ids: ids.slice(0, 2).map((x) => x.id) }], unknowns: [{ title: "u", body: "b" }], implications: imps };
});
const now = new Date("2026-11-10");

describe("compare mode", () => {
  it("assesses each audience separately and reports each direction", async () => {
    const mock = ai();
    const a = await compareAudiences(seed(), mock, { question: "Will the delivery offer work?", audience: [A, B], now });
    expect(a.variant).toBe("comparison");
    expect(a.comparison!.columns.map((c) => c.direction)).toEqual([{ label: "Negative", pct: 100 }, { label: "Positive", pct: 100 }]);
    expect(a.headline).toBe("Delivery Worriers: 100% negative vs Deal Lovers: 100% positive");
    expect(a.comparison!.columns[0].dimensions[0]).toMatchObject({ name: "Trust", signal: "risk" });
    expect(a.comparison!.biggestDifference).toBe("Trust differs");
    expect(mock.calls).toBe(4); // intent + 2 audiences + comparison
  });
  it("is inconclusive when an audience has thin evidence: no ranking, no directions, no comparison call", async () => {
    const mock = ai();
    const a = await compareAudiences(seed(), mock, { question: "Will the delivery offer work?", audience: [A, T], now });
    expect(a.headline).toBe("Comparison inconclusive");
    expect(a.comparison!.columns.every((c) => c.direction === undefined)).toBe(true);
    expect(a.comparison!.biggestDifference).toMatch(/inconclusive/i);
    expect(mock.calls).toBe(3); // intent + 2 audiences, no comparison
  });
  it("needs two audiences", async () => {
    await expect(compareAudiences(seed(), ai(), { question: "q", audience: [A] })).rejects.toThrow(/two audiences/);
  });
});

describe("follow-ups", () => {
  it("answers within the audience, drops invented citations, and persists on the answer", async () => {
    const db = seed(); const mock = ai();
    const a = await answerQuestion(db, mock, { question: "Will the delivery offer work?", audience: [A], now });
    const fu = await followUp(db, mock, a.id, "What worries them most?", now);
    expect(fu).toMatchObject({ label: "evidence", question: "What worries them most?" });
    expect(fu!.evidenceIds.every((i) => Number(i) <= 12)).toBe(true); // only evidence from the audience, no fake 9999
    expect(fu!.evidenceIds).not.toContain("9999");
    const saved = JSON.parse((db.prepare("SELECT answer_json j FROM answers WHERE id=?").get(a.id) as { j: string }).j);
    expect(saved.followUps).toHaveLength(1);
  });
  it("says no evidence without a model answer when nothing matches; unknown answer is null", async () => {
    const db = seed(); const mock = ai();
    const a = await answerQuestion(db, mock, { question: "Will the delivery offer work?", audience: [A], now });
    const quiet = new MockProvider(() => ({ keywords: ["zzzz"] }));
    const fu = await followUp(db, quiet, a.id, "gesture swipe navigation zzzz", now);
    expect(fu).toMatchObject({ label: "no_evidence", evidenceIds: [] });
    expect(await followUp(db, mock, "nope", "q")).toBeNull();
  });
});

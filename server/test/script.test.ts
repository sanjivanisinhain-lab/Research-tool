// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { answerQuestion } from "../ai/ask";
import { MockProvider } from "../ai/provider";
import { looksLikeScript, attachmentText } from "../attachments";

const SCRIPT = `Interview guide
1. Don't you think late delivery is really annoying?
2. How easy and fast was checkout for you?
3. How do you usually receive your orders?
4. If we offered free returns, would you order more?`;

function seed(n = 12) {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','2026-01-01')");
  for (let i = 1; i <= n; i++) {
    const p = `P${String(i).padStart(3, "0")}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${i}','S','${p}','cx_call','researcher_notes','t','2026-10-20','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','delivery late ${i}','delivery arrives late','said','participant_verbatim','delivery','negative','approved','x');`);
  }
  return db;
}
const review = (qs: unknown[]) => new MockProvider(() => ({ questions: qs }));
const Q = [
  { original: "Don't you think late delivery is really annoying?", status: "leading", issue: "Leading", note: "Presumes it is annoying.", rewrite: "How do you feel about delivery times?", topic: ["delivery", "late"] },
  { original: "How easy and fast was checkout for you?", status: "improve", issue: "Double-barrelled", note: "Asks two things.", rewrite: "How was checkout?", topic: ["checkout"] },
  { original: "How do you usually receive your orders?", status: "good", rewrite: "should be ignored for good questions", topic: ["delivery", "arrives"] },
  { original: "This question is not in the script at all", status: "leading", topic: ["x"] },
];

describe("script review", () => {
  it("reviews a pasted script: keeps only real questions, computes counts, readiness and evidence overlap in code", async () => {
    const a = await answerQuestion(seed(), review(Q), { question: "Can you check this before tomorrow's sessions?", audience: [], attachments: [{ name: "guide.txt", kind: "transcript", text: SCRIPT }] });
    expect(a.variant).toBe("script_review");
    const r = a.scriptReview!;
    expect(r.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]); // invented question dropped
    expect(r.questions[0].original).toBe("Don't you think late delivery is really annoying?"); // numbering stripped
    expect(r.counts).toEqual({ good: 1, improve: 1, leading: 1 });
    expect(r.readiness).toBe("Needs revision before use"); // 2 of 3 weak
    expect(r.questions[2].rewrite).toBeUndefined(); // no rewrite for a good question
    expect(r.questions[0]).toMatchObject({ issue: "Leading", rewrite: expect.any(String) });
    expect(r.overlap.title).toMatch(/already know/i);
    expect(r.overlap.body).toMatch(/Questions? 1.*3|Questions? 3.*1/); // delivery questions have 12 participants
    expect(r.overlap.evidenceIds.length).toBeGreaterThan(0);
    expect(a.confidence.participants).toBe(12);
    expect(a.confidence.methodStatus).toBe("computed_v1");
  });
  it("says there is no existing evidence when the audience has none on the topics", async () => {
    const db = seed(); db.exec("UPDATE evidence SET translation='x', original_text='zzz', theme='zzz'");
    const a = await answerQuestion(db, review(Q), { question: "review my interview guide", audience: [], attachments: [{ name: "g.txt", kind: "transcript", text: SCRIPT }] });
    expect(a.scriptReview!.overlap.title).toMatch(/No existing evidence/i);
  });
  it("falls back to a normal answer when the material has no research questions", async () => {
    const ai = new MockProvider((req) => req.system.includes("methodologist") ? { questions: [] } : req.system.includes("search over") ? { keywords: ["delivery"] } : { headline: "h", summary: "s", signals: [], patterns: [], unknowns: [], implications: {} });
    const a = await answerQuestion(seed(), ai, { question: "Why do users find delivery late? Is it common? Does it matter?", audience: [], attachments: [{ name: "n.txt", kind: "transcript", text: "x".repeat(80) + "? ? ?" }] });
    expect(a.variant).not.toBe("script_review");
  });
  it("coverage needs the question's specific topic words, not generic ones", async () => {
    const { coversTopic } = await import("../ai/script");
    expect(coversTopic("I use Snapdeal online for orders", ["snapdeal", "online", "orders"])).toBe(false); // only generic words
    expect(coversTopic("delivery arrives late", ["delivery", "late"])).toBe(true);
    expect(coversTopic("delivery is fine", ["delivery", "refund"])).toBe(false); // needs 2 specific words
    expect(coversTopic("refund never came", ["refund"])).toBe(true); // a single specific word is enough when that is all there is
  });
  it("only treats script-like material as a script", () => {
    expect(looksLikeScript("Why do users abandon cart?", "")).toBe(false);
    expect(looksLikeScript("check this", SCRIPT)).toBe(true);
    expect(looksLikeScript("Review my interview guide:\n1. How do you shop?\n2. What do you buy?\n3. Why?", "")).toBe(true);
  });
  it("reads text from attachments and rejects oversized ones", async () => {
    expect(await attachmentText({ name: "a.txt", kind: "local", data: Buffer.from("hello there").toString("base64") })).toBe("hello there");
    expect(await attachmentText({ name: "b.png", kind: "local", data: "AAAA" })).toBe("");
    await expect(attachmentText({ name: "big.txt", kind: "local", data: Buffer.alloc(11 * 1024 * 1024).toString("base64") })).rejects.toThrow(/10 MB/);
  });
});

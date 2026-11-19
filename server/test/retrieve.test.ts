// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { overviewEvidence } from "../search";
import { answerQuestion, followUp } from "../ai/ask";
import { planStudy } from "../ai/plan";
import { chatWithPersona, latestPersona } from "../ai/personaChat";
import { MockProvider } from "../ai/provider";
import { stripEvidenceMarkers } from "../retrieve";

function seed() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('SG','Gen Z shopping interviews','Fashion','x'),('SC','Snapdeal CX calls','Snapdeal','x')");
  db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,0,0); INSERT INTO personas(id,run_id,name,description) VALUES ('PER-1',1,'Browsers','d')");
  const add = (n: number, study: string, theme: string, text: string, prov = "participant_verbatim", persona = false) => {
    const p = `P${String(n).padStart(3, "0")}`;
    db.exec(`INSERT OR IGNORE INTO participants VALUES ('${p}','${study}','{}','x');
      INSERT OR IGNORE INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('X${n}','${study}','${p}','interview','verbatim_transcript','t','2026-10-25','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,canonical_theme,sentiment,status,created_at) VALUES ('X${n}','${p}','${theme} ${n}','${text}','did','${prov}','${theme}','${theme}','neutral','approved','x');`);
    if (persona) db.exec(`INSERT OR IGNORE INTO persona_participants VALUES ('PER-1','${p}')`);
  };
  for (let i = 1; i <= 6; i++) add(i, "SG", "social inspiration", `I browse Pinterest and Instagram for outfit ideas ${i}`, "participant_verbatim", true);
  for (let i = 1; i <= 2; i++) add(i, "SG", "wishlisting", `I keep things in my wishlist until I need them ${i}`, "participant_verbatim", true);
  for (let i = 7; i <= 10; i++) add(i, "SC", "cod trust", `I only pay cash on delivery ${i}`, "researcher_note");
  return db;
}
const imps = Object.fromEntries(["designer", "researcher", "pm", "marketing", "cx", "other"].map((r) => [r, { keep: "k", change: "c", watch: "w" }]));
const STATUS = ["approved"];

describe("overview retrieval", () => {
  it("samples evidence theme by theme, one quote per person, own words first, themes ranked by participants", () => {
    const o = overviewEvidence(seed(), { statuses: STATUS, themes: 3, perTheme: 2 });
    expect(o.themes).toEqual([{ theme: "social inspiration", participants: 6 }, { theme: "cod trust", participants: 4 }, { theme: "wishlisting", participants: 2 }]);
    expect(o.hits.every((h) => h.overview)).toBe(true);
    const per = o.hits.filter((h) => h.theme === "social inspiration"); expect(per).toHaveLength(2); expect(new Set(per.map((h) => h.participantId)).size).toBe(2);
  });
  it("respects the audience and prefers the named study", () => {
    const db = seed();
    expect(overviewEvidence(db, { statuses: STATUS, participants: ["P007", "P008"] }).themes).toEqual([{ theme: "cod trust", participants: 2 }]);
    const pref = overviewEvidence(db, { statuses: STATUS, preferStudyIds: ["SG"], themes: 1, perTheme: 3 });
    expect(pref.hits.every((h) => h.participantId <= "P004" || h.theme !== "social inspiration")).toBe(true);
  });
});

describe("broad questions no longer end in 'no evidence'", () => {
  const ai = (intent: object, seen: { prompt: string; calls: number } = { prompt: "", calls: 0 }) => new MockProvider((req) => {
    if (req.system.includes("search over")) return intent;
    seen.calls++; seen.prompt = req.prompt;
    const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
    return { headline: "They browse Pinterest and Instagram for ideas", summary: "s", signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })), patterns: [{ title: "Inspiration", summary: "x", signal: "strong", label: "evidence", evidence_ids: ids.slice(0, 2) }], unknowns: [], implications: imps };
  });
  it("answers 'usual Gen Z behaviour' from the Gen Z research even though no words match, with no audience chosen", async () => {
    const seen = { prompt: "", calls: 0 };
    const a = await answerQuestion(seed(), ai({ keywords: ["zzzz", "genz behaviour"], studies: ["Gen Z shopping interviews"], broad: true }, seen), { question: "what is the usual genz behaviour?", audience: [], now: new Date("2026-11-10") });
    expect(a.variant).toBe("standard");
    expect(seen.prompt).toContain("[overview]"); expect(seen.prompt).toContain("Pinterest"); expect(seen.prompt).toContain("social inspiration (6)");
    expect(seen.prompt).not.toContain("cash on delivery"); // evidence from the other study is not mixed in
    expect(a.confidence.participants).toBe(5); // at most 5 voices are sampled per theme
  });
  it("a specific question with no matching words still says 'no evidence' without asking the model to answer", async () => {
    const seen = { prompt: "", calls: 0 };
    const a = await answerQuestion(seed(), ai({ keywords: ["dark", "mode"], studies: [], broad: false }, seen), { question: "Would you prefer dark mode?", audience: [] });
    expect(a.variant).toBe("insufficient"); expect(seen.calls).toBe(0);
  });
  it("ignores study names the model invents", async () => {
    const seen = { prompt: "", calls: 0 };
    await answerQuestion(seed(), ai({ keywords: ["zzzz"], studies: ["Imaginary study"], broad: false }, seen), { question: "anything", audience: [] });
    expect(seen.calls).toBe(0);
  });
  it("follow-ups on a broad topic use the overview too", async () => {
    const db = seed(); const a = await answerQuestion(db, ai({ keywords: ["pinterest"], studies: [], broad: false }), { question: "how do they find outfits on Pinterest?", audience: [] });
    const seen = { prompt: "", calls: 0 };
    const fu = new MockProvider((req) => req.system.includes("search over") ? { keywords: ["zzzz"], broad: true, studies: ["Gen Z shopping interviews"] } : (seen.prompt = req.prompt, (() => { const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1])); return { headline: "They keep wishlists", summary: "s", coverage: "direct", signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })), patterns: [{ title: "Wishlists", summary: "x", signal: "strong", label: "evidence", evidence_ids: ids.slice(0, 5) }], unknowns: [], implications: imps }; })()));
    const r = await followUp(db, fu, a.id, "what else is usual for them?");
    expect(seen.prompt).toContain("[overview]"); expect(r!.label).toBe("evidence");
    expect(r!.answer).toMatchObject({ variant: "standard", headline: "They keep wishlists" }); // a follow-up is answered like a first question
  });
  it("persona chat answers 'how do you usually shop?' from the persona's research", async () => {
    const db = seed(); const seen = { prompt: "" };
    const ai2 = new MockProvider((req) => req.system.includes("search over") ? { keywords: ["zzzz"], broad: true, studies: [] } : (seen.prompt = req.prompt, { reply: "Most of us look at Pinterest first, and some keep a wishlist.", label: "evidence", evidence_ids: [1, 2, 3, 4] }));
    const m = await chatWithPersona(db, ai2, { userId: "u", persona: latestPersona(db, "PER-1")!, text: "How do you usually shop?" });
    expect(m.label).toBe("evidence"); expect(seen.prompt).toContain("[overview]"); expect(seen.prompt).not.toContain("cash on delivery");
  });
});

describe("evidence numbers never appear in prose", () => {
  it("strips bracketed and hash-style markers but leaves real numbers alone", () => {
    expect(stripEvidenceMarkers("Some of us wait for sales [468, 505, 773].")).toBe("Some of us wait for sales.");
    expect(stripEvidenceMarkers("We prefer COD (#12) mostly.")).toBe("We prefer COD mostly.");
    expect(stripEvidenceMarkers("Most wait 6 days and pay Rs 899 (about 40% do).")).toBe("Most wait 6 days and pay Rs 899 (about 40% do).");
  });
});

describe("auto audience", () => {
  const ai = (aud: string[]) => new MockProvider((req) => {
    if (req.system.includes("search over")) return { keywords: ["pinterest"], broad: false, audiences: aud };
    const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
    return { headline: "They browse for ideas", summary: "s", signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })), patterns: [{ title: "Inspiration", summary: "x", signal: "strong", label: "evidence", evidence_ids: ids.slice(0, 2) }], unknowns: [], implications: imps };
  });
  it("picks the audience the question is about and records that it was automatic", async () => {
    const db = seed();
    const a = await answerQuestion(db, ai(["Browsers"]), { question: "Where do they find outfit ideas on pinterest?", audience: [], autoAudience: true, now: new Date("2026-11-10") });
    expect(a.audience.map((x) => x.name)).toEqual(["Browsers"]); expect(a.autoAudience).toBe(true);
  });
  it("ignores invented names, and never auto-picks when the user chose an audience", async () => {
    const db = seed();
    const a = await answerQuestion(db, ai(["Made-up group"]), { question: "pinterest ideas?", audience: [], autoAudience: true, now: new Date("2026-11-10") });
    expect(a.audience).toEqual([]); expect(a.autoAudience).toBe(true);
    const own = [{ kind: "persona" as const, id: "PER-1", name: "Browsers", participants: 6 }];
    const b = await answerQuestion(db, ai(["Browsers"]), { question: "pinterest ideas?", audience: own, autoAudience: true, now: new Date("2026-11-10") });
    expect(b.autoAudience).toBeUndefined();
  });
});

describe("saying so first when the research only covers a question in general terms", () => {
  /** keywords: what the question's own words find. With none, only the general overview sample is available. */
  const answerAi = (coverage: "direct" | "general", keywords: string[]) => new MockProvider((req) => {
    if (req.system.includes("search over")) return { keywords, broad: keywords[0] === "zzzz", studies: keywords[0] === "zzzz" ? ["Gen Z shopping interviews"] : [] };
    const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
    return { headline: "They browse for ideas", summary: "They look at Pinterest.", coverage, ...(coverage === "general" ? { coverage_note: "We have nothing on wishlists for gifts." } : {}), signals: ids.map((i) => ({ evidence_id: i, signal: "positive" })),
      patterns: [{ title: "Ideas", summary: "x", signal: "strong", label: "evidence", evidence_ids: ids.slice(0, 5) }], unknowns: [], implications: imps };
  });
  const NOW = new Date("2026-11-10");
  it("flags an answer that rests only on the general overview, with what is missing, and leaves a direct answer unflagged", async () => {
    const g = await answerQuestion(seed(), answerAi("general", ["zzzz"]), { question: "would they buy a gift for a friend?", audience: [], now: NOW });
    expect(g).toMatchObject({ variant: "standard", coverage: "general", coverageNote: "We have nothing on wishlists for gifts." });
    const d = await answerQuestion(seed(), answerAi("direct", ["pinterest"]), { question: "do they use pinterest?", audience: [], now: NOW });
    expect(d.coverage).toBeUndefined();
  });
  it("does not warn when the question's own words found the evidence, even if the AI called it general", async () => {
    // The AI said "general" (it was being strict about completeness), but 5 people's evidence matched the question's words: the research does speak to it.
    const a = await answerQuestion(seed(), answerAi("general", ["pinterest"]), { question: "what are our biggest gaps around pinterest?", audience: [], now: NOW });
    expect(a).toMatchObject({ variant: "standard" }); expect(a.coverage).toBeUndefined();
  });
  it("answers a follow-up in the same form as a first question, and says so plainly when nothing fits", async () => {
    const db = seed();
    const a = await answerQuestion(db, answerAi("direct", ["pinterest"]), { question: "do they use pinterest?", audience: [], now: NOW });
    const f = await followUp(db, answerAi("general", ["zzzz"]), a.id, "what else is usual for them?", NOW);
    expect(f!.answer).toMatchObject({ variant: "standard", coverage: "general", headline: "They browse for ideas" });
    expect(f!.answer!.patterns[0]!.evidenceIds.length).toBeGreaterThan(0);
    expect(f!.answer!.confidence).toMatchObject({ methodStatus: "computed_v1" });
    expect(f!.evidenceIds.length).toBeGreaterThan(0);
    const quiet = new MockProvider((req) => (req.system.includes("search over") ? { keywords: ["qqqq"], broad: false, studies: [] } : { headline: "x", summary: "x", coverage: "direct", signals: [], patterns: [], unknowns: [], implications: imps }));
    const none = await followUp(db, quiet, a.id, "qqqq vvvv", NOW);
    expect(none).toMatchObject({ label: "no_evidence", evidenceIds: [] });
    expect(none!.answer).toMatchObject({ variant: "insufficient" });
    expect(none!.reply).toMatch(/don't have research/);
    const saved = JSON.parse((db.prepare("SELECT answer_json j FROM answers WHERE id=?").get(a.id) as { j: string }).j);
    expect(saved.followUps).toHaveLength(2);
  });
});

describe("a study plan states how much research there really is", () => {
  it("tells the AI the real totals, not the size of the sample it was shown", async () => {
    const db = seed(); let system = "", prompt = "";
    const ai = new MockProvider((req) => { system = req.system; prompt = req.prompt; return { method: "In-depth interviews", method_reason: "r", objective: "o", task: "t", watch_for: "w", questions: ["q"], well_understood: [], needs_validation: [], implications: imps }; });
    await planStudy(db, ai, { question: "How should we test outfit ideas from pinterest?", audience: [], scope: { terms: ["pinterest"], studyIds: [], broad: false } });
    expect(prompt).toContain("10 participants in total"); // every participant with approved evidence, not just those in the 40 items shown
    expect(prompt).toContain("about 6 of them");
    expect(system).toMatch(/only a SAMPLE/);
    const own = [{ kind: "persona" as const, id: "PER-1", name: "Browsers", participants: 6 }];
    await planStudy(db, ai, { question: "How should we test outfit ideas from pinterest?", audience: own, scope: { terms: ["pinterest"], studyIds: [], broad: false } });
    expect(prompt).toContain("6 participants in total"); // an audience counts its own members
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { overviewEvidence } from "../search";
import { answerQuestion, followUp } from "../ai/ask";
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
    const fu = new MockProvider((req) => req.system.includes("search over") ? { keywords: ["zzzz"], broad: true, studies: ["Gen Z shopping interviews"] } : (seen.prompt = req.prompt, { reply: "They keep wishlists.", label: "evidence", evidence_ids: [5, 6, 7] }));
    const r = await followUp(db, fu, a.id, "what else is usual for them?");
    expect(seen.prompt).toContain("[overview]"); expect(r!.label).toBe("evidence");
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

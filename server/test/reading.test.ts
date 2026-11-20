// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db";
import { enqueueExtractions, runNextJob } from "../jobs";
import { MockProvider } from "../ai/provider";
import { searchEvidence } from "../search";

function seedSources(db: Db, spec: { id: string; pid: string; text: string }[]) {
  db.exec("INSERT OR IGNORE INTO studies VALUES ('S','s','p','x')");
  for (const { id, pid, text } of spec) {
    db.prepare("INSERT OR IGNORE INTO participants VALUES (?,?,?,?)").run(pid, "S", "{}", "x");
    db.prepare("INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES (?,?,?,?,?,?,?)").run(id, "S", pid, "cx_call", "researcher_notes", "t", "x");
    db.prepare("INSERT INTO utterances(source_id,participant_id,speaker,seq,text) VALUES (?,?,?,?,?)").run(id, pid, "note", 0, text);
  }
}
/** Answers with one finding per numbered line, quoting its first words. Counts the calls. */
const reader = () => { const t = { calls: 0, prompts: [] as string[] }; const ai = new MockProvider((req) => {
  t.calls++; t.prompts.push(req.prompt);
  const lines = [...req.prompt.matchAll(/^\[(\d+)\] \w+: (.*)$/gm)];
  return { findings: [...lines.map((m) => ({ utterance_id: Number(m[1]), quote: m[2]!.slice(0, 22), kind: "did", theme: "delivery", sentiment: "negative" })), { utterance_id: 1, quote: "words that are nowhere in the text", kind: "said", theme: "x", sentiment: "neutral" }] };
}); return { t, ai }; };

describe("reading many short notes at once", () => {
  it("reads short notes in one call, long ones alone, gives every finding to the right person, and drops invented quotes", async () => {
    const db = openDb(":memory:"); const { t, ai } = reader();
    seedSources(db, [
      { id: "A", pid: "P1", text: "Cancelled the order because delivery was late." },
      { id: "B", pid: "P2", text: "Returned the shirt, wrong size arrived." },
      { id: "C", pid: "P3", text: "Stopped ordering after the refund never came." },
      { id: "L", pid: "P4", text: "Long interview about delivery trust. " + "More words about delivery. ".repeat(250) },
    ]);
    expect(enqueueExtractions(db)).toBe(4);
    while (await runNextJob(db, ai));
    expect(t.calls).toBe(2); // the three short notes together, the long one on its own
    expect(t.prompts[0]).toContain("--- Source A"); expect(t.prompts[0]).toContain("--- Source C"); expect(t.prompts[0]).not.toContain("Source L");
    expect(db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all()).toEqual([{ status: "done", n: 4 }]);
    const ev = db.prepare("SELECT source_id s, participant_id p, original_text q, status FROM evidence ORDER BY source_id").all() as { s: string; p: string; q: string; status: string }[];
    expect(ev.map((e) => [e.s, e.p])).toEqual([["A", "P1"], ["B", "P2"], ["C", "P3"], ["L", "P4"]]); // nothing mixed up between people
    expect(ev.every((e) => e.status === "approved")).toBe(true);
    expect(ev.some((e) => e.q.includes("nowhere"))).toBe(false);
    expect(db.prepare("SELECT source_id s, proposed, kept, dropped_unverified d FROM extraction_runs ORDER BY source_id").all()).toEqual([
      { s: "A", proposed: 2, kept: 1, d: 1 }, { s: "B", proposed: 1, kept: 1, d: 0 }, { s: "C", proposed: 1, kept: 1, d: 0 }, { s: "L", proposed: expect.any(Number), kept: 1, d: expect.any(Number) }]);
    // read already: nothing more to do, and no more calls
    enqueueExtractions(db);
    while (await runNextJob(db, ai));
    expect(t.calls).toBe(2);
  });
});

describe("answers draw on as many people as possible", () => {
  function evidenceDb() {
    const db = openDb(":memory:");
    db.exec("INSERT INTO studies VALUES ('S','s','p','x')");
    seedSources(db, ["A", "B", "C", "D", "E", "F"].map((x) => ({ id: "S" + x, pid: "P" + x, text: "t" })));
    const add = (pid: string, text: string) => db.prepare("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES (?,?,?,'said','participant_verbatim','delivery','negative','approved','x')").run("S" + pid.slice(1), pid, text);
    for (let i = 0; i < 12; i++) add("PA", `delivery was late again ${i} delivery delivery`); // one person says it a lot
    for (const p of ["PB", "PC", "PD", "PE", "PF"]) add(p, "delivery was late for me too");
    return db;
  }
  it("caps how much one person can fill, so a talkative participant does not crowd out the rest", () => {
    const db = evidenceDb();
    const plain = searchEvidence(db, { terms: ["delivery late"], statuses: ["approved"], limit: 8 });
    expect(new Set(plain.map((h) => h.participantId)).size).toBeLessThan(6); // the old behaviour: mostly one person
    const spread = searchEvidence(db, { terms: ["delivery late"], statuses: ["approved"], limit: 8, perParticipant: 2 });
    expect(new Set(spread.map((h) => h.participantId)).size).toBe(6);
    expect(spread.filter((h) => h.participantId === "PA")).toHaveLength(2);
  });
  it("applies the audience inside the search, so a small group still gets its own best evidence", () => {
    const db = evidenceDb();
    const hits = searchEvidence(db, { terms: ["delivery late"], participants: ["PB", "PC"], statuses: ["approved"], limit: 5 });
    expect(hits.map((h) => h.participantId).sort()).toEqual(["PB", "PC"]); // PA's twelve items outrank them in the global ranking, but PA is not in this audience
    expect(searchEvidence(db, { terms: ["delivery"], participants: [], statuses: ["approved"] })).toEqual([]);
  });
});

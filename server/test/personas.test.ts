// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { synthesise } from "../ai/personas";
import { MockProvider } from "../ai/provider";

function seed() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S1','Study','Shop','2026-01-01')");
  for (let i = 1; i <= 4; i++) {
    const p = `P00${i}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S1','{"payment_type":"COD"}','2026-01-01');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('SRC${i}','S1','${p}','cx_call','researcher_notes','t','2026-01-01');
      INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES ('SRC${i}','${p}','q${i}','said','participant_verbatim','cod trust','negative','${i === 4 ? "pending" : "approved"}','2026-01-01');`);
  }
  return db;
}
const responder = (req: any) => req.system.includes("define user SEGMENTS")
  ? { segments: [{ name: "COD users", characteristic: "pay cash" }, { name: "tiny", characteristic: "x" }], personas: [{ name: "Cash Cautious", description: "d" }] }
  : req.system.includes("Assign each participant")
    ? { assignments: [
        { participant_id: "P001", segments: ["COD users", "tiny"], personas: ["Cash Cautious"] }, { participant_id: "P002", segments: ["COD users"], personas: ["Cash Cautious"] },
        { participant_id: "P003", segments: ["COD users"], personas: ["Cash Cautious", "Unknown persona"] }, { participant_id: "PXXX", segments: ["COD users"], personas: ["Cash Cautious"] } ] }
    : { traits: [{ type: "trust_barrier", text: "supported", evidence_ids: [1, 2, 999] }, { type: "need", text: "invented", evidence_ids: [999] }, { type: "gap", text: "unknown X", evidence_ids: [] }] };

describe("synthesis", () => {
  it("uses approved evidence only, drops fake ids/unsupported traits, ignores small clusters", async () => {
    const db = seed();
    const r = await synthesise(db, new MockProvider(responder));
    expect(r).toMatchObject({ segments: 1, personas: 1, traitsKept: 2, traitsDropped: 1, includesUnreviewed: false });
    expect(db.prepare("SELECT COUNT(*) n FROM segment_participants").get()).toEqual({ n: 3 }); // PXXX removed
    expect(db.prepare("SELECT DISTINCT evidence_id FROM persona_trait_evidence ORDER BY 1").all()).toEqual([{ evidence_id: 1 }, { evidence_id: 2 }]);
    expect(db.prepare("SELECT evidence_count FROM synthesis_runs").get()).toEqual({ evidence_count: 3 });
  });
  it("refuses to run with no approved evidence, flags unreviewed runs", async () => {
    const empty = openDb(":memory:");
    await expect(synthesise(empty, new MockProvider(responder))).rejects.toThrow(/approved evidence/);
    const db = seed();
    expect((await synthesise(db, new MockProvider(responder), { includePending: true })).includesUnreviewed).toBe(true);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ftsQuery, searchEvidence } from "../search";

function seed() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO studies VALUES ('S','s','p','2026-01-01');
    INSERT INTO participants VALUES ('P001','S','{}','2026-01-01'),('P002','S','{}','2026-01-01');
    INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,date,created_at) VALUES ('A','S','P001','cx_call','researcher_notes','t','2026-09-01','x'),('B','S','P002','cx_call','researcher_notes','t','2026-09-02','x');
    INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES
      ('A','P001','delivery boy cancel kar dete hain','delivery agents cancel the order','said','participant_verbatim','delivery cancellation','negative','approved','x'),
      ('B','P002','COD hi chahiye','only wants cash on delivery','said','participant_verbatim','payment preference','neutral','pending','x');`);
  return db;
}
describe("search", () => {
  it("sanitises query input", () => { expect(ftsQuery(['delivery"; DROP', "the of"])).toBe('"delivery" OR "drop"'); });
  it("finds Hinglish and English text, approved only by default, filtered to audience", () => {
    const db = seed();
    expect(searchEvidence(db, { terms: ["delivery cancel"], statuses: ["approved"] }).map((h) => h.participantId)).toEqual(["P001"]);
    expect(searchEvidence(db, { terms: ["cash delivery"], statuses: ["approved"] })).toHaveLength(1); // P002 pending is excluded
    expect(searchEvidence(db, { terms: ["cash"], statuses: ["approved", "pending"] })).toHaveLength(1);
    expect(searchEvidence(db, { terms: ["delivery cash"], statuses: ["approved", "pending"], participants: ["P002"] }).map((h) => h.participantId)).toEqual(["P002"]);
  });
  it("keeps the index in sync on update/delete", () => {
    const db = seed();
    db.exec("UPDATE evidence SET translation='refund never came' WHERE participant_id='P001'");
    expect(searchEvidence(db, { terms: ["refund"], statuses: ["approved"] })).toHaveLength(1);
    db.exec("DELETE FROM evidence WHERE participant_id='P001'");
    expect(searchEvidence(db, { terms: ["refund"], statuses: ["approved"] })).toHaveLength(0);
  });
});

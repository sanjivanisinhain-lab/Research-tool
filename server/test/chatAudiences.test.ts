// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { MockProvider } from "../ai/provider";
import { chatWithPersona, conversation, latestPersona, membersOfAudience } from "../ai/personaChat";
import { upsertAttributes } from "../attributes";

function seed() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO studies VALUES ('S','s','p','x')");
  db.exec("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES ('2026-11-01','m',0,0,0)");
  db.exec("INSERT INTO personas(id,run_id,name,description) VALUES ('PER-1',1,'Careful buyers','They check twice.'); INSERT INTO segments(id,run_id,name,characteristic) VALUES ('SEG-1',1,'Cash on delivery users','They pay cash when it arrives.')");
  for (let i = 1; i <= 8; i++) {
    const p = `P${i}`;
    db.exec(`INSERT INTO participants VALUES ('${p}','S','{}','x'); INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('X${i}','S','${p}','interview','verbatim_transcript','t','x');
      INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X${i}','${p}','cod pe bharosa ${i}','I trust cash on delivery ${i}','said','participant_verbatim','cod','positive','approved','x')`);
    if (i <= 5) db.exec(`INSERT INTO persona_participants VALUES ('PER-1','${p}')`);
    if (i >= 4) db.exec(`INSERT INTO segment_participants VALUES ('SEG-1','${p}')`);
    upsertAttributes(db, p, { tier: i <= 6 ? "Tier 2" : "Tier 3", state: "Uttar Pradesh" }, "sheet");
  }
  db.exec(`INSERT INTO custom_audiences(id,name,filter_json,created_at) VALUES ('CUS-1','Tier 2 · Uttar Pradesh','${JSON.stringify({ tiers: ["Tier 2"], states: ["Uttar Pradesh"] })}','x')`);
  return db;
}
const ai = (seen: { prompt: string }) => new MockProvider((req) => {
  if (req.system.includes("search over")) return { keywords: ["cod"], broad: false, studies: [] };
  seen.prompt = req.prompt;
  const ids = [...req.prompt.matchAll(/#(\d+) \((P\d+),/g)].map((m) => Number(m[1]));
  return { reply: "Most of us trust paying on delivery.", label: "evidence", evidence_ids: ids, suggested_study: "" };
});

describe("talking to any audience", () => {
  it("finds personas, segments and audiences picked by details, and who is in each", () => {
    const db = seed();
    expect(latestPersona(db, "PER-1")).toMatchObject({ kind: "persona", name: "Careful buyers" });
    expect(latestPersona(db, "SEG-1")).toMatchObject({ kind: "segment", name: "Cash on delivery users", description: "They pay cash when it arrives." });
    expect(latestPersona(db, "CUS-1")).toMatchObject({ kind: "custom", description: "People who match: Tier 2 · Uttar Pradesh." });
    expect(latestPersona(db, "nope")).toBeNull();
    expect(membersOfAudience(db, latestPersona(db, "PER-1")!)).toHaveLength(5);
    expect(membersOfAudience(db, latestPersona(db, "SEG-1")!).sort()).toEqual(["P4", "P5", "P6", "P7", "P8"]);
    expect(membersOfAudience(db, latestPersona(db, "CUS-1")!).sort()).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
  });
  it("answers a segment or a picked audience from that group's own evidence only, and keeps each conversation apart", async () => {
    const db = seed(); const seen = { prompt: "" };
    for (const [id, inside, outside] of [["SEG-1", ["P4", "P8"], ["P1", "P2"]], ["CUS-1", ["P1", "P6"], ["P7", "P8"]]] as const) {
      const a = latestPersona(db, id)!;
      const m = await chatWithPersona(db, ai(seen), { userId: "u", persona: a, text: "do you trust cash on delivery?" });
      expect(m).toMatchObject({ from: "persona", label: "evidence" });
      for (const p of inside) expect(seen.prompt).toContain(`(${p},`);
      for (const p of outside) expect(seen.prompt).not.toContain(`(${p},`); // nobody outside the audience is quoted
      expect(conversation(db, "u", a)).toHaveLength(2);
    }
    expect(conversation(db, "u", latestPersona(db, "PER-1")!)).toHaveLength(0);
    expect(conversation(db, "u", latestPersona(db, "SEG-1")!)).toHaveLength(2);
  });
});

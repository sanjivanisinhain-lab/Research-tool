// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { enqueueExtractions, retryJob, runNextJob } from "../jobs";
import { MockProvider } from "../ai/provider";
import { chunkUtterances } from "../ai/extract";

function seed() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P1','S','{}','x');
    INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('X1','S','P1','cx_call','researcher_notes','t','x');
    INSERT INTO utterances(source_id,participant_id,speaker,seq,text) VALUES ('X1','P1','note',0,'He cancelled the order because the delivery was late.')`);
  enqueueExtractions(db);
  return db;
}
const job = (db: ReturnType<typeof seed>) => db.prepare("SELECT status, attempts, run_after, error FROM jobs").get() as { status: string; attempts: number; run_after: string | null; error: string | null };

describe("reading that fails is tried again by itself", () => {
  it("waits 3, 6, 12 then 24 minutes, runs again when due, and gives up after that", async () => {
    const db = seed();
    const bad = new MockProvider(() => { throw new Error("Gemini unavailable after retries"); });
    for (const minutes of [3, 6, 12, 24]) {
      expect(await runNextJob(db, bad)).toBe(true);
      const j = job(db);
      expect(j).toMatchObject({ status: "queued" }); expect(j.error).toMatch(new RegExp(`try again in ${minutes} minutes`));
      expect(Math.round((Date.parse(j.run_after!) - Date.now()) / 60_000)).toBe(minutes);
      expect(await runNextJob(db, bad)).toBe(false); // not due yet: nothing runs, nothing is hammered
      db.prepare("UPDATE jobs SET run_after=?").run(new Date(Date.now() - 1000).toISOString());
    }
    await runNextJob(db, bad);
    expect(job(db)).toMatchObject({ status: "failed", attempts: 4 });
    expect(retryJob(db, 1)).toBe(true); // a person can still start it again
    expect(job(db)).toMatchObject({ status: "queued", attempts: 0, run_after: null });
  });
  it("finishes normally when a later try works", async () => {
    const db = seed(); let n = 0;
    const flaky = new MockProvider(() => { if (n++ === 0) throw new Error("HTTP 503"); return { findings: [] }; });
    await runNextJob(db, flaky);
    expect(job(db).status).toBe("queued");
    db.prepare("UPDATE jobs SET run_after=NULL").run();
    await runNextJob(db, flaky);
    expect(job(db).status).toBe("done");
  });
});

describe("long transcripts are read in fewer, larger pieces", () => {
  it("fits a 30,000 character transcript in a handful of calls", () => {
    const utts = Array.from({ length: 300 }, (_, i) => ({ id: i, speaker: "participant", text: "x".repeat(100) }));
    const chunks = chunkUtterances(utts);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks.flat()).toHaveLength(300); // nothing is lost between pieces
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ingestCallsCsv } from "../ingest";
import { extractSource, isQuotedVerbatim, chunkUtterances } from "../ai/extract";
import { MockProvider } from "../ai/provider";

const CSV = `Name,City,Mobile Number,Product Name,Date,Status,Notes,Type of user,Payment type,Call duration
Asha Verma,Pune,9876543210,Blue Kurti,17-09-2026,Connected,"Prefers COD. She said ""pehle discount dekhta hoon, fir product"". Cancelled one order after delay.",Repeat,COD,3:20
`;

function setup() {
  const db = openDb(":memory:");
  ingestCallsCsv(db, CSV, { studyName: "Calls", product: "Shop" });
  const src = db.prepare("SELECT id FROM sources").get() as { id: string };
  const utt = db.prepare("SELECT id FROM utterances ORDER BY seq LIMIT 1").get() as { id: number };
  return { db, sourceId: src.id, uttId: utt.id };
}

describe("extraction integrity", () => {
  it("keeps verified quotes, drops invented ones, labels provenance", async () => {
    const { db, sourceId, uttId } = setup();
    const ai = new MockProvider(() => ({ findings: [
      { utterance_id: uttId, quote: "pehle discount dekhta hoon, fir product", translation: "I look at the discount first, then the product", kind: "said", theme: "Price First", sentiment: "positive" },
      { utterance_id: uttId, quote: "Cancelled one order after delay", kind: "did", theme: "delay cancellation", sentiment: "negative" },
      { utterance_id: uttId, quote: "She loves free shipping and fast delivery", kind: "said", theme: "invented", sentiment: "positive" },
    ] }));
    const res = await extractSource(db, ai, sourceId);
    expect(res).toMatchObject({ proposed: 3, kept: 2, droppedUnverified: 1, cached: false });
    const rows = db.prepare("SELECT original_text, provenance, status, theme FROM evidence ORDER BY id").all() as any[];
    expect(rows.map((r) => r.provenance)).toEqual(["participant_verbatim", "researcher_note"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows[0].theme).toBe("price first");
  });
  it("does not call the AI twice for the same source/model/prompt", async () => {
    const { db, sourceId } = setup();
    const ai = new MockProvider(() => ({ findings: [] }));
    await extractSource(db, ai, sourceId);
    const again = await extractSource(db, ai, sourceId);
    expect(again.cached).toBe(true);
    expect(ai.calls).toBe(1);
  });
  it("sends only redacted text to the provider", async () => {
    const { db, sourceId } = setup();
    let seen = "";
    await extractSource(db, new MockProvider((r) => { seen += r.prompt; return { findings: [] }; }), sourceId);
    expect(seen).not.toMatch(/Asha|Verma|Pune|9876543210/);
  });
  it("helpers", () => {
    expect(isQuotedVerbatim('She said "abc def" ok', "abc def")).toBe(true);
    expect(isQuotedVerbatim('She said "abc def" ok and more', "and more")).toBe(false);
    const u = [{ id: 1, speaker: "n", text: "a".repeat(5000) }, { id: 2, speaker: "n", text: "b".repeat(5000) }];
    expect(chunkUtterances(u).length).toBe(2);
  });
});

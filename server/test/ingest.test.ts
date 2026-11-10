// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ingestCallsCsv, ingestTranscript, parseSpeakerBlocks, parseLabelledTurns, detectLanguage } from "../ingest";
import { makeRedactor } from "../redact";

const CSV = `Name,City,Mobile Number,Product Name,Date,Status,Notes,Type of user,Payment type,Call duration
Asha Verma,Pune,9876543210,Blue Kurti,17-09-2026,Connected,"Asha ne bola ""pehle discount dekhta hoon"". Call back on 98765 43210. Rohit Sen ke baare mein bhi bataya, Pune se hai.",Repeat,COD,3:20
Rohit Sen,Kota,9123456780,Red Shoes,18-09-2026,Connected,"Order late aaya. Contact asha@example.com",New,Online,2:10
`;

describe("redaction", () => {
  it("removes names, phones, emails, cities", () => {
    const r = makeRedactor({ names: ["Asha Verma"], places: ["Pune"] });
    const out = r("Asha Verma from Pune, call 9876543210 or +91 98765-43210, mail a@b.com");
    expect(out.text).toBe("[NAME] from [CITY], call [PHONE] or [PHONE], mail [EMAIL]");
    expect(out.counts).toEqual({ names: 1, phones: 2, emails: 1, places: 1 });
  });
  it("handles Devanagari names", () => {
    const r = makeRedactor({ names: ["सीमा"], places: [] });
    expect(r("सीमा ने कहा").text).toBe("[NAME] ने कहा");
  });
});

describe("calls csv ingest", () => {
  it("stores no PII, assigns non-identifying IDs, keeps non-identifying metadata", () => {
    const db = openDb(":memory:");
    const res = ingestCallsCsv(db, CSV, { studyName: "Calls", product: "TestShop" });
    expect(res.sourcesAdded).toBe(2);
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM utterances").all(),
      db.prepare("SELECT * FROM participants").all(),
      db.prepare("SELECT * FROM sources").all(),
    ]);
    for (const pii of ["Asha", "Verma", "Rohit", "Sen", "Pune", "Kota", "9876543210", "98765", "9123456780", "example.com"]) {
      expect(dump).not.toContain(pii);
    }
    const p = db.prepare("SELECT id, meta_json FROM participants ORDER BY id").all() as { id: string; meta_json: string }[];
    expect(p.map((x) => x.id)).toEqual(["P001", "P002"]);
    expect(JSON.parse(p[0].meta_json)).toMatchObject({ user_type: "Repeat", payment_type: "COD" });
  });
  it("is idempotent: re-importing adds nothing and new data stays pending", () => {
    const db = openDb(":memory:");
    ingestCallsCsv(db, CSV, { studyName: "Calls", product: "TestShop" });
    const again = ingestCallsCsv(db, CSV, { studyName: "Calls", product: "TestShop" });
    expect(again.sourcesAdded).toBe(0);
    expect(again.sourcesSkipped).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM sources WHERE status!='pending'").get()).toEqual({ n: 0 });
  });
  it("keeps researcher notes distinct from verbatim transcripts", () => {
    const db = openDb(":memory:");
    ingestCallsCsv(db, CSV, { studyName: "Calls", product: "TestShop" });
    expect(db.prepare("SELECT DISTINCT origin FROM sources").all()).toEqual([{ origin: "researcher_notes" }]);
  });
});

describe("shared redaction terms", () => {
  it("redacts names learned from an earlier file in a later transcript", () => {
    const termsPath = path.join(os.tmpdir(), `terms-${Date.now()}.json`);
    const db = openDb(":memory:");
    ingestCallsCsv(db, CSV, { studyName: "Calls", product: "TestShop", termsPath });
    ingestTranscript(db, "Speaker A ............... 00:00:01\nnamaste Asha ji se baat ho rahi hai", { studyName: "Rec", product: "F", format: "speaker_blocks", termsPath });
    expect(JSON.stringify(db.prepare("SELECT text FROM utterances").all())).not.toMatch(/Asha/i);
    fs.rmSync(termsPath);
  });
});

describe("transcripts", () => {
  it("parses speaker blocks and labelled turns", () => {
    expect(parseSpeakerBlocks("Speaker A ............... 00:00:07\nhello\n\nSpeaker B ............... 00:00:09\nhi there")).toEqual([
      { speaker: "speaker_a", text: "hello" }, { speaker: "speaker_b", text: "hi there" },
    ]);
    expect(parseLabelledTurns("Interviewer: hi\nParticipant: haan\nmore")).toEqual([
      { speaker: "interviewer", text: "hi" }, { speaker: "participant", text: "haan more" },
    ]);
  });
  it("redacts known names, one participant per interview, flags noisy ASR", () => {
    const db = openDb(":memory:");
    const raw = "File 1\nInterviewer: hi Meera\nParticipant: haan Meera bol rahi hoon\nFile 2\nInterviewer: hello\nParticipant: theek hai";
    const res = ingestTranscript(db, raw, { studyName: "Gen Z", product: "Fashion", knownNames: ["Meera"], format: "labelled" });
    expect(res.participantsAdded).toBe(2);
    expect(JSON.stringify(db.prepare("SELECT text FROM utterances").all())).not.toContain("Meera");
    const noisy = ingestTranscript(db, "Speaker A ............... 00:00:01\nok", { studyName: "Rec", product: "F", format: "speaker_blocks", noisy: true });
    expect(noisy.sourcesAdded).toBe(1);
    expect(db.prepare("SELECT quality FROM sources WHERE quality IS NOT NULL").all()).toEqual([{ quality: "noisy_asr" }]);
  });
  it("detects language", () => {
    expect(detectLanguage("I like this very much")).toBe("en");
    expect(detectLanguage("mujhe yeh nahi chahiye kyunki main usko pasand nahi karti")).toBe("hinglish");
    expect(detectLanguage("मुझे यह बहुत पसंद है")).toBe("hi");
  });
});

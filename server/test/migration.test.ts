// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db";

describe("evidence table migration (screen_observation provenance)", () => {
  it("rebuilds an older database without losing evidence, links or search, and then accepts the new value", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-mig-")), "old.sqlite");
    // an older database: the evidence table as it was before the new provenance value existed
    const old = new DatabaseSync(file);
    old.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE studies (id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT, created_at TEXT NOT NULL);
      CREATE TABLE participants (id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE sources (id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), participant_id TEXT REFERENCES participants(id), source_type TEXT NOT NULL, origin TEXT NOT NULL, title TEXT NOT NULL, date TEXT, original_language TEXT NOT NULL DEFAULT 'hinglish', status TEXT NOT NULL DEFAULT 'pending', external_key TEXT UNIQUE, redaction_json TEXT NOT NULL DEFAULT '{}', quality TEXT, created_at TEXT NOT NULL);
      CREATE TABLE utterances (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, participant_id TEXT, speaker TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, participant_id TEXT NOT NULL REFERENCES participants(id), utterance_id INTEGER REFERENCES utterances(id),
        original_text TEXT NOT NULL, translation TEXT, kind TEXT NOT NULL CHECK (kind IN ('said','did')), provenance TEXT NOT NULL CHECK (provenance IN ('participant_verbatim','researcher_note')), theme TEXT NOT NULL,
        sentiment TEXT NOT NULL CHECK (sentiment IN ('positive','negative','neutral','mixed')), pain_point TEXT, need TEXT, job_to_be_done TEXT, emotion TEXT, flags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', review_note TEXT, created_at TEXT NOT NULL, UNIQUE (source_id, original_text));
      CREATE TABLE personas (id TEXT PRIMARY KEY, run_id INTEGER, name TEXT, description TEXT);
      CREATE TABLE persona_trait_evidence (trait_id INTEGER NOT NULL, evidence_id INTEGER NOT NULL REFERENCES evidence(id), PRIMARY KEY (trait_id, evidence_id));
      INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P1','S','{}','x');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('X','S','P1','cx_call','researcher_notes','t','x');
      INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,status,created_at) VALUES ('X','P1','delivery was late','said','participant_verbatim','delivery','negative','approved','x'),('X','P1','paid cash','did','researcher_note','payment','neutral','pending','x');
      INSERT INTO persona_trait_evidence VALUES (1,1),(1,2);`);
    old.close();

    const db = openDb(file); // migrates
    expect((db.prepare("SELECT COUNT(*) n FROM evidence").get() as any).n).toBe(2);
    expect(db.prepare("SELECT id,status FROM evidence ORDER BY id").all()).toEqual([{ id: 1, status: "approved" }, { id: 2, status: "pending" }]);
    expect((db.prepare("SELECT COUNT(*) n FROM persona_trait_evidence").get() as any).n).toBe(2); // links intact
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // the new provenance is accepted; the old values still work; nonsense is still refused
    db.exec("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,created_at) VALUES ('X','P1','The participant paused on the cart','did','screen_observation','cart','neutral','x')");
    expect(() => db.exec("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,created_at) VALUES ('X','P1','zzz','did','made_up','t','neutral','x')")).toThrow();
    // search still finds old and new rows (index rebuilt, triggers recreated)
    expect((db.prepare("SELECT COUNT(*) n FROM evidence_fts WHERE evidence_fts MATCH 'delivery'").get() as any).n).toBe(1);
    db.exec("INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,created_at) VALUES ('X','P1','checkout page opened','did','screen_observation','cart','neutral','x')");
    expect((db.prepare("SELECT COUNT(*) n FROM evidence_fts WHERE evidence_fts MATCH 'checkout'").get() as any).n).toBe(1);
    // running again is a no-op
    db.close(); openDb(file).close();
  });
});

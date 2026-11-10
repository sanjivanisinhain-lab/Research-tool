import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,              -- non-identifying, e.g. P018
  study_id TEXT NOT NULL REFERENCES studies(id),
  meta_json TEXT NOT NULL DEFAULT '{}', -- non-identifying attributes only (user type, payment type...)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id),
  participant_id TEXT REFERENCES participants(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('interview','cx_call','diary','usability','ab_test')),
  origin TEXT NOT NULL CHECK (origin IN ('verbatim_transcript','researcher_notes')),
  title TEXT NOT NULL,
  date TEXT,                         -- ISO
  original_language TEXT NOT NULL DEFAULT 'hinglish',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  external_key TEXT UNIQUE,          -- dedupe key for re-imports
  redaction_json TEXT NOT NULL DEFAULT '{}', -- counts only; never the removed values
  quality TEXT,                      -- e.g. 'noisy_asr'
  created_at TEXT NOT NULL
);
-- one row per speaker turn / note section, redacted text only
CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id),
  speaker TEXT NOT NULL,             -- participant | interviewer | note
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(text, content='utterances', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS utt_ai AFTER INSERT ON utterances BEGIN
  INSERT INTO utterances_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS utt_ad AFTER DELETE ON utterances BEGIN
  INSERT INTO utterances_fts(utterances_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT NOT NULL
);
`;

export function openDb(file = process.env.DB_PATH ?? "data/research.sqlite"): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function audit(db: Db, action: string, detail: unknown) {
  db.prepare("INSERT INTO audit_log(at, action, detail_json) VALUES (?,?,?)").run(
    new Date().toISOString(),
    action,
    JSON.stringify(detail),
  );
}

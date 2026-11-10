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
  db.exec(SCHEMA_V2);
  db.exec(SCHEMA_V3);
  migrateV4(db);
  db.exec(SCHEMA_V5);
  migrateV6(db);
  db.exec(SCHEMA_V7);
  db.exec(SCHEMA_V8);
  return db;
}

export function audit(db: Db, action: string, detail: unknown) {
  db.prepare("INSERT INTO audit_log(at, action, detail_json) VALUES (?,?,?)").run(
    new Date().toISOString(),
    action,
    JSON.stringify(detail),
  );
}

export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  utterance_id INTEGER REFERENCES utterances(id),
  original_text TEXT NOT NULL,       -- exact substring of a redacted utterance (verified server-side)
  translation TEXT,                  -- English, never presented as verbatim
  kind TEXT NOT NULL CHECK (kind IN ('said','did')),
  provenance TEXT NOT NULL CHECK (provenance IN ('participant_verbatim','researcher_note')),
  theme TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive','negative','neutral','mixed')),
  pain_point TEXT, need TEXT, job_to_be_done TEXT, emotion TEXT,
  flags TEXT NOT NULL DEFAULT '',    -- e.g. speaker_uncertain, noisy_asr
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, original_text)
);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON evidence(status);
CREATE TABLE IF NOT EXISTS extraction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  proposed INTEGER NOT NULL, kept INTEGER NOT NULL, dropped_unverified INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, model, prompt_version)  -- caching key: no repeat AI call for the same source/model/prompt
);
`;

export const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS synthesis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, model TEXT NOT NULL,
  includes_unreviewed INTEGER NOT NULL, evidence_count INTEGER NOT NULL, participant_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES synthesis_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, characteristic TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segment_participants (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE, participant_id TEXT NOT NULL REFERENCES participants(id),
  PRIMARY KEY (segment_id, participant_id)
);
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES synthesis_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published'))
);
CREATE TABLE IF NOT EXISTS persona_participants (
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE, participant_id TEXT NOT NULL REFERENCES participants(id),
  PRIMARY KEY (persona_id, participant_id)   -- one participant may belong to several personas
);
CREATE TABLE IF NOT EXISTS persona_traits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  trait_type TEXT NOT NULL CHECK (trait_type IN ('behaviour','need','pain_point','motivation','trust_barrier','job_to_be_done','trigger','gap')),
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_trait_evidence (
  trait_id INTEGER NOT NULL REFERENCES persona_traits(id) ON DELETE CASCADE, evidence_id INTEGER NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (trait_id, evidence_id)
);
`;

export const SCHEMA_V4 = `
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  original_text, translation, theme, canonical_theme, pain_point, need,
  content='evidence', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS ev_ai AFTER INSERT ON evidence BEGIN
  INSERT INTO evidence_fts(rowid, original_text, translation, theme, canonical_theme, pain_point, need)
  VALUES (new.id, new.original_text, new.translation, new.theme, new.canonical_theme, new.pain_point, new.need);
END;
CREATE TRIGGER IF NOT EXISTS ev_ad AFTER DELETE ON evidence BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, original_text, translation, theme, canonical_theme, pain_point, need)
  VALUES ('delete', old.id, old.original_text, old.translation, old.theme, old.canonical_theme, old.pain_point, old.need);
END;
CREATE TRIGGER IF NOT EXISTS ev_au AFTER UPDATE ON evidence BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, original_text, translation, theme, canonical_theme, pain_point, need)
  VALUES ('delete', old.id, old.original_text, old.translation, old.theme, old.canonical_theme, old.pain_point, old.need);
  INSERT INTO evidence_fts(rowid, original_text, translation, theme, canonical_theme, pain_point, need)
  VALUES (new.id, new.original_text, new.translation, new.theme, new.canonical_theme, new.pain_point, new.need);
END;
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, variant TEXT NOT NULL, audience_json TEXT NOT NULL,
  includes_unreviewed INTEGER NOT NULL DEFAULT 0, answer_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, team TEXT NOT NULL, area TEXT NOT NULL, note TEXT, name TEXT, updated_at TEXT NOT NULL
);
`;

/** Adds the canonical_theme column on databases created before it existed, then (re)builds the search index. */
/** Jobs gained a 'transcribe' kind, a payload and a progress note; SQLite can't alter a CHECK, so rebuild the table once. */
export function migrateV6(db: Db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as { sql: string } | undefined;
  if (row && !row.sql.includes("transcribe")) {
    db.exec(`ALTER TABLE jobs RENAME TO jobs_old;
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('extract','rebuild_audiences','transcribe')),
        source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
        error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, payload TEXT, note TEXT
      );
      INSERT INTO jobs(id,kind,source_id,status,error,created_at,started_at,finished_at) SELECT id,kind,source_id,status,error,created_at,started_at,finished_at FROM jobs_old;
      DROP TABLE jobs_old;
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);
  }
  const ucols = db.prepare("PRAGMA table_info(utterances)").all() as { name: string }[];
  if (!ucols.some((c) => c.name === "start_sec")) db.exec("ALTER TABLE utterances ADD COLUMN start_sec REAL");
  db.exec("CREATE TABLE IF NOT EXISTS media_hashes (sha256 TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, created_at TEXT NOT NULL)");
}

export const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, audience_json TEXT NOT NULL, includes_unreviewed INTEGER NOT NULL DEFAULT 0,
  assessment_json TEXT NOT NULL, image_path TEXT, image_mime TEXT, created_at TEXT NOT NULL
);
`;

export const SCHEMA_V8 = `
CREATE TABLE IF NOT EXISTS study_requests (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL UNIQUE REFERENCES answers(id),     -- one request per study plan
  title TEXT NOT NULL,
  plan_json TEXT NOT NULL,                                    -- snapshot of the plan when it was requested
  requester_json TEXT NOT NULL,                               -- role / team / area at the time (no contact details)
  note TEXT,                                                  -- what the requester wants the team to know
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','in_progress','done','declined')),
  team_note TEXT,                                             -- the research team's reply
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_requests_status ON study_requests(status);
`;

export function migrateV4(db: Db) {
  const srcCols = db.prepare("PRAGMA table_info(sources)").all() as { name: string }[];
  if (!srcCols.some((c) => c.name === "submitted_by")) db.exec("ALTER TABLE sources ADD COLUMN submitted_by TEXT NOT NULL DEFAULT 'research_team' CHECK (submitted_by IN ('research_team','contributor'))");
  const cols = db.prepare("PRAGMA table_info(evidence)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "canonical_theme")) db.exec("ALTER TABLE evidence ADD COLUMN canonical_theme TEXT");
  db.exec(SCHEMA_V4);
  db.exec("INSERT INTO evidence_fts(evidence_fts) VALUES('rebuild')");
}

export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('extract','rebuild_audiences')),
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`;

import type { Db } from "./db";
import { GeminiError, type AiProvider } from "./ai/provider";
import { dedupeAgainstSheets } from "./sheetsHub";
import { extractSources, sourceChars, SMALL_SOURCE_CHARS } from "./ai/extract";
import { canonicaliseThemes } from "./ai/themes";
import { needsPlainNames, plainNames, synthesise } from "./ai/personas";
import { fillAttributes, needsAttributes } from "./ai/attributes";
import { transcribeRecording, type TranscribePayload } from "./ai/transcribe";
import fs from "node:fs";
import path from "node:path";

/** Queue an extraction job for every source that has none yet (idempotent). */
export function enqueueExtractions(db: Db): number {
  // Sources read before the queue existed (e.g. via the command line) count as done.
  db.prepare(`INSERT INTO jobs(kind,source_id,status,created_at,finished_at) SELECT 'extract', s.id, 'done', ?, ? FROM sources s
    WHERE EXISTS (SELECT 1 FROM extraction_runs r WHERE r.source_id = s.id) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source_id = s.id AND j.kind='extract')`).run(new Date().toISOString(), new Date().toISOString());
  const r = db.prepare(`INSERT INTO jobs(kind,source_id,created_at) SELECT 'extract', s.id, ? FROM sources s
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source_id = s.id AND j.kind='extract' AND j.status IN ('queued','running','done'))`).run(new Date().toISOString());
  return Number(r.changes);
}
export function enqueueTranscription(db: Db, payload: TranscribePayload): number {
  return Number(db.prepare("INSERT INTO jobs(kind,payload,note,created_at) VALUES ('transcribe',?,'Waiting to start',?)").run(JSON.stringify(payload), new Date().toISOString()).lastInsertRowid);
}
export function enqueueRebuild(db: Db): number {
  const open = db.prepare("SELECT id FROM jobs WHERE kind='rebuild_audiences' AND status IN ('queued','running')").get() as { id: number } | undefined;
  if (open) return open.id;
  return Number(db.prepare("INSERT INTO jobs(kind,created_at) VALUES ('rebuild_audiences',?)").run(new Date().toISOString()).lastInsertRowid);
}
export function retryJob(db: Db, id: number): boolean {
  return Number(db.prepare("UPDATE jobs SET status='queued', error=NULL, started_at=NULL, finished_at=NULL, attempts=0, run_after=NULL WHERE id=? AND status='failed'").run(id).changes) > 0;
}
/** When Gemini's daily limit is used up nothing can be read until it resets. Jobs wait (without using up their tries) instead of failing one after another. */
let aiPause: { until: number; reason: string } | null = null;
export const getAiPause = () => (aiPause && aiPause.until > Date.now() ? { until: new Date(aiPause.until).toISOString(), reason: aiPause.reason } : null);
export const clearAiPause = () => { aiPause = null; };
/** Stop all background AI work for a while. Used when Gemini says today's free limit is gone, so nothing keeps asking. */
export const pauseAi = (reason: string) => { aiPause = { until: Date.now() + PAUSE_MINUTES * 60_000, reason }; };
export const PAUSE_MINUTES = 60;

/** After a failure (usually Gemini being busy or out of quota) a job waits and is tried again by itself: 3, 6, 12 then 24 minutes. */
export const RETRY_MINUTES = [3, 6, 12, 24];

/** What to do with a job that failed: wait and try again (3, 6, 12, 24 minutes), or stop when Gemini's daily limit is gone. */
function failJob(db: Db, job: { id: number; kind: string; attempts: number }, e: unknown) {
  const msg = (e as Error).message.slice(0, 300);
  if (e instanceof GeminiError && e.kind === "quota_day") { // not this job's fault: wait for the limit to reset, keep its tries
    pauseAi(msg);
    db.prepare("UPDATE jobs SET status='queued', run_after=?, error=?, started_at=NULL WHERE id=?").run(getAiPause()!.until, `${msg} (waiting)`, job.id);
    return;
  }
  const wait = job.kind === "transcribe" ? undefined : RETRY_MINUTES[job.attempts]; // recordings are expensive to send again: those wait for a person to retry
  if (wait !== undefined) db.prepare("UPDATE jobs SET status='queued', attempts=?, run_after=?, error=?, started_at=NULL WHERE id=?").run(job.attempts + 1, new Date(Date.now() + wait * 60_000).toISOString(), `${msg} (will try again in ${wait} minutes)`, job.id);
  else db.prepare("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?").run(msg, new Date().toISOString(), job.id);
}

/** Run the oldest queued job. Returns true if one ran. Short sources queued behind it are read in the same call. Jobs that die with the process are re-queued at startup. */
export async function runNextJob(db: Db, ai: AiProvider): Promise<boolean> {
  if (getAiPause()) return false; // see above
  const nowIso = new Date().toISOString();
  const job = db.prepare("SELECT id, kind, source_id, payload, attempts FROM jobs WHERE status='queued' AND (run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT 1").get(nowIso) as { id: number; kind: string; source_id: string | null; payload: string | null; attempts: number } | undefined;
  if (!job) return false;
  const batch = [job];
  if (job.kind === "extract" && sourceChars(db, job.source_id!) <= SMALL_SOURCE_CHARS) {
    // Most notes are short. Reading them one call each is what made the import crawl, so those waiting behind this one come along.
    let chars = sourceChars(db, job.source_id!);
    const more = db.prepare("SELECT id, kind, source_id, payload, attempts FROM jobs WHERE status='queued' AND kind='extract' AND id!=? AND (run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT 60").all(job.id, nowIso) as typeof batch;
    for (const j of more) { const n = sourceChars(db, j.source_id!); if (n > SMALL_SOURCE_CHARS || chars + n > 11000 || batch.length >= 12) continue; batch.push(j); chars += n; }
  }
  const started = new Date().toISOString();
  for (const j of batch) db.prepare("UPDATE jobs SET status='running', started_at=? WHERE id=?").run(started, j.id);
  try {
    if (job.kind === "extract") await extractSources(db, ai, batch.map((j) => j.source_id!));
    else if (job.kind === "transcribe") {
      const payload = JSON.parse(job.payload!) as TranscribePayload;
      if (!fs.existsSync(payload.path)) throw new Error("The uploaded recording is no longer available; please upload it again");
      const r = await transcribeRecording(db, ai, payload, (note) => db.prepare("UPDATE jobs SET note=? WHERE id=?").run(note, job.id));
      fs.rmSync(payload.path, { force: true }); // the recording is not kept once it has been transcribed
      db.prepare("UPDATE jobs SET note=? WHERE id=?").run(r.duplicate ? "Already imported" : `Transcribed ${r.turns} turns from ${r.chunks} part${r.chunks === 1 ? "" : "s"}`, job.id);
      enqueueExtractions(db);
    } else { await canonicaliseThemes(db, ai); await synthesise(db, ai); }
    for (const j of batch) db.prepare("UPDATE jobs SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), j.id);
  } catch (e) {
    for (const j of batch) failJob(db, j, e);
  }
  return true;
}

/** Remove stray recordings that no queued, running or failed job still needs. */
export function cleanupUploads(db: Db, dir: string, minAgeMs = 3_600_000) {
  if (!fs.existsSync(dir)) return;
  const needed = new Set((db.prepare("SELECT payload FROM jobs WHERE kind='transcribe' AND status IN ('queued','running','failed')").all() as { payload: string }[]).map((r) => (JSON.parse(r.payload) as TranscribePayload).path));
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!needed.has(full) && Date.now() - fs.statSync(full).mtimeMs > minAgeMs) fs.rmSync(full, { force: true });
  }
}

export function startWorker(db: Db, ai: AiProvider | null, intervalMs = 2000, uploadsDir?: string) {
  if (uploadsDir) cleanupUploads(db, uploadsDir);
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  enqueueExtractions(db); // pick up anything stored but never queued
  try { dedupeAgainstSheets(db); } catch (e) { console.warn(`Could not check for duplicates of the research sheet: ${(e as Error).message}`); } // earlier uploads of rows now in the sheet are taken out of answers
  if (!ai) { console.warn("No AI provider: queued jobs will wait until GEMINI_API_KEY is set."); return () => {}; }
  let busy = false; let lastNames = 0; let attrsWaitUntil = 0;
  const unread = () => !!db.prepare("SELECT 1 FROM jobs WHERE kind='extract' AND status IN ('queued','running') LIMIT 1").get();
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      while (await runNextJob(db, ai));
      if (getAiPause() || unread()) return; // the side jobs below wait until the reading is finished (or Gemini's limit is back): they must not use up what reading needs
      const quit = (what: string, e: unknown) => { if (e instanceof GeminiError && e.kind === "quota_day") pauseAi(e.message); console.warn(`Could not ${what} yet: ${(e as Error).message}`); };
      // Names of groups made before names were kept plain are fixed in the background, once, with no button to press. A failed try waits ten minutes.
      if (needsPlainNames(db) && Date.now() - lastNames > 600_000) { lastNames = Date.now(); try { await plainNames(db, ai); } catch (e) { quit("put audience names in plain words", e); } }
      // Details the sheet left blank are read from the notes, a few people at a time. A failed try waits five minutes.
      if (!getAiPause() && Date.now() > attrsWaitUntil && needsAttributes(db)) { try { await fillAttributes(db, ai); } catch (e) { attrsWaitUntil = Date.now() + 300_000; quit("read personal details from the notes", e); } }
    } finally { busy = false; }
  }, intervalMs);
  return () => clearInterval(t);
}

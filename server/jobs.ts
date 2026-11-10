import type { Db } from "./db";
import type { AiProvider } from "./ai/provider";
import { extractSource } from "./ai/extract";
import { canonicaliseThemes } from "./ai/themes";
import { synthesise } from "./ai/personas";

/** Queue an extraction job for every source that has none yet (idempotent). */
export function enqueueExtractions(db: Db): number {
  // Sources read before the queue existed (e.g. via the command line) count as done.
  db.prepare(`INSERT INTO jobs(kind,source_id,status,created_at,finished_at) SELECT 'extract', s.id, 'done', ?, ? FROM sources s
    WHERE EXISTS (SELECT 1 FROM extraction_runs r WHERE r.source_id = s.id) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source_id = s.id AND j.kind='extract')`).run(new Date().toISOString(), new Date().toISOString());
  const r = db.prepare(`INSERT INTO jobs(kind,source_id,created_at) SELECT 'extract', s.id, ? FROM sources s
    WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.source_id = s.id AND j.kind='extract' AND j.status IN ('queued','running','done'))`).run(new Date().toISOString());
  return Number(r.changes);
}
export function enqueueRebuild(db: Db): number {
  const open = db.prepare("SELECT id FROM jobs WHERE kind='rebuild_audiences' AND status IN ('queued','running')").get() as { id: number } | undefined;
  if (open) return open.id;
  return Number(db.prepare("INSERT INTO jobs(kind,created_at) VALUES ('rebuild_audiences',?)").run(new Date().toISOString()).lastInsertRowid);
}
export function retryJob(db: Db, id: number): boolean {
  return Number(db.prepare("UPDATE jobs SET status='queued', error=NULL, started_at=NULL, finished_at=NULL WHERE id=? AND status='failed'").run(id).changes) > 0;
}

/** Run the oldest queued job. Returns true if one ran. Jobs that die with the process are re-queued at startup. */
export async function runNextJob(db: Db, ai: AiProvider): Promise<boolean> {
  const job = db.prepare("SELECT id, kind, source_id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get() as { id: number; kind: string; source_id: string | null } | undefined;
  if (!job) return false;
  db.prepare("UPDATE jobs SET status='running', started_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  try {
    if (job.kind === "extract") await extractSource(db, ai, job.source_id!);
    else { await canonicaliseThemes(db, ai); await synthesise(db, ai); }
    db.prepare("UPDATE jobs SET status='done', finished_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  } catch (e) {
    db.prepare("UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?").run((e as Error).message.slice(0, 300), new Date().toISOString(), job.id);
  }
  return true;
}

export function startWorker(db: Db, ai: AiProvider | null, intervalMs = 2000) {
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  enqueueExtractions(db); // pick up anything stored but never queued
  if (!ai) { console.warn("No AI provider: queued jobs will wait until GEMINI_API_KEY is set."); return () => {}; }
  let busy = false;
  const t = setInterval(async () => { if (busy) return; busy = true; try { while (await runNextJob(db, ai)); } finally { busy = false; } }, intervalMs);
  return () => clearInterval(t);
}

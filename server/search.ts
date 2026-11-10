import type { Db } from "./db";

export type Hit = {
  id: number; participantId: string; sourceId: string; sourceType: string; date: string | null; language: string;
  quote: string; translation: string | null; kind: "said" | "did"; provenance: string; theme: string; sentiment: string; status: string; flags: string;
};

const STOP = new Set("the a an and or of to in on for is are was were be it this that with as at by from will would do does did how what why who which can could should may might not no yes if you your they their them we our i me my".split(" "));

/** Builds a safe FTS5 OR-query from free text (letters/digits only, quoted tokens). */
export function ftsQuery(terms: string[]): string {
  const toks = new Set<string>();
  for (const t of terms) for (const w of t.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) if (w.length >= 3 && !STOP.has(w)) toks.add(w);
  return [...toks].slice(0, 40).map((w) => `"${w}"`).join(" OR ");
}

export function searchEvidence(db: Db, opts: { terms: string[]; participants?: string[] | null; statuses: string[]; limit?: number }): Hit[] {
  const q = ftsQuery(opts.terms);
  if (!q) return [];
  const st = opts.statuses.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT e.id, e.participant_id AS participantId, e.source_id AS sourceId, s.source_type AS sourceType, s.date, s.original_language AS language,
            e.original_text AS quote, e.translation, e.kind, e.provenance, COALESCE(e.canonical_theme, e.theme) AS theme, e.sentiment, e.status, e.flags
     FROM evidence_fts f JOIN evidence e ON e.id = f.rowid JOIN sources s ON s.id = e.source_id
     WHERE evidence_fts MATCH ? AND e.status IN (${st}) ORDER BY bm25(evidence_fts) LIMIT ?`,
  ).all(q, ...opts.statuses, (opts.limit ?? 40) * 4) as Hit[];
  const allowed = opts.participants ? new Set(opts.participants) : null;
  return rows.filter((r) => !allowed || allowed.has(r.participantId)).slice(0, opts.limit ?? 40);
}

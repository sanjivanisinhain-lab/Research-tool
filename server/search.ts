import type { Db } from "./db";

export type Hit = {
  overview?: boolean; // true for items sampled as a general overview rather than matched to the question
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
  ).all(q, ...opts.statuses, (opts.limit ?? 40) * 4) as unknown as Hit[];
  const allowed = opts.participants ? new Set(opts.participants) : null;
  return rows.filter((r) => !allowed || allowed.has(r.participantId)).slice(0, opts.limit ?? 40);
}

export type ThemeLine = { theme: string; participants: number };

/** A theme-balanced sample of an audience's research, for broad questions ("what is typical behaviour?") that share few words with the evidence. */
export function overviewEvidence(db: Db, o: { participants?: string[] | null; statuses: string[]; preferStudyIds?: string[]; themes?: number; perTheme?: number }): { hits: Hit[]; themes: ThemeLine[] } {
  const st = o.statuses.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT e.id, e.participant_id AS participantId, e.source_id AS sourceId, s.source_type AS sourceType, s.date, s.original_language AS language, s.study_id AS studyId,
            e.original_text AS quote, e.translation, e.kind, e.provenance, COALESCE(e.canonical_theme, e.theme) AS theme, e.sentiment, e.status, e.flags
     FROM evidence e JOIN sources s ON s.id = e.source_id WHERE e.status IN (${st}) ORDER BY e.id`,
  ).all(...o.statuses) as unknown as (Hit & { studyId: string })[];
  const allowed = o.participants ? new Set(o.participants) : null;
  const prefer = new Set(o.preferStudyIds ?? []);
  const byTheme = new Map<string, { people: Set<string>; rows: (Hit & { studyId: string })[] }>();
  for (const r of rows) {
    if (allowed && !allowed.has(r.participantId)) continue;
    const t = byTheme.get(r.theme) ?? { people: new Set<string>(), rows: [] };
    t.people.add(r.participantId); t.rows.push(r); byTheme.set(r.theme, t);
  }
  const ranked = [...byTheme.entries()].sort((a, b) => b[1].people.size - a[1].people.size || a[0].localeCompare(b[0])).slice(0, o.themes ?? 12);
  const hits: Hit[] = []; const seen = new Set<number>();
  for (const [, t] of ranked) {
    // one quote per person, own words and the preferred study first
    const order = [...t.rows].sort((a, b) => Number(prefer.has(b.studyId)) - Number(prefer.has(a.studyId)) || Number(b.provenance === "participant_verbatim") - Number(a.provenance === "participant_verbatim") || a.id - b.id);
    const people = new Set<string>(); let n = 0;
    for (const r of order) {
      if (n >= (o.perTheme ?? 5)) break;
      if (people.has(r.participantId) || seen.has(r.id)) continue;
      people.add(r.participantId); seen.add(r.id); n++; hits.push({ ...r, overview: true });
    }
  }
  return { hits, themes: ranked.map(([theme, t]) => ({ theme, participants: t.people.size })) };
}

export function participantsOfStudies(db: Db, studyIds: string[]): string[] {
  if (!studyIds.length) return [];
  return (db.prepare(`SELECT id FROM participants WHERE study_id IN (${studyIds.map(() => "?").join(",")})`).all(...studyIds) as { id: string }[]).map((r) => r.id);
}

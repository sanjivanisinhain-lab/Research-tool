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

/** Best matches first. The audience is applied inside the search (so a small group is not crowded out by everyone else's evidence), and `perParticipant` caps how many items one person can fill, so the answer draws on as many different people as possible. */
export function searchEvidence(db: Db, opts: { terms: string[]; participants?: string[] | null; statuses: string[]; limit?: number; perParticipant?: number }): Hit[] {
  const q = ftsQuery(opts.terms);
  if (!q) return [];
  const limit = opts.limit ?? 40;
  const st = opts.statuses.map(() => "?").join(",");
  const members = opts.participants ?? null;
  if (members && !members.length) return [];
  const rows = db.prepare(
    `SELECT e.id, e.participant_id AS participantId, e.source_id AS sourceId, s.source_type AS sourceType, s.date, s.original_language AS language,
            e.original_text AS quote, e.translation, e.kind, e.provenance, COALESCE(e.canonical_theme, e.theme) AS theme, e.sentiment, e.status, e.flags
     FROM evidence_fts f JOIN evidence e ON e.id = f.rowid JOIN sources s ON s.id = e.source_id
     WHERE evidence_fts MATCH ? AND e.status IN (${st}) ${members ? "AND e.participant_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY bm25(evidence_fts) LIMIT ?`,
  ).all(q, ...opts.statuses, ...(members ? [JSON.stringify(members)] : []), opts.perParticipant ? limit * 8 : limit) as unknown as Hit[];
  if (!opts.perParticipant) return rows.slice(0, limit);
  const seen = new Map<string, number>(); const out: Hit[] = [];
  for (const r of rows) { const n = seen.get(r.participantId) ?? 0; if (n >= opts.perParticipant) continue; seen.set(r.participantId, n + 1); out.push(r); if (out.length >= limit) break; }
  return out;
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

/** One representative item for each person in the audience who is not in `skip`: their own words first, and a medium-length quote rather than a fragment. Used so a question about a whole group hears from the whole group. */
export function onePerPerson(db: Db, o: { participants?: string[] | null; skip: string[]; statuses: string[]; limit: number }): Hit[] {
  if (o.participants && !o.participants.length) return [];
  const st = o.statuses.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, participantId, sourceId, sourceType, date, language, quote, translation, kind, provenance, theme, sentiment, status, flags FROM (
       SELECT e.id, e.participant_id AS participantId, e.source_id AS sourceId, s.source_type AS sourceType, s.date, s.original_language AS language,
              e.original_text AS quote, e.translation, e.kind, e.provenance, COALESCE(e.canonical_theme, e.theme) AS theme, e.sentiment, e.status, e.flags,
              ROW_NUMBER() OVER (PARTITION BY e.participant_id ORDER BY (e.provenance='participant_verbatim') DESC, ABS(LENGTH(e.original_text) - 140), e.id) AS rn
       FROM evidence e JOIN sources s ON s.id = e.source_id
       WHERE e.status IN (${st}) ${o.participants ? "AND e.participant_id IN (SELECT value FROM json_each(?))" : ""} AND e.participant_id NOT IN (SELECT value FROM json_each(?))
     ) WHERE rn = 1 ORDER BY participantId LIMIT ?`,
  ).all(...o.statuses, ...(o.participants ? [JSON.stringify(o.participants)] : []), JSON.stringify(o.skip), o.limit) as unknown as Hit[];
  return rows.map((r) => ({ ...r, overview: true }));
}

export function participantsOfStudies(db: Db, studyIds: string[]): string[] {
  if (!studyIds.length) return [];
  return (db.prepare(`SELECT id FROM participants WHERE study_id IN (${studyIds.map(() => "?").join(",")})`).all(...studyIds) as { id: string }[]).map((r) => r.id);
}

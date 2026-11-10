import type { Db } from "../db";
import type { AiProvider } from "./provider";

const SYS = `You merge near-duplicate research theme labels into a small canonical vocabulary.
Labels are short English phrases from user-research evidence about online shopping in India. Merge labels that mean the same thing (e.g. "payment preference", "payment method preference", "payment mode"). Keep distinct concepts separate. Canonical labels: 2-3 lowercase words. Return a mapping for EVERY input label.`;
const SCHEMA = { type: "OBJECT", properties: { mapping: { type: "ARRAY", items: { type: "OBJECT", properties: { theme: { type: "STRING" }, canonical: { type: "STRING" } }, required: ["theme", "canonical"] } } }, required: ["mapping"] };

/** Assigns evidence.canonical_theme. Only theme labels (no quotes, no personal data) are sent to the AI. */
export async function canonicaliseThemes(db: Db, ai: AiProvider, batchSize = 120): Promise<{ themes: number; canonical: number }> {
  const rows = db.prepare("SELECT theme, COUNT(*) n FROM evidence WHERE canonical_theme IS NULL GROUP BY theme ORDER BY n DESC").all() as { theme: string; n: number }[];
  const vocab = new Set((db.prepare("SELECT DISTINCT canonical_theme c FROM evidence WHERE canonical_theme IS NOT NULL").all() as { c: string }[]).map((r) => r.c));
  const upd = db.prepare("UPDATE evidence SET canonical_theme=? WHERE theme=? AND canonical_theme IS NULL");
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((r) => r.theme);
    const out = await ai.generateJson<{ mapping: { theme: string; canonical: string }[] }>({
      system: SYS, schema: SCHEMA,
      prompt: `Existing canonical labels (reuse where they fit): ${[...vocab].join(", ") || "(none yet)"}\n\nLabels to map:\n${batch.join("\n")}`,
    });
    const known = new Set(batch);
    for (const m of out.mapping ?? []) {
      const canon = m.canonical.trim().toLowerCase();
      if (!known.has(m.theme) || !canon) continue; // ignore labels the model made up
      upd.run(canon, m.theme); vocab.add(canon);
    }
    for (const t of batch) upd.run(t, t); // anything unmapped keeps its own label
  }
  return { themes: rows.length, canonical: (db.prepare("SELECT COUNT(DISTINCT canonical_theme) n FROM evidence").get() as { n: number }).n };
}

import type { Db } from "../db";
import type { AudienceRef, Implications, Role } from "../../src/types/research";

export const ROLES: Role[] = ["designer", "researcher", "pm", "marketing", "cx", "other"];
export const emptyImps = (): Implications => Object.fromEntries(ROLES.map((r) => [r, { keep: "—", change: "—", watch: "—" }])) as Implications;

export function audienceParticipants(db: Db, audience: AudienceRef[]): string[] | null {
  if (!audience.length) return null; // everyone
  const out = new Set<string>();
  for (const a of audience) {
    const sql = a.kind === "persona" ? "SELECT participant_id p FROM persona_participants WHERE persona_id=?" : "SELECT participant_id p FROM segment_participants WHERE segment_id=?";
    for (const r of db.prepare(sql).all(a.id) as { p: string }[]) out.add(r.p);
  }
  return [...out]; // union of distinct participants, never summed
}

/** Direction label -> sign used when labelling evidence as supporting or contradicting. */
export const mainSignal = (label?: "Positive" | "Negative" | "Mixed"): "positive" | "negative" => (label === "Negative" ? "negative" : "positive");

// Fills in details a sheet left blank (age, tier, state, gender, how they pay, new or repeat) from what the researchers wrote.
// Only details the text states plainly about the person themselves are kept, and each needs an exact quote from the text.
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { normaliseAge, normaliseCustomer, normaliseGender, normalisePayment, normaliseState, normaliseTier, upsertAttributes, type Attrs } from "../attributes";

const SYS = `You read research notes or interview text about several different people, and report personal details ONLY when the text states them plainly about that person.
Details: age (a number of years), tier (Tier 1, Tier 2 or Tier 3 city), state (an Indian state), gender (male or female), payment (cod, prepaid or both: how this person usually pays), customer (new for a first-time user, repeat for someone who has ordered before).
Rules:
- Use only the text given for that person. Never guess, infer from a name or a product, or use outside knowledge.
- For each detail you report, also copy a short exact quote from the text that states it. If the text does not state it clearly, answer unknown (age: 0).
- Details about other people (a spouse, a child, an interviewer) are not about this person.`;
const val = (values: string[]) => ({ type: "STRING", enum: [...values, "unknown"] });
const SCHEMA = { type: "OBJECT", properties: { people: { type: "ARRAY", items: { type: "OBJECT", properties: {
  id: { type: "STRING" }, age: { type: "INTEGER" }, age_quote: { type: "STRING" }, tier: val(["Tier 1", "Tier 2", "Tier 3"]), tier_quote: { type: "STRING" }, state: { type: "STRING" }, state_quote: { type: "STRING" },
  gender: val(["male", "female"]), gender_quote: { type: "STRING" }, payment: val(["cod", "prepaid", "both"]), payment_quote: { type: "STRING" }, customer: val(["new", "repeat"]), customer_quote: { type: "STRING" },
}, required: ["id"] } } }, required: ["people"] };
type Out = { people: { id: string; age?: number; age_quote?: string; tier?: string; tier_quote?: string; state?: string; state_quote?: string; gender?: string; gender_quote?: string; payment?: string; payment_quote?: string; customer?: string; customer_quote?: string }[] };

const MISSING = "(a.participant_id IS NULL OR (a.ai_checked_at IS NULL AND (a.age IS NULL OR a.tier IS NULL OR a.state IS NULL OR a.gender IS NULL OR a.payment IS NULL OR a.customer IS NULL)))";
const HAS_TEXT = "EXISTS (SELECT 1 FROM sources s JOIN utterances u ON u.source_id=s.id WHERE s.participant_id=p.id AND s.status!='rejected')";
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function needsAttributes(db: Db): boolean {
  return !!db.prepare(`SELECT 1 FROM participants p LEFT JOIN participant_attributes a ON a.participant_id=p.id WHERE ${HAS_TEXT} AND ${MISSING} LIMIT 1`).get();
}

/** A detail is kept only when its quote really is in the text and says what the detail says. */
export function verify(text: string, o: Out["people"][number]): Partial<Attrs> {
  const hay = squash(text); const quoted = (q?: string) => { const s = squash(q ?? ""); return s.length >= 3 && hay.includes(s) ? s : null; };
  const out: Partial<Attrs> = {};
  const aq = quoted(o.age_quote), age = normaliseAge(o.age);
  if (aq && age && new RegExp(`\\b${age}\\b`).test(aq) && /\b(age|aged|years?|yrs?|y\/o|old)\b/.test(aq)) out.age = age;
  const tq = quoted(o.tier_quote), tier = normaliseTier(o.tier);
  if (tq && tier && (new RegExp(`tier[\\s-]*${tier.slice(-1)}\\b`).test(tq) || (tier === "Tier 1" && /\bmetro\b/.test(tq)))) out.tier = tier;
  const sq = quoted(o.state_quote), state = normaliseState(o.state);
  if (sq && state && (sq.includes(state.toLowerCase()) || [...sq.matchAll(/[a-z&]{2,}/g)].some((m) => normaliseState(m[0]) === state && m[0].length >= 3))) out.state = state;
  const gq = quoted(o.gender_quote), g = normaliseGender(o.gender);
  if (gq && g === "male" && /\b(male|man|boy|gentleman)\b/.test(gq)) out.gender = "male";
  if (gq && g === "female" && /\b(female|woman|girl|lady)\b/.test(gq)) out.gender = "female";
  const pq = quoted(o.payment_quote), pay = normalisePayment(o.payment);
  if (pq && pay && normalisePayment(pq) === pay) out.payment = pay;
  const cq = quoted(o.customer_quote), cu = normaliseCustomer(o.customer);
  if (cq && cu && normaliseCustomer(cq) === cu) out.customer = cu;
  return out;
}

/** Read the notes of up to `batch` people who still have blanks. Returns how many details were added. */
export async function fillAttributes(db: Db, ai: AiProvider, batch = 6): Promise<{ people: number; added: number }> {
  const ids = (db.prepare(`SELECT p.id FROM participants p LEFT JOIN participant_attributes a ON a.participant_id=p.id WHERE ${HAS_TEXT} AND ${MISSING} ORDER BY p.id LIMIT ?`).all(batch) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { people: 0, added: 0 };
  const texts = new Map<string, string>();
  for (const id of ids) {
    // typed notes first (they carry the profile lines), then transcripts
    const rows = db.prepare(`SELECT u.text t FROM utterances u JOIN sources s ON s.id=u.source_id WHERE s.participant_id=? AND s.status!='rejected' ORDER BY CASE s.origin WHEN 'researcher_notes' THEN 0 ELSE 1 END, s.id, u.seq`).all(id) as { t: string }[];
    texts.set(id, rows.map((r) => r.t).join("\n").slice(0, 7000));
  }
  const out = await ai.generateJson<Out>({ system: SYS, schema: SCHEMA, prompt: ids.map((id) => `=== PERSON ${id} ===\n${texts.get(id)}`).join("\n\n") });
  let added = 0; const now = new Date().toISOString();
  for (const o of out.people ?? []) {
    if (!texts.has(o.id)) continue; // an invented id is ignored
    added += upsertAttributes(db, o.id, verify(texts.get(o.id)!, o), "notes");
  }
  for (const id of ids) { // checked, even if nothing was found: not asked again until the text changes
    db.prepare("INSERT INTO participant_attributes(participant_id, ai_checked_at, updated_at) VALUES (?,?,?) ON CONFLICT(participant_id) DO UPDATE SET ai_checked_at=excluded.ai_checked_at").run(id, now, now);
  }
  audit(db, "attributes.filled", { people: ids.length, added });
  return { people: ids.length, added };
}

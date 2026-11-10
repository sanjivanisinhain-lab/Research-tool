import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { ftsQuery, searchEvidence, type Hit } from "../search";
import type { ChatMessage, ClaimLabel } from "../../src/types/research";

const SYS = `You write a short reply as a PERSON WHO MATCHES a research-derived persona, answering a product team's question. This is a simulation of a behavioural pattern, NOT a real individual.
Hard rules:
- Use ONLY the persona profile and the numbered evidence below. Never use outside knowledge. Never invent personal details (name, age, job, family, city, income, specific past events, dates, prices, quantities). Speak about habits and attitudes that the evidence shows.
- First person ("I", "people like me", "some of us") is fine, but it must read as a pattern from the research, not a biography.
- If the evidence is mixed or split, say so honestly ("some of us ... others ..."). Do not smooth it into one view.
- Do not simply agree with the question. If it presumes something the evidence does not support, say what the evidence does show.
- If the evidence does not address the question, set label "no_evidence", say plainly in first person that nothing in the research tells you, and fill suggested_study with one sentence on what to ask real users. A "no_evidence" reply contains ONLY that statement: add no other claims, no related findings, and no evidence_ids.
- Mirror the language of the user's message: if they write Hinglish or Hindi use light Roman-script Hinglish, otherwise English. 1 to 4 sentences.
- label: "evidence" when the reply rests directly on the cited evidence; "inference" when you go beyond it (then say so in the reply, e.g. "I'd guess...").
- evidence_ids: the numbers you relied on, from the list ONLY.`;
const SCHEMA = { type: "OBJECT", properties: { reply: { type: "STRING" }, label: { type: "STRING", enum: ["evidence", "inference", "no_evidence"] }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } }, suggested_study: { type: "STRING" } }, required: ["reply", "label", "evidence_ids"] };
const SYS_INTENT = `You prepare a search over a user-research evidence store (Hindi, Hinglish and English; online shopping in India). Return 8-16 short search keywords/phrases: English AND likely Hinglish words for what the message is about. If the message is a short follow-up (like "why?"), use the earlier message for context.`;
const SCHEMA_INTENT = { type: "OBJECT", properties: { keywords: { type: "ARRAY", items: { type: "STRING" } } }, required: ["keywords"] };

export type PersonaRow = { id: string; name: string; description: string };
type Raw = { reply: string; label: ClaimLabel; evidence_ids: number[]; suggested_study?: string };
const MIN_PARTICIPANTS = 3;

/** Numbers (prices, counts, durations) in a reply that appear nowhere in the evidence or profile: a sign of invented specifics. */
export function unsupportedNumbers(reply: string, sources: string[]): string[] {
  const haystack = sources.join(" ").toLowerCase();
  const nums = reply.match(/\d[\d,.]*/g) ?? [];
  return nums.filter((n) => { const clean = n.replace(/[,.]+$/, ""); return clean.length > 0 && !haystack.includes(clean.toLowerCase()); });
}

/** The first sentence of a reply (handles the Hindi danda). A "no evidence" reply keeps only this: the refusal, with no uncited extras. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?\u0964](?=\s|$)/.exec(t);
  return (m ? m[0] : t).trim();
}

export function latestPersona(db: Db, id: string): PersonaRow | null {
  return (db.prepare("SELECT p.id, p.name, p.description FROM personas p WHERE p.id=?").get(id) as PersonaRow | undefined) ?? null;
}

const toMessage = (r: { id: string; sender: string; text: string; label: ClaimLabel | null; evidence_json: string; suggested_study: string | null }): ChatMessage =>
  r.sender === "user" ? { id: r.id, from: "user", text: r.text }
    : { id: r.id, from: "persona", text: r.text, ...(r.label ? { label: r.label } : {}), evidenceIds: JSON.parse(r.evidence_json) as string[], ...(r.suggested_study ? { suggestedStudy: r.suggested_study } : {}) };

export function conversation(db: Db, userId: string, persona: PersonaRow): ChatMessage[] {
  const rows = db.prepare("SELECT id,sender,text,label,evidence_json,suggested_study FROM persona_messages WHERE user_id=? AND (persona_id=? OR persona_name=?) ORDER BY created_at, rowid LIMIT 200").all(userId, persona.id, persona.name) as any[];
  return rows.map(toMessage);
}

export async function chatWithPersona(db: Db, ai: AiProvider, o: { userId: string; persona: PersonaRow; text: string; includeUnreviewed?: boolean }): Promise<ChatMessage> {
  const statuses = o.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = (db.prepare("SELECT participant_id p FROM persona_participants WHERE persona_id=?").all(o.persona.id) as { p: string }[]).map((r) => r.p);
  const history = conversation(db, o.userId, o.persona).slice(-6);
  const lastUser = [...history].reverse().find((m) => m.from === "user")?.text;
  const save = (sender: "user" | "persona", text: string, extra: { label?: ClaimLabel; evidenceIds?: string[]; study?: string } = {}) => {
    const id = "m-" + crypto.randomBytes(5).toString("hex");
    db.prepare("INSERT INTO persona_messages(id,user_id,persona_id,persona_name,sender,text,label,evidence_json,suggested_study,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, o.userId, o.persona.id, o.persona.name, sender, text, extra.label ?? null, JSON.stringify(extra.evidenceIds ?? []), extra.study ?? null, new Date().toISOString());
    return id;
  };
  save("user", o.text);

  const intent = await ai.generateJson<{ keywords: string[] }>({ system: SYS_INTENT, schema: SCHEMA_INTENT, prompt: `${lastUser ? `Earlier message: ${lastUser}\n` : ""}Message: ${o.text}` });
  const own = [o.text, ...(intent.keywords ?? [])];
  const hits: Hit[] = searchEvidence(db, { terms: ftsQuery(own) ? own : [lastUser ?? ""], participants: members, statuses, limit: 25 });

  const reply = (text: string, label: ClaimLabel, ids: string[], study?: string): ChatMessage => {
    const id = save("persona", text, { label, evidenceIds: ids, ...(study ? { study } : {}) });
    audit(db, "persona_chat", { persona: o.persona.id, by: o.userId, label, cited: ids.length });
    return { id, from: "persona", text, label, evidenceIds: ids, ...(study ? { suggestedStudy: study } : {}) };
  };
  const noEvidence = () => reply("I can't tell you that from the research. Nothing in what people like me said covers it, and I'd rather not make something up.", "no_evidence", [], `Ask participants in this group directly: “${o.text.slice(0, 160)}”`);
  if (!hits.length) return noEvidence();

  const traits = db.prepare("SELECT trait_type t, text FROM persona_traits WHERE persona_id=?").all(o.persona.id) as { t: string; text: string }[];
  const byId = new Map(hits.map((h) => [h.id, h]));
  const raw = await ai.generateJson<Raw>({ system: SYS, schema: SCHEMA,
    prompt: `Persona: ${o.persona.name}. ${o.persona.description}\nProfile (research-derived):\n${traits.map((t) => `- [${t.t}] ${t.text}`).join("\n") || "(none)"}\n\n` +
      `Conversation so far:\n${history.map((m) => `${m.from === "user" ? "Team" : "Persona"}: ${m.text}`).join("\n") || "(start)"}\n\nQuestion from the team: ${o.text}\n\nEvidence:\n` +
      hits.map((h) => `#${h.id} (${h.participantId}, ${h.kind}) ${h.translation ?? h.quote}`).join("\n") });

  const ids = [...new Set(raw.evidence_ids ?? [])].filter((i) => byId.has(i));
  const people = new Set(ids.map((i) => byId.get(i)!.participantId)).size;
  let label: ClaimLabel = raw.label;
  if (label === "no_evidence") return reply(firstSentence(raw.reply), "no_evidence", [], raw.suggested_study?.trim() || `Ask participants in this group directly: “${o.text.slice(0, 160)}”`);
  // Integrity: "evidence" needs real citations from several different people, and no invented numbers.
  if (label === "evidence" && (people < MIN_PARTICIPANTS || unsupportedNumbers(raw.reply, [...ids.map((i) => `${byId.get(i)!.translation ?? ""} ${byId.get(i)!.quote}`), o.persona.description, ...traits.map((t) => t.text)]).length)) label = "inference";
  const study = label === "inference" ? (raw.suggested_study?.trim() || "Validate this with a short study: it goes beyond what the existing research shows.") : undefined;
  return reply(raw.reply, label, ids.map(String), study);
}

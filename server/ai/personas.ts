import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";

type Ev = { id: number; participant_id: string; kind: string; theme: string; sentiment: string; translation: string | null; original_text: string; pain_point: string | null; need: string | null };
type Cluster = { name: string; description: string; participants: string[] };
type Proposal = { segments: (Cluster & { characteristic: string })[]; personas: Cluster[] };
type TraitOut = { traits: { type: string; text: string; evidence_ids: number[] }[] };

const TRAIT_TYPES = ["behaviour", "need", "pain_point", "motivation", "trust_barrier", "job_to_be_done", "trigger", "gap"];
const hid = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

/** Names are the first thing people see. They are read by product, design and marketing staff, not researchers. */
const PLAIN_NAME = `Name each group in plain, everyday words that say who the people are or what they do, so a non-researcher understands it at a glance, for example "Pay cash on delivery because they don't trust paying first" or "First-time buyers who check everything twice". 2 to 6 words. Avoid jargon such as cohort, archetype, mindset, journey, friction, value-driven, persona, segment, leverage.`;

const SYS_TRAITS = `You write evidence-backed traits for ONE persona. Use ONLY the numbered evidence given.
- Each trait: type (behaviour, need, pain_point, motivation, trust_barrier, job_to_be_done, trigger, gap), one plain sentence, and evidence_ids drawn ONLY from the list given (at least 2 ids from different participants where possible).
- Do not state anything the evidence does not support. Use type "gap" for important things the evidence does NOT tell us.
- 8-14 traits total, covering several types.`;

const SYS_DEFINE = `You define user SEGMENTS and PERSONAS strictly from the research digest given. Never use outside knowledge.
- Segment = a group of participants sharing a describable characteristic (how they pay, lifecycle stage, why they left, how they discover products...). Segments must distinguish some participants from others.
- Persona = a behavioural profile (needs, motivations, barriers).
- ${PLAIN_NAME}
- The digest mixes studies (Snapdeal CX calls and fashion-shopping interviews); do not assume one platform. Do not invent demographics.
- Together the personas must cover most participants in EVERY study listed in the digest: include personas that fit the fashion/Gen Z interview participants as well as the Snapdeal CX callers, and make descriptions general enough to fit several participants.
- Propose 5-7 segments and 5-7 personas. Give names and descriptions only; membership is assigned separately.`;
const SYS_ASSIGN = `Assign each participant to the segments and personas they genuinely fit, using ONLY their digest line. A participant may fit several personas and several segments, or none. Use the exact names given. Aim for every participant to fit at least one persona when their digest reasonably supports it, but never stretch: leave a participant out if the digest does not support the fit.`;
const SCHEMA_DEFINE = { type: "OBJECT", properties: {
  segments: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, characteristic: { type: "STRING" } }, required: ["name", "characteristic"] } },
  personas: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, description: { type: "STRING" } }, required: ["name", "description"] } },
}, required: ["segments", "personas"] };
const idArr = { type: "ARRAY", items: { type: "STRING" } };
const SCHEMA_ASSIGN = { type: "OBJECT", properties: { assignments: { type: "ARRAY", items: { type: "OBJECT", properties: { participant_id: { type: "STRING" }, segments: idArr, personas: idArr }, required: ["participant_id", "segments", "personas"] } } }, required: ["assignments"] };
type Defs = { segments: { name: string; characteristic: string }[]; personas: { name: string; description: string }[] };
type Assign = { assignments: { participant_id: string; segments: string[]; personas: string[] }[] };
const SCHEMA_TRAITS = { type: "OBJECT", properties: { traits: { type: "ARRAY", items: { type: "OBJECT", properties: {
  type: { type: "STRING", enum: TRAIT_TYPES }, text: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["type", "text", "evidence_ids"] } } }, required: ["traits"] };

export type SynthOpts = { includePending?: boolean; minMembers?: number };
export type SynthResult = { runId: number; segments: number; personas: number; traitsKept: number; traitsDropped: number; includesUnreviewed: boolean };

export async function synthesise(db: Db, ai: AiProvider, opts: SynthOpts = {}): Promise<SynthResult> {
  const statuses = opts.includePending ? ["approved", "pending"] : ["approved"];
  const ev = db.prepare(`SELECT id,participant_id,kind,COALESCE(canonical_theme,theme) AS theme,sentiment,translation,original_text,pain_point,need FROM evidence WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`).all(...statuses) as Ev[];
  if (!ev.length) throw new Error("No approved evidence to synthesise from. Approve evidence in the review queue first.");
  const byP = new Map<string, Ev[]>();
  for (const e of ev) byP.set(e.participant_id, [...(byP.get(e.participant_id) ?? []), e]);
  const metaOf = (pid: string) => JSON.parse((db.prepare("SELECT meta_json m FROM participants WHERE id=?").get(pid) as { m: string }).m) as Record<string, string>;
  const studyOf = (pid: string) => (db.prepare("SELECT s.name n FROM participants p JOIN studies s ON s.id=p.study_id WHERE p.id=?").get(pid) as { n: string }).n;

  const digest = [...byP].map(([pid, list]) => {
    const m = metaOf(pid); const meta = [m.user_type, m.payment_type].filter(Boolean).join("|");
    const themes = [...new Set(list.map((e) => `${e.theme}(${e.sentiment[0]})`))].slice(0, 10).join("; ");
    return `${pid} [${studyOf(pid)}${meta ? " | " + meta : ""}]: ${themes}`;
  }).join("\n");

  const defs = await ai.generateJson<Defs>({ system: SYS_DEFINE, schema: SCHEMA_DEFINE, prompt: `Research digest (${byP.size} participants):\n${digest}` });
  const segNames = new Set((defs.segments ?? []).map((x) => x.name)), perNames = new Set((defs.personas ?? []).map((x) => x.name));
  const segMembers = new Map<string, Set<string>>([...segNames].map((n) => [n, new Set<string>()]));
  const perMembers = new Map<string, Set<string>>([...perNames].map((n) => [n, new Set<string>()]));
  const lines = digest.split("\n");
  for (let i = 0; i < lines.length; i += 20) {
    const out = await ai.generateJson<Assign>({ system: SYS_ASSIGN, schema: SCHEMA_ASSIGN,
      prompt: `Segments:\n${defs.segments.map((x) => `- ${x.name}: ${x.characteristic}`).join("\n")}\n\nPersonas:\n${defs.personas.map((x) => `- ${x.name}: ${x.description}`).join("\n")}\n\nParticipants:\n${lines.slice(i, i + 20).join("\n")}` });
    for (const a of out.assignments ?? []) {
      if (!byP.has(a.participant_id)) continue; // ignore invented participant ids
      for (const n of a.segments ?? []) segMembers.get(n)?.add(a.participant_id);
      for (const n of a.personas ?? []) perMembers.get(n)?.add(a.participant_id);
    }
  }
  const proposal = {
    segments: defs.segments.map((x) => ({ name: x.name, characteristic: x.characteristic, description: x.characteristic, participants: [...(segMembers.get(x.name) ?? [])] })),
    personas: defs.personas.map((x) => ({ name: x.name, description: x.description, participants: [...(perMembers.get(x.name) ?? [])] })),
  };
  const min = opts.minMembers ?? 3;
  const valid = (c: Cluster) => [...new Set(c.participants)].filter((p) => byP.has(p));
  const run = db.prepare("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), ai.model, opts.includePending ? 1 : 0, ev.length, byP.size);
  const runId = Number(run.lastInsertRowid);
  let nSeg = 0, nPer = 0, kept = 0, dropped = 0;

  for (const s of proposal.segments ?? []) {
    const members = valid(s);
    if (members.length < min || (byP.size >= 10 && members.length > 0.85 * byP.size)) continue; // a segment of (nearly) everyone says nothing
    const id = `SEG-${hid(runId + s.name)}`;
    db.prepare("INSERT INTO segments(id,run_id,name,characteristic,plain_name) VALUES (?,?,?,?,1)").run(id, runId, s.name, s.characteristic);
    for (const p of members) db.prepare("INSERT OR IGNORE INTO segment_participants VALUES (?,?)").run(id, p);
    nSeg++;
  }
  for (const c of proposal.personas ?? []) {
    const members = valid(c); if (members.length < min) continue;
    const memberSet = new Set(members);
    const pool = ev.filter((e) => memberSet.has(e.participant_id)).slice(0, 140);
    const poolIds = new Set(pool.map((e) => e.id));
    const out = await ai.generateJson<TraitOut>({ system: SYS_TRAITS, schema: SCHEMA_TRAITS,
      prompt: `Persona: ${c.name} — ${c.description}\nEvidence:\n` + pool.map((e) => `#${e.id} (${e.participant_id}, ${e.kind}) ${e.translation ?? e.original_text}`).join("\n") });
    const id = `PER-${hid(runId + c.name)}`;
    db.prepare("INSERT INTO personas(id,run_id,name,description,plain_name) VALUES (?,?,?,?,1)").run(id, runId, c.name, c.description);
    for (const p of members) db.prepare("INSERT OR IGNORE INTO persona_participants VALUES (?,?)").run(id, p);
    for (const t of out.traits ?? []) {
      const ids = [...new Set(t.evidence_ids)].filter((i) => poolIds.has(i));
      // Integrity: a trait without verified supporting evidence is dropped, except explicit "gap" traits.
      if (!TRAIT_TYPES.includes(t.type) || (!ids.length && t.type !== "gap")) { dropped++; continue; }
      const tr = db.prepare("INSERT INTO persona_traits(persona_id,trait_type,text) VALUES (?,?,?)").run(id, t.type, t.text);
      for (const i of ids) db.prepare("INSERT OR IGNORE INTO persona_trait_evidence VALUES (?,?)").run(Number(tr.lastInsertRowid), i);
      kept++;
    }
    nPer++;
  }
  audit(db, "synthesise", { runId, nSeg, nPer, kept, dropped, includesUnreviewed: !!opts.includePending });
  return { runId, segments: nSeg, personas: nPer, traitsKept: kept, traitsDropped: dropped, includesUnreviewed: !!opts.includePending };
}

const SYS_NAMES = `You rename user groups so anyone in a product team understands them at a glance. Each group keeps its meaning: use only the description given, add no facts. Keep each id exactly as given.
${PLAIN_NAME}`;
const SCHEMA_NAMES = { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, name: { type: "STRING" } }, required: ["id", "name"] } } }, required: ["items"] };

/** Segments and personas of the latest run whose names have not been put in plain words yet. */
export function needsPlainNames(db: Db): boolean {
  const run = db.prepare("SELECT id FROM synthesis_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (!run) return false;
  return !!db.prepare("SELECT 1 FROM segments WHERE run_id=? AND plain_name=0 UNION ALL SELECT 1 FROM personas WHERE run_id=? AND plain_name=0 LIMIT 1").get(run.id, run.id);
}

/** Put the names of existing groups in plain words. Only the name changes: descriptions, members, evidence and links stay as they are, and chats follow the new name. */
export async function plainNames(db: Db, ai: AiProvider): Promise<{ renamed: number }> {
  const run = db.prepare("SELECT id FROM synthesis_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (!run) return { renamed: 0 };
  let renamed = 0;
  for (const kind of ["segment", "persona"] as const) {
    const table = kind === "segment" ? "segments" : "personas", descCol = kind === "segment" ? "characteristic" : "description";
    const list = db.prepare(`SELECT id, name, ${descCol} d FROM ${table} WHERE run_id=? AND plain_name=0`).all(run.id) as { id: string; name: string; d: string }[];
    if (!list.length) continue;
    const out = await ai.generateJson<{ items: { id: string; name: string }[] }>({ system: SYS_NAMES, schema: SCHEMA_NAMES,
      prompt: `${kind === "segment" ? "Groups of people who share something, such as how they pay" : "Typical people built from several real participants"}. New name for each:\n` + list.map((x) => `- id ${x.id} | current name: ${x.name} | description: ${x.d}`).join("\n") });
    const byId = new Map(list.map((x) => [x.id, x])); const done = new Set<string>();
    for (const it of out.items ?? []) {
      const old = byId.get(it.id); const name = (it.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!old || done.has(it.id) || !name) continue; // an invented id or an empty name is ignored
      done.add(it.id);
      db.prepare(`UPDATE ${table} SET name=?, plain_name=1 WHERE id=?`).run(name, it.id);
      if (kind === "persona") db.prepare("UPDATE persona_messages SET persona_name=? WHERE persona_name=?").run(name, old.name);
      if (name !== old.name) renamed++;
    }
  }
  audit(db, "audiences.plain_names", { renamed });
  return { renamed };
}

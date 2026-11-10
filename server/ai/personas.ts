import crypto from "node:crypto";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";

type Ev = { id: number; participant_id: string; kind: string; theme: string; sentiment: string; translation: string | null; original_text: string; pain_point: string | null; need: string | null };
type Cluster = { name: string; description: string; participants: string[] };
type Proposal = { segments: (Cluster & { characteristic: string })[]; personas: Cluster[] };
type TraitOut = { traits: { type: string; text: string; evidence_ids: number[] }[] };

const TRAIT_TYPES = ["behaviour", "need", "pain_point", "motivation", "trust_barrier", "job_to_be_done", "trigger", "gap"];
const hid = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

const SYS_CLUSTER = `You synthesise user SEGMENTS and PERSONAS strictly from the research digest given. Never use outside knowledge.
- Segment = a real group of participants sharing a describable characteristic (e.g. how they pay, lifecycle stage, why they left). Use the metadata and themes.
- Persona = a behavioural profile (needs, motivations, barriers) shared by a cluster of participants. Name it with a short evocative label (2-4 words). A participant may belong to several personas and several segments.
- Only list participant IDs that appear in the digest. Each persona/segment needs at least 3 participants. Do not invent demographics.
- Propose 3-6 segments and 3-6 personas.`;
const SYS_TRAITS = `You write evidence-backed traits for ONE persona. Use ONLY the numbered evidence given.
- Each trait: type (behaviour, need, pain_point, motivation, trust_barrier, job_to_be_done, trigger, gap), one plain sentence, and evidence_ids drawn ONLY from the list given (at least 2 ids from different participants where possible).
- Do not state anything the evidence does not support. Use type "gap" for important things the evidence does NOT tell us.
- 8-14 traits total, covering several types.`;

const idArr = { type: "ARRAY", items: { type: "STRING" } };
const clusterProps = { name: { type: "STRING" }, description: { type: "STRING" }, participants: idArr };
const SCHEMA_CLUSTER = { type: "OBJECT", properties: {
  segments: { type: "ARRAY", items: { type: "OBJECT", properties: { ...clusterProps, characteristic: { type: "STRING" } }, required: ["name", "characteristic", "participants"] } },
  personas: { type: "ARRAY", items: { type: "OBJECT", properties: clusterProps, required: ["name", "description", "participants"] } },
}, required: ["segments", "personas"] };
const SCHEMA_TRAITS = { type: "OBJECT", properties: { traits: { type: "ARRAY", items: { type: "OBJECT", properties: {
  type: { type: "STRING", enum: TRAIT_TYPES }, text: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["type", "text", "evidence_ids"] } } }, required: ["traits"] };

export type SynthOpts = { includePending?: boolean; minMembers?: number };
export type SynthResult = { runId: number; segments: number; personas: number; traitsKept: number; traitsDropped: number; includesUnreviewed: boolean };

export async function synthesise(db: Db, ai: AiProvider, opts: SynthOpts = {}): Promise<SynthResult> {
  const statuses = opts.includePending ? ["approved", "pending"] : ["approved"];
  const ev = db.prepare(`SELECT id,participant_id,kind,theme,sentiment,translation,original_text,pain_point,need FROM evidence WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`).all(...statuses) as Ev[];
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

  const proposal = await ai.generateJson<Proposal>({ system: SYS_CLUSTER, prompt: `Research digest (${byP.size} participants):\n${digest}`, schema: SCHEMA_CLUSTER });
  const min = opts.minMembers ?? 3;
  const valid = (c: Cluster) => [...new Set(c.participants)].filter((p) => byP.has(p));
  const run = db.prepare("INSERT INTO synthesis_runs(created_at,model,includes_unreviewed,evidence_count,participant_count) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), ai.model, opts.includePending ? 1 : 0, ev.length, byP.size);
  const runId = Number(run.lastInsertRowid);
  let nSeg = 0, nPer = 0, kept = 0, dropped = 0;

  for (const s of proposal.segments ?? []) {
    const members = valid(s); if (members.length < min) continue;
    const id = `SEG-${hid(runId + s.name)}`;
    db.prepare("INSERT INTO segments(id,run_id,name,characteristic) VALUES (?,?,?,?)").run(id, runId, s.name, s.characteristic);
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
    db.prepare("INSERT INTO personas(id,run_id,name,description) VALUES (?,?,?,?)").run(id, runId, c.name, c.description);
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

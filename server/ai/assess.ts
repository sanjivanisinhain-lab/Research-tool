import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { audit, type Db } from "../db";
import type { AiProvider } from "./provider";
import { computeConfidence, type Signal } from "../confidence";
import { searchEvidence, type Hit } from "../search";
import { audienceParticipants, emptyImps, mainSignal, ROLES } from "./shared";
import type { Annotation, Assessment, AudienceRef, Implications, Signal as UiSignal } from "../../src/types/research";

const MIN_PARTICIPANTS = 3; // an element needs this many distinct participants of evidence to be annotated

const SYS_LOOK = `You are a UX analyst. Look at this design (a screen, card or flow step) and list the distinct UI elements that matter for the stated task: up to 8, such as price, discount badge, countdown timer, image, rating, delivery information, payment options, call-to-action button, trust signals.
For each element return: title (2-5 words), description (what it is and what it shows, factual, from the image only), box_2d as [ymin, xmin, ymax, xmax] on a 0-1000 scale, and search_terms (6-10 words/phrases in English and likely Hinglish that users would use when talking about this thing, e.g. "discount", "chhoot", "delivery charge").
Also return a short design_title (under 8 words) and design_summary (one sentence). Describe only what is visible; do not judge it.`;
const SCHEMA_LOOK = { type: "OBJECT", properties: {
  design_title: { type: "STRING" }, design_summary: { type: "STRING" },
  elements: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, description: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "NUMBER" } }, search_terms: { type: "ARRAY", items: { type: "STRING" } } }, required: ["title", "description", "search_terms"] } } }, required: ["design_title", "design_summary", "elements"] };

const SYS_ASSESS = `You predict how a user audience is likely to react to elements of a design, using ONLY the numbered research evidence given under each element. Never use outside knowledge about users or design trends.
- For each element give: signal (strong = evidence says it works / is welcomed, mixed = split or conditional, risk = evidence points to a barrier or distrust), a 1-2 sentence summary grounded in the evidence, and evidence_ids drawn ONLY from the numbers listed under that element. If the evidence does not speak to an element, give it no evidence_ids.
- "signals": for each evidence item you relied on, whether that participant's evidence points toward a positive, negative or neutral reaction to this design for the task.
- headline: under 12 words, agrees with your own signals. summary: 1-3 sentences, tentative if evidence is thin. conflict: evidence that contradicts the main conclusion (cite numbers) or null. unknowns: what the evidence cannot tell us about this design.
- implications: for each role, keep / change / watch (short).
This is a prediction from existing research, not a test result.`;
const imp = { type: "OBJECT", properties: { keep: { type: "STRING" }, change: { type: "STRING" }, watch: { type: "STRING" } }, required: ["keep", "change", "watch"] };
const SCHEMA_ASSESS = { type: "OBJECT", properties: {
  headline: { type: "STRING" }, summary: { type: "STRING" },
  elements: { type: "ARRAY", items: { type: "OBJECT", properties: { index: { type: "INTEGER" }, signal: { type: "STRING", enum: ["strong", "mixed", "risk"] }, summary: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["index", "signal", "summary", "evidence_ids"] } },
  signals: { type: "ARRAY", items: { type: "OBJECT", properties: { evidence_id: { type: "INTEGER" }, signal: { type: "STRING", enum: ["positive", "negative", "neutral"] } }, required: ["evidence_id", "signal"] } },
  conflict: { type: "OBJECT", nullable: true, properties: { title: { type: "STRING" }, body: { type: "STRING" }, evidence_ids: { type: "ARRAY", items: { type: "INTEGER" } } } },
  unknowns: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, body: { type: "STRING" } }, required: ["title", "body"] } },
  implications: { type: "OBJECT", properties: Object.fromEntries(ROLES.map((r) => [r, imp])), required: ROLES },
}, required: ["headline", "summary", "elements", "signals", "unknowns", "implications"] };

type Look = { design_title: string; design_summary: string; elements: { title: string; description: string; box_2d?: number[]; search_terms: string[] }[] };
type Assessed = { headline: string; summary: string; elements: { index: number; signal: UiSignal; summary: string; evidence_ids: number[] }[]; signals: { evidence_id: number; signal: Signal }[]; conflict?: { title: string; body: string; evidence_ids: number[] } | null; unknowns: { title: string; body: string }[]; implications: Implications };

export type AssessInput = { image: { data: Buffer; mimeType: string; name: string }; task: string; goal?: string; audience: AudienceRef[]; includeUnreviewed?: boolean; mediaDir: string; now?: Date };

const validBox = (b?: number[]): Annotation["box"] | undefined => {
  if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return undefined;
  const [y0, x0, y1, x1] = b.map((n) => Math.max(0, Math.min(1000, Math.round(n))));
  return y1 > y0 && x1 > x0 ? [y0, x0, y1, x1] : undefined;
};

export async function assessDesign(db: Db, ai: AiProvider, o: AssessInput): Promise<Assessment> {
  const statuses = o.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = audienceParticipants(db, o.audience);
  const look = await ai.generateJsonWithMedia<Look>({ system: SYS_LOOK, schema: SCHEMA_LOOK, prompt: `Task the user will do with this design: ${o.task}${o.goal ? `\nLearning goal: ${o.goal}` : ""}` }, [{ mimeType: o.image.mimeType, data: o.image.data }]);
  const elements = (look.elements ?? []).slice(0, 8);

  // Retrieve evidence for each element locally (no AI), then let the AI judge only from what was retrieved.
  const pool = new Map<number, Hit>(); const perElement: Hit[][] = [];
  for (const el of elements) {
    const hits = searchEvidence(db, { terms: [el.title, el.description, ...(el.search_terms ?? []), o.task], participants: members, statuses, limit: 8 });
    perElement.push(hits); for (const h of hits) pool.set(h.id, h);
  }
  const id = "asm-" + crypto.randomBytes(5).toString("hex");
  const savedAt = new Date().toISOString();
  const imgExt = o.image.mimeType === "image/png" ? ".png" : o.image.mimeType === "image/webp" ? ".webp" : ".jpg";
  fs.mkdirSync(o.mediaDir, { recursive: true });
  const imagePath = path.join(o.mediaDir, `${id}${imgExt}`);
  fs.writeFileSync(imagePath, o.image.data, { mode: 0o600 });

  let annotations: Annotation[] = []; let unknowns: { title: string; body: string }[] = [];
  let headline = "", summary = "", conflict: Assessment["conflict"]; let implications = emptyImps();
  let conf = computeConfidence([], o.now); let stances: Record<string, "supports" | "contradicts"> = {};

  if (pool.size) {
    const block = elements.map((el, i) => `ELEMENT ${i + 1}: ${el.title} (${el.description})\n` + (perElement[i].length ? perElement[i].map((h) => `  #${h.id} (${h.participantId}, ${h.kind}) ${h.translation ?? h.quote}`).join("\n") : "  (no evidence found)")).join("\n\n");
    const raw = await ai.generateJson<Assessed>({ system: SYS_ASSESS, schema: SCHEMA_ASSESS, prompt: `Task: ${o.task}${o.goal ? `\nGoal: ${o.goal}` : ""}\nAudience: ${o.audience.map((a) => a.name).join(" + ") || "All users"}\nDesign: ${look.design_summary}\n\n${block}` });
    // Integrity: signals only on retrieved evidence; confidence computed in code.
    const seen = new Set<number>();
    const items = (raw.signals ?? []).filter((s) => pool.has(s.evidence_id) && !seen.has(s.evidence_id) && seen.add(s.evidence_id)).map((s) => ({ participantId: pool.get(s.evidence_id)!.participantId, signal: s.signal, date: pool.get(s.evidence_id)!.date }));
    conf = computeConfidence(items, o.now);
    headline = raw.headline; summary = raw.summary; implications = { ...emptyImps(), ...raw.implications };
    unknowns = raw.unknowns ?? [];
    const main = mainSignal(conf.direction?.label);
    for (const s of raw.signals ?? []) if (pool.has(s.evidence_id)) stances[String(s.evidence_id)] = s.signal === "neutral" || s.signal === main ? "supports" : "contradicts";
    for (const e of raw.elements ?? []) {
      const el = elements[(e.index ?? 0) - 1]; if (!el) continue;
      const allowed = new Set(perElement[e.index - 1].map((h) => h.id)); // an element may only cite evidence retrieved for it
      const ids = [...new Set(e.evidence_ids ?? [])].filter((i) => allowed.has(i));
      const people = new Set(ids.map((i) => pool.get(i)!.participantId)).size;
      if (people < MIN_PARTICIPANTS) { // too little evidence: say so instead of predicting
        unknowns.push({ title: el.title, body: `Existing research doesn't tell us enough about this element for this audience (${people} participant${people === 1 ? "" : "s"}).` });
        continue;
      }
      const box = validBox(el.box_2d);
      annotations.push({ id: `a${annotations.length + 1}`, element: el.title.toLowerCase().replace(/\s+/g, "_"), title: el.title, signal: e.signal, summary: e.summary, participants: people, evidenceIds: ids.map(String), ...(box ? { box } : {}) });
    }
    const cids = [...new Set(raw.conflict?.evidence_ids ?? [])].filter((i) => pool.has(i)).map(String);
    if (raw.conflict && cids.length) conflict = { title: raw.conflict.title, body: raw.conflict.body, evidenceIds: cids };
  } else {
    unknowns = elements.map((el) => ({ title: el.title, body: "No existing research found for this element and audience." }));
  }

  if (conf.withheld || !annotations.length) {
    headline = "Insufficient evidence to predict a reaction";
    summary = pool.size ? "The existing research is too thin to predict how this audience would react. Treat anything below as a lead to test, not a prediction." : "We have no research that speaks to this design for this audience.";
  } else if (conf.direction && conf.direction.label !== "Mixed" && /\b(mixed|split|divided|varied|ambivalent)\b/i.test(headline)) {
    headline = `Likely ${conf.direction.label.toLowerCase()} reaction`; // keep the headline consistent with the computed direction
  }
  const result: Assessment = {
    id, title: look.design_title || "Uploaded design", prototype: { kind: "upload", name: "uploaded design", mimeType: o.image.mimeType }, task: o.task, ...(o.goal ? { goal: o.goal } : {}), audience: o.audience,
    headline, summary, ...(conf.direction && !conf.withheld ? { direction: conf.direction } : {}),
    confidence: { score: conf.score, label: conf.label, participants: conf.participants, factors: conf.factors, methodStatus: conf.methodStatus },
    annotations, ...(conflict ? { conflict } : {}), unknowns, implications, evidenceStances: stances,
    evidenceStatus: o.includeUnreviewed ? "includes_unreviewed" : "approved_only", savedAt,
  };
  db.prepare("INSERT INTO assessments(id,task,audience_json,includes_unreviewed,assessment_json,image_path,image_mime,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, o.task, JSON.stringify(o.audience), o.includeUnreviewed ? 1 : 0, JSON.stringify(result), imagePath, o.image.mimeType, savedAt);
  audit(db, "assessment", { id, elements: elements.length, annotated: annotations.length, participants: conf.participants, score: conf.score });
  return result;
}


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

export type ScreenInput = { data: Buffer; mimeType: string; name: string; source?: "upload" | "figma" };
export type AssessInput = { images: ScreenInput[]; figmaUrl?: string; task: string; goal?: string; audience: AudienceRef[]; includeUnreviewed?: boolean; mediaDir: string; now?: Date };

const EXT: Record<string, string> = { "image/png": ".png", "image/webp": ".webp", "image/jpeg": ".jpg" };
/** Where screen n of an assessment is kept. Screen 0 keeps the original file name so older assessments still open. */
export const screenFile = (dir: string, id: string, n: number, mimeType: string) => path.join(dir, `${id}${n ? `-${n}` : ""}${EXT[mimeType] ?? ".jpg"}`);

const validBox = (b?: number[]): Annotation["box"] | undefined => {
  if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return undefined;
  const [y0, x0, y1, x1] = b.map((n) => Math.max(0, Math.min(1000, Math.round(n))));
  return y1 > y0 && x1 > x0 ? [y0, x0, y1, x1] : undefined;
};

export async function assessDesign(db: Db, ai: AiProvider, o: AssessInput): Promise<Assessment> {
  const statuses = o.includeUnreviewed ? ["approved", "pending"] : ["approved"];
  const members = audienceParticipants(db, o.audience);
  // One look per screen. Each element remembers which screen it is on, so its marker lands on the right picture.
  const perScreen = o.images.length > 1 ? 5 : 8;
  const looks: Look[] = [];
  for (const [n, img] of o.images.entries()) {
    looks.push(await ai.generateJsonWithMedia<Look>({ system: SYS_LOOK, schema: SCHEMA_LOOK, prompt: `Task the user will do with this design: ${o.task}${o.goal ? `\nLearning goal: ${o.goal}` : ""}${o.images.length > 1 ? `\nThis is screen ${n + 1} of ${o.images.length} in the same flow (${img.name}).` : ""}` }, [{ mimeType: img.mimeType, data: img.data }]));
  }
  const look = { design_title: looks[0]?.design_title ?? "", design_summary: looks.map((l, n) => (o.images.length > 1 ? `Screen ${n + 1}: ` : "") + (l.design_summary ?? "")).join(" ") };
  const elements = looks.flatMap((l, n) => (l.elements ?? []).slice(0, perScreen).map((el) => ({ ...el, screen: n })));

  // Retrieve evidence for each element locally (no AI), then let the AI judge only from what was retrieved.
  const pool = new Map<number, Hit>(); const perElement: Hit[][] = [];
  for (const el of elements) {
    const hits = searchEvidence(db, { terms: [el.title, el.description, ...(el.search_terms ?? []), o.task], participants: members, statuses, limit: 8 });
    perElement.push(hits); for (const h of hits) pool.set(h.id, h);
  }
  const id = "asm-" + crypto.randomBytes(5).toString("hex");
  const savedAt = new Date().toISOString();
  fs.mkdirSync(o.mediaDir, { recursive: true });
  const imagePath = screenFile(o.mediaDir, id, 0, o.images[0]!.mimeType);
  o.images.forEach((img, n) => fs.writeFileSync(screenFile(o.mediaDir, id, n, img.mimeType), img.data, { mode: 0o600 }));

  let annotations: Annotation[] = []; let unknowns: { title: string; body: string }[] = [];
  let headline = "", summary = "", conflict: Assessment["conflict"]; let implications = emptyImps();
  let conf = computeConfidence([], o.now); let stances: Record<string, "supports" | "contradicts"> = {};

  if (pool.size) {
    const block = elements.map((el, i) => `ELEMENT ${i + 1}: ${el.title} (${el.description}${o.images.length > 1 ? `; on screen ${el.screen + 1}` : ""})\n` + (perElement[i].length ? perElement[i].map((h) => `  #${h.id} (${h.participantId}, ${h.kind}) ${h.translation ?? h.quote}`).join("\n") : "  (no evidence found)")).join("\n\n");
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
      annotations.push({ id: `a${annotations.length + 1}`, element: el.title.toLowerCase().replace(/\s+/g, "_"), title: el.title, signal: e.signal, summary: e.summary, participants: people, evidenceIds: ids.map(String), ...(box ? { box } : {}), ...(o.images.length > 1 ? { screen: el.screen } : {}) });
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
    id, title: (look.design_title || "Uploaded design") + (o.images.length > 1 ? ` (${o.images.length} screens)` : ""),
    prototype: o.figmaUrl ? { kind: "figma_link", url: o.figmaUrl } : { kind: "upload", name: "uploaded design", mimeType: o.images[0]!.mimeType },
    screens: o.images.map((img) => ({ name: img.name, mimeType: img.mimeType, source: img.source ?? "upload" })), task: o.task, ...(o.goal ? { goal: o.goal } : {}), audience: o.audience,
    headline, summary, ...(conf.direction && !conf.withheld ? { direction: conf.direction } : {}),
    confidence: { score: conf.score, label: conf.label, participants: conf.participants, factors: conf.factors, methodStatus: conf.methodStatus },
    annotations, ...(conflict ? { conflict } : {}), unknowns, implications, evidenceStances: stances,
    evidenceStatus: o.includeUnreviewed ? "includes_unreviewed" : "approved_only", savedAt,
  };
  db.prepare("INSERT INTO assessments(id,task,audience_json,includes_unreviewed,assessment_json,image_path,image_mime,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, o.task, JSON.stringify(o.audience), o.includeUnreviewed ? 1 : 0, JSON.stringify(result), imagePath, o.images[0]!.mimeType, savedAt);
  audit(db, "assessment", { id, screens: o.images.length, elements: elements.length, annotated: annotations.length, participants: conf.participants, score: conf.score });
  return result;
}


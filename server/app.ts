import express from "express";
import { audit, type Db } from "./db";
import { ingestContribution } from "./ingest";
import { processUpload } from "./upload";
import { enqueueExtractions, enqueueRebuild, enqueueTranscription, retryJob } from "./jobs";
import { MEDIA_EXTS, ffmpegAvailable } from "./media";
import { newUploadPath } from "./ai/transcribe";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AiProvider } from "./ai/provider";
import { answerQuestion, audienceParticipants, compareAudiences, followUp } from "./ai/ask";
import type { AudienceProfile, AudienceRef, EvidenceItem } from "../src/types/research";

/** Research-team admin API. Nothing becomes usable evidence until a person approves it here. */
export type AppOpts = { ai?: AiProvider | null; includeUnreviewed?: boolean; termsPath?: string; adminToken?: string; mediaDir?: string; maxMediaBytes?: number };

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sampleStrength = (n: number) => Math.round(100 * (1 - Math.exp(-n / 10)));

export function createApp(db: Db, opts: AppOpts = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Optional shared admin passcode (set ADMIN_TOKEN). Contributions and the product API stay open.
  app.use("/api/admin", (req, res, next) => {
    if (!opts.adminToken || req.get("x-admin-token") === opts.adminToken) return next();
    res.status(401).json({ error: "admin token required" });
  });

  // Upload one file. Body = the raw file; details in the query string. Processed immediately, AI extraction runs as a background job.
  // Recordings are streamed to disk (they can be large) and transcribed by a background job.
  app.put("/api/admin/upload", async (req, res, next) => {
    const ext = path.extname(String(req.query.filename ?? "")).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) return next();
    const q = req.query;
    const study = String(q.study ?? "").trim().slice(0, 120);
    if (!study) return res.status(400).json({ error: "study name required" });
    if (q.ack !== "1") return res.status(400).json({ error: "Please confirm that recordings are sent to Google Gemini as recorded." });
    if (!(await ffmpegAvailable())) return res.status(501).json({ error: "ffmpeg is not installed on the server, so recordings can't be processed." });
    const max = opts.maxMediaBytes ?? 1.5 * 1024 ** 3;
    const file = newUploadPath(opts.mediaDir ?? "data/uploads", ext);
    const hash = crypto.createHash("sha256"); let size = 0; let aborted = false;
    const ws = fs.createWriteStream(file, { mode: 0o600 });
    req.on("data", (c: Buffer) => { hash.update(c); size += c.length; if (size > max && !aborted) { aborted = true; req.unpipe(ws); ws.destroy(); fs.rmSync(file, { force: true }); res.status(413).json({ error: "Recording is too large (limit 1.5 GB)." }); } });
    req.on("error", () => { ws.destroy(); fs.rmSync(file, { force: true }); });
    ws.on("finish", () => {
      if (aborted) return;
      const sha256 = hash.digest("hex");
      const empty = { sourcesAdded: 0, sourcesSkipped: 0, participantsAdded: 0, redaction: { names: 0, phones: 0, emails: 0, places: 0 } };
      if (!size) { fs.rmSync(file, { force: true }); return res.status(400).json({ error: "empty file" }); }
      if (db.prepare("SELECT 1 FROM media_hashes WHERE sha256=?").get(sha256)) {
        fs.rmSync(file, { force: true });
        return res.json({ status: "processed", message: "Already imported: nothing new to add.", format: "recording", ...empty, sourcesSkipped: 1 });
      }
      enqueueTranscription(db, { path: file, sha256, study, product: String(q.product ?? "").slice(0, 80), kind: q.kind === "interview" ? "interview" : "cx_call",
        date: typeof q.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null, names: String(q.names ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50), ...(opts.termsPath ? { termsPath: opts.termsPath } : {}) });
      res.status(202).json({ status: "queued", format: "recording", message: "Transcription queued. It runs in the background; check the status bar and the Sources tab.", ...empty, jobsQueued: 1 });
    });
    req.pipe(ws);
  });

  app.put("/api/admin/upload", express.raw({ type: () => true, limit: "60mb" }), async (req, res) => {
    const q = req.query;
    const study = String(q.study ?? "").trim().slice(0, 120);
    const filename = String(q.filename ?? "");
    if (!study) return res.status(400).json({ error: "study name required" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty file" });
    const date = typeof q.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
    const result = await processUpload(db, { name: filename, buf: req.body }, {
      study, product: String(q.product ?? "").slice(0, 80), kind: q.kind === "interview" ? "interview" : "cx_call", date,
      names: String(q.names ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50), termsPath: opts.termsPath,
    });
    const queued = result.sourcesAdded ? enqueueExtractions(db) : 0;
    res.status(result.status === "failed" || result.status === "unsupported" ? 422 : 200).json({ ...result, jobsQueued: queued });
  });

  app.get("/api/admin/sources", (_req, res) => {
    res.json(db.prepare(`SELECT s.id, s.title, s.source_type AS sourceType, s.origin, s.status, s.submitted_by AS submittedBy, s.date, s.quality, s.original_language AS language,
        s.redaction_json AS redaction, st.name AS study, s.participant_id AS participantId, s.created_at AS createdAt,
        (SELECT COUNT(*) FROM evidence e WHERE e.source_id = s.id) AS evidence,
        (SELECT COUNT(*) FROM evidence e WHERE e.source_id = s.id AND e.status = 'pending') AS pendingEvidence,
        (SELECT j.status FROM jobs j WHERE j.source_id = s.id AND j.kind = 'extract' ORDER BY j.id DESC LIMIT 1) AS job
      FROM sources s JOIN studies st ON st.id = s.study_id ORDER BY s.created_at DESC, s.id LIMIT 500`).all().map((r: any) => ({ ...r, redaction: JSON.parse(r.redaction) })));
  });

  app.get("/api/admin/jobs", (_req, res) => {
    res.json({
      counts: db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all(),
      recentFailures: db.prepare("SELECT id, kind, source_id AS sourceId, error FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 20").all(),
      transcriptions: (db.prepare("SELECT id, status, note, created_at AS createdAt, payload FROM jobs WHERE kind='transcribe' AND status IN ('queued','running') ORDER BY id").all() as { id: number; status: string; note: string; createdAt: string; payload: string }[])
        .map((j) => ({ id: j.id, status: j.status, note: j.note, createdAt: j.createdAt, study: (JSON.parse(j.payload) as { study: string }).study })),
      aiConfigured: !!opts.ai,
    });
  });
  app.post("/api/admin/jobs/rebuild-audiences", (_req, res) => {
    const approved = (db.prepare("SELECT COUNT(*) n FROM evidence WHERE status='approved'").get() as { n: number }).n;
    if (!approved) return res.status(409).json({ error: "No approved evidence yet." });
    res.status(202).json({ jobId: enqueueRebuild(db) });
  });
  app.post("/api/admin/jobs/:id/retry", (req, res) => (retryJob(db, Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "no failed job with that id" })));

  // Pending / approved / rejected evidence, with its source context
  app.get("/api/admin/evidence", (req, res) => {
    const status = String(req.query.status ?? "pending");
    if (!["pending", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "bad status" });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const rows = db.prepare(
      `SELECT e.id, e.participant_id AS participantId, e.original_text AS quote, e.translation, e.kind, e.provenance, e.theme, e.sentiment,
              e.pain_point AS painPoint, e.need, e.flags, e.status, e.review_note AS reviewNote,
              s.source_type AS sourceType, s.date, s.original_language AS originalLanguage, s.title AS sourceTitle, s.quality
       FROM evidence e JOIN sources s ON s.id = e.source_id WHERE e.status = ? ORDER BY e.id LIMIT ? OFFSET ?`,
    ).all(status, limit, offset);
    const total = (db.prepare("SELECT COUNT(*) n FROM evidence WHERE status=?").get(status) as { n: number }).n;
    res.json({ total, items: rows });
  });

  app.get("/api/admin/summary", (_req, res) => {
    res.json({
      evidence: db.prepare("SELECT status, COUNT(*) n FROM evidence GROUP BY status").all(),
      sources: db.prepare("SELECT status, COUNT(*) n FROM sources GROUP BY status").all(),
    });
  });

  const setStatus = (status: "approved" | "rejected") => (req: express.Request, res: express.Response) => {
    const id = Number(req.params.id);
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    const r = db.prepare("UPDATE evidence SET status=?, review_note=COALESCE(?, review_note) WHERE id=?").run(status, note, id);
    if (!r.changes) return res.status(404).json({ error: "not found" });
    audit(db, `evidence.${status}`, { id, note });
    res.json({ id, status });
  };
  app.post("/api/admin/evidence/:id/approve", setStatus("approved"));
  app.post("/api/admin/evidence/:id/reject", setStatus("rejected"));

  // Only translation / theme / sentiment are editable. The quote itself is never editable: it must stay a verbatim substring of the source.
  app.patch("/api/admin/evidence/:id", (req, res) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const sentiments = ["positive", "negative", "neutral", "mixed"];
    if (b.sentiment !== undefined && !sentiments.includes(b.sentiment)) return res.status(400).json({ error: "bad sentiment" });
    const r = db.prepare("UPDATE evidence SET translation=COALESCE(?,translation), theme=COALESCE(?,theme), sentiment=COALESCE(?,sentiment) WHERE id=?")
      .run(typeof b.translation === "string" ? b.translation : null, typeof b.theme === "string" ? b.theme.toLowerCase() : null, b.sentiment ?? null, id);
    if (!r.changes) return res.status(404).json({ error: "not found" });
    audit(db, "evidence.edit", { id, fields: Object.keys(b) });
    res.json({ id });
  });

  // Bulk approve everything pending for a source (e.g. after spot-checking it)
  app.post("/api/admin/sources/:id/approve-all", (req, res) => {
    const r = db.prepare("UPDATE evidence SET status='approved' WHERE source_id=? AND status='pending'").run(req.params.id);
    db.prepare("UPDATE sources SET status='approved' WHERE id=?").run(req.params.id);
    audit(db, "source.approve_all", { source: req.params.id, evidence: Number(r.changes) });
    res.json({ approved: Number(r.changes) });
  });


  // Contributions from CX / anyone: redacted on arrival, held as pending until the research team approves.
  app.post("/api/contributions", (req, res) => {
    const text = req.body?.text;
    const kind = req.body?.kind === "interview" ? "interview" : "cx_call";
    if (typeof text !== "string" || text.trim().length < 10) return res.status(400).json({ error: "text required (min 10 characters)" });
    const r = ingestContribution(db, text, { kind, termsPath: opts.termsPath });
    if (!r) return res.status(409).json({ error: "duplicate or empty contribution" });
    enqueueExtractions(db); // read by the AI in the background; the evidence then waits in the review queue
    res.status(202).json({ received: true, status: "pending_review" });
  });

  // ---------- Product API (matches docs/API_CONTRACT.md) ----------
  const latestRun = () => (db.prepare("SELECT id, created_at c FROM synthesis_runs ORDER BY id DESC LIMIT 1").get() as { id: number; c: string } | undefined);
  const statuses = () => (opts.includeUnreviewed ? ["approved", "pending"] : ["approved"]);

  function audienceProfile(kind: "segment" | "persona", id: string): AudienceProfile | null {
    const run = latestRun(); if (!run) return null;
    const isP = kind === "persona";
    const row = db.prepare(isP ? "SELECT id,name,description d FROM personas WHERE id=? AND run_id=?" : "SELECT id,name,characteristic d FROM segments WHERE id=? AND run_id=?").get(id, run.id) as { id: string; name: string; d: string } | undefined;
    if (!row) return null;
    const members = (db.prepare(isP ? "SELECT participant_id p FROM persona_participants WHERE persona_id=?" : "SELECT participant_id p FROM segment_participants WHERE segment_id=?").all(id) as { p: string }[]).map((r) => r.p);
    const traits = isP ? (db.prepare("SELECT trait_type t, text FROM persona_traits WHERE persona_id=?").all(id) as { t: string; text: string }[]) : [];
    const of = (t: string) => traits.filter((x) => x.t === t).map((x) => x.text);
    const ph = members.map(() => "?").join(",");
    const ev = members.length ? (db.prepare(`SELECT e.original_text q, e.translation tr, e.participant_id p, s.original_language l, s.id sid FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.participant_id IN (${ph}) AND e.status IN (${statuses().map(() => "?").join(",")}) AND e.provenance='participant_verbatim'`).all(...members, ...statuses()) as { q: string; tr: string | null; p: string; l: string; sid: string }[]) : [];
    return {
      ref: { kind, id, name: row.name, participants: members.length }, initials: initials(row.name), description: row.d,
      evidenceStrength: sampleStrength(members.length), corePatterns: traits.length, sources: new Set(ev.map((e) => e.sid)).size, updatedAt: run.c,
      definingBehaviours: of("behaviour"), needs: of("need"), painPoints: of("pain_point"),
      language: ev.slice(0, 4).map((e) => ({ quote: e.q, lang: e.l as "en" | "hi" | "hinglish", translation: e.tr ?? undefined, participantId: e.p })),
      gaps: of("gap"), jobs: of("job_to_be_done"), triggers: of("trigger"), trustBarriers: of("trust_barrier"),
    };
  }

  app.get("/api/profile", (_req, res) => {
    const r = db.prepare("SELECT role,team,area,note,name FROM profiles WHERE id='me'").get();
    return r ? res.json(r) : res.status(404).end();
  });
  app.put("/api/profile", (req, res) => {
    const b = req.body ?? {};
    if (!["designer", "researcher", "pm", "marketing", "cx", "other"].includes(b.role) || typeof b.team !== "string" || typeof b.area !== "string") return res.status(400).json({ error: "invalid profile" });
    db.prepare("INSERT INTO profiles(id,role,team,area,note,name,updated_at) VALUES ('me',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,team=excluded.team,area=excluded.area,note=excluded.note,name=excluded.name,updated_at=excluded.updated_at")
      .run(b.role, b.team.slice(0, 120), b.area.slice(0, 120), b.note ?? null, b.name ?? null, new Date().toISOString());
    res.json({ role: b.role, team: b.team, area: b.area, note: b.note, name: b.name });
  });

  app.get("/api/audiences", (_req, res) => {
    const run = latestRun(); if (!run) return res.json([]);
    const segs = (db.prepare("SELECT id FROM segments WHERE run_id=?").all(run.id) as { id: string }[]).map((r) => audienceProfile("segment", r.id));
    const pers = (db.prepare("SELECT id FROM personas WHERE run_id=?").all(run.id) as { id: string }[]).map((r) => audienceProfile("persona", r.id));
    res.json([...segs, ...pers].filter(Boolean));
  });
  app.get("/api/audiences/:kind/:id", (req, res) => {
    if (req.params.kind !== "segment" && req.params.kind !== "persona") return res.status(404).end();
    const a = audienceProfile(req.params.kind, req.params.id);
    return a ? res.json(a) : res.status(404).end();
  });
  app.post("/api/audiences/count", (req, res) => {
    const aud = Array.isArray(req.body?.audience) ? (req.body.audience as AudienceRef[]) : [];
    const members = audienceParticipants(db, aud);
    res.json({ count: members ? members.length : (db.prepare("SELECT COUNT(*) n FROM participants").get() as { n: number }).n });
  });

  app.post("/api/answers", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.question !== "string" || !b.question.trim() || b.question.length > 4000) return res.status(400).json({ error: "question required" });
    if (!opts.ai) return res.status(503).json({ error: "AI provider not configured (set GEMINI_API_KEY)" });
    const audience = Array.isArray(b.audience) ? b.audience : [];
    if (b.mode === "compare" && audience.length < 2) return res.status(400).json({ error: "compare needs at least two audiences" });
    try {
      const a = b.mode === "compare"
        ? await compareAudiences(db, opts.ai, { question: b.question.trim(), audience, includeUnreviewed: opts.includeUnreviewed })
        : await answerQuestion(db, opts.ai, { question: b.question.trim(), audience, includeUnreviewed: opts.includeUnreviewed });
      res.json({ id: a.id });
    } catch (e) { console.error("answer failed:", (e as Error).message); res.status(502).json({ error: "answer generation failed" }); }
  });
  app.get("/api/answers/:id", (req, res) => {
    const r = db.prepare("SELECT answer_json j FROM answers WHERE id=?").get(req.params.id) as { j: string } | undefined;
    return r ? res.type("json").send(r.j) : res.status(404).end();
  });

  app.get("/api/evidence", (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    if (!ids.length) return res.json([]);
    const rows = db.prepare(`SELECT e.id,e.participant_id p,e.original_text q,e.translation tr,e.kind,e.provenance prov,s.id sid,s.title stitle,s.origin,s.quality,st.name study,s.source_type st,s.date d,s.original_language l
      FROM evidence e JOIN sources s ON s.id=e.source_id JOIN studies st ON st.id=s.study_id WHERE e.id IN (${ids.map(() => "?").join(",")}) AND e.status IN (${statuses().map(() => "?").join(",")})`).all(...ids, ...statuses()) as any[];
    const out: EvidenceItem[] = rows.map((r) => {
      // stance comes from the most recent answer that cited this evidence
      const ans = db.prepare("SELECT answer_json j FROM answers WHERE answer_json LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%"${r.id}":"%`) as { j: string } | undefined;
      const stance = (ans && (JSON.parse(ans.j).evidenceStances ?? {})[String(r.id)]) || "supports";
      return { id: String(r.id), participantId: r.p, sourceType: r.st, date: r.d ?? "", quote: r.q, originalLanguage: r.l, translation: r.tr ?? undefined, kind: r.kind, stance,
        sourceContext: { simulated: false, reference: r.sid, title: r.stitle,
          context: `${r.study} · ${r.origin === "researcher_notes" ? (r.prov === "participant_verbatim" ? "researcher notes (participant words quoted)" : "researcher summary, not a verbatim quote") : "interview transcript"}${r.quality === "noisy_asr" ? " · noisy machine transcription" : ""}`,
          recording: "No recording attached" } };
    });
    res.json(out);
  });

  app.get("/api/saved-work", (_req, res) => {
    const rows = db.prepare("SELECT id,question,variant,audience_json a,created_at c FROM answers ORDER BY created_at DESC LIMIT 100").all() as any[];
    res.json(rows.map((r) => ({ id: r.id, title: r.question.slice(0, 90), type: "answer", audience: (JSON.parse(r.a) as AudienceRef[]).map((x) => x.name).join(" + ") || "All users",
      status: r.variant === "insufficient" ? "Insufficient evidence" : "Answered", updatedAt: r.c, target: { to: "/ask/$id", id: r.id } })));
  });

  app.post("/api/answers/:id/follow-ups", async (req, res) => {
    const q = req.body?.question;
    if (typeof q !== "string" || !q.trim() || q.length > 2000) return res.status(400).json({ error: "question required" });
    if (!opts.ai) return res.status(503).json({ error: "AI provider not configured (set GEMINI_API_KEY)" });
    try {
      const fu = await followUp(db, opts.ai, req.params.id, q.trim());
      return fu ? res.json(fu) : res.status(404).end();
    } catch (e) { console.error("follow-up failed:", (e as Error).message); res.status(502).json({ error: "follow-up failed" }); }
  });
  for (const p of ["/api/assessments", "/api/personas/:id/messages"]) app.post(p, (_req, res) => res.status(501).json({ error: "not implemented yet" }));
  app.get("/api/assessments/:id", (_req, res) => res.status(404).end());
  app.get("/api/personas/:id/conversation", (_req, res) => res.json([]));

  return app;
}

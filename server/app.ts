import express from "express";
import { audit, type Db } from "./db";
import { setupAuth, type AuthOpts } from "./auth";
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
import { assessDesign } from "./ai/assess";
import { chatWithPersona, conversation, latestPersona } from "./ai/personaChat";
import type { AudienceProfile, AudienceRef, EvidenceItem } from "../src/types/research";

/** Research-team admin API. Nothing becomes usable evidence until a person approves it here. */
export type AppOpts = { ai?: AiProvider | null; includeUnreviewed?: boolean; termsPath?: string; auth?: AuthOpts; mediaDir?: string; maxMediaBytes?: number; assetsDir?: string };

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const sampleStrength = (n: number) => Math.round(100 * (1 - Math.exp(-n / 10)));

export function createApp(db: Db, opts: AppOpts = {}) {
  const app = express();
  app.use(express.json({ limit: "25mb" })); // attachments and design images arrive as base64

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  setupAuth(app, db, opts.auth ?? {}); // everything registered after this line requires a signed-in user

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
      audit(db, "upload.by", { by: req.user!.id, status: "queued", kind: "recording" });
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
    audit(db, "upload.by", { by: req.user!.id, status: result.status, added: result.sourcesAdded });
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
  app.post("/api/admin/jobs/rebuild-audiences", (req, res) => {
    const approved = (db.prepare("SELECT COUNT(*) n FROM evidence WHERE status='approved'").get() as { n: number }).n;
    if (!approved) return res.status(409).json({ error: "No approved evidence yet." });
    audit(db, "rebuild_audiences.by", { by: req.user!.id });
    res.status(202).json({ jobId: enqueueRebuild(db) });
  });
  app.post("/api/admin/jobs/:id/retry", (req, res) => (retryJob(db, Number(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "no failed job with that id" })));

  // Study requests: the research team's side
  app.get("/api/admin/study-requests", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = db.prepare("SELECT id, answer_id AS answerId, title, plan_json p, requester_json r, note, status, team_note AS teamNote, created_at AS createdAt, updated_at AS updatedAt FROM study_requests WHERE (? IS NULL OR status = ?) ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, created_at DESC LIMIT 200").all(status, status) as any[];
    res.json(rows.map((r) => ({ ...r, plan: JSON.parse(r.p), requester: JSON.parse(r.r), p: undefined, r: undefined })));
  });
  app.patch("/api/admin/study-requests/:id", (req, res) => {
    const b = req.body ?? {};
    if (b.status !== undefined && !["new", "accepted", "in_progress", "done", "declined"].includes(b.status)) return res.status(400).json({ error: "bad status" });
    const r = db.prepare("UPDATE study_requests SET status=COALESCE(?,status), team_note=COALESCE(?,team_note), updated_at=? WHERE id=?")
      .run(b.status ?? null, typeof b.teamNote === "string" ? b.teamNote.slice(0, 2000) : null, new Date().toISOString(), req.params.id);
    if (!r.changes) return res.status(404).json({ error: "not found" });
    audit(db, "study_request.update", { id: req.params.id, status: b.status ?? null, by: req.user!.id });
    res.json({ id: req.params.id });
  });

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
    const r = db.prepare("UPDATE evidence SET status=?, review_note=COALESCE(?, review_note), reviewed_by=?, reviewed_at=? WHERE id=?").run(status, note, req.user!.id, new Date().toISOString(), id);
    if (!r.changes) return res.status(404).json({ error: "not found" });
    audit(db, `evidence.${status}`, { id, note, by: req.user!.id });
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
    audit(db, "evidence.edit", { id, fields: Object.keys(b), by: req.user!.id });
    res.json({ id });
  });

  // Bulk approve everything pending for a source (e.g. after spot-checking it)
  app.post("/api/admin/sources/:id/approve-all", (req, res) => {
    const r = db.prepare("UPDATE evidence SET status='approved' WHERE source_id=? AND status='pending'").run(req.params.id);
    db.prepare("UPDATE sources SET status='approved' WHERE id=?").run(req.params.id);
    audit(db, "source.approve_all", { source: req.params.id, evidence: Number(r.changes), by: req.user!.id });
    res.json({ approved: Number(r.changes) });
  });


  // Contributions from CX / anyone: redacted on arrival, held as pending until the research team approves.
  app.post("/api/contributions", (req, res) => {
    const text = req.body?.text;
    const kind = req.body?.kind === "interview" ? "interview" : "cx_call";
    if (typeof text !== "string" || text.trim().length < 10) return res.status(400).json({ error: "text required (min 10 characters)" });
    const r = ingestContribution(db, text, { kind, termsPath: opts.termsPath });
    if (r) audit(db, "contribution.by", { sourceId: r.sourceId, by: req.user!.id });
    if (!r) return res.status(409).json({ error: "duplicate or empty contribution" });
    enqueueExtractions(db); // read by the AI in the background; the evidence then waits in the review queue
    res.status(202).json({ received: true, status: "pending_review" });
  });

  // Answers, plans and assessments belong to the person who created them (admins can open any, to support the team).
  const canSee = (req: express.Request, owner: string | null) => req.user!.role === "admin" || owner === req.user!.id;
  const answerOwner = (id: string) => (db.prepare("SELECT user_id u FROM answers WHERE id=?").get(id) as { u: string | null } | undefined);

  // ---------- Study requests: a user asks the research team to run a planned study ----------
  const requestRow = (answerId: string) => db.prepare("SELECT id, status, team_note AS teamNote, note, created_at AS createdAt, updated_at AS updatedAt FROM study_requests WHERE answer_id=?").get(answerId);
  app.get("/api/answers/:id/study-request", (req, res) => { const o = answerOwner(req.params.id); return !o || !canSee(req, o.u) ? res.status(404).end() : res.json(requestRow(req.params.id) ?? null); });
  app.post("/api/answers/:id/study-request", (req, res) => {
    const row = db.prepare("SELECT answer_json j, user_id u FROM answers WHERE id=?").get(req.params.id) as { j: string; u: string | null } | undefined;
    if (!row || !canSee(req, row.u)) return res.status(404).json({ error: "plan not found" });
    const answer = JSON.parse(row.j) as { variant: string; question: string; headline: string; audience: AudienceRef[]; studyPlan?: unknown; known?: unknown; unknowns?: unknown };
    if (answer.variant !== "study_plan" || !answer.studyPlan) return res.status(400).json({ error: "only a study plan can be requested" });
    if (requestRow(req.params.id)) return res.status(409).json({ error: "already requested", request: requestRow(req.params.id) });
    const profile = { ...(db.prepare("SELECT role, team, area, name FROM profiles WHERE id=?").get(req.user!.id) as object | undefined), name: req.user!.name, email: req.user!.email };
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : "";
    const id = "req-" + crypto.randomBytes(4).toString("hex"); const now = new Date().toISOString();
    db.prepare("INSERT INTO study_requests(id,answer_id,title,plan_json,requester_json,note,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, answer.headline.replace(/^Recommended next test: /, ""), JSON.stringify({ question: answer.question, audience: answer.audience, studyPlan: answer.studyPlan, known: answer.known ?? [], unknowns: answer.unknowns ?? [] }), JSON.stringify(profile), note || null, now, now, req.user!.id);
    audit(db, "study_request.create", { id, answerId: req.params.id });
    res.status(201).json(requestRow(req.params.id));
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

  app.get("/api/profile", (req, res) => {
    const r = db.prepare("SELECT role,team,area,note,name FROM profiles WHERE id=?").get(req.user!.id);
    return r ? res.json(r) : res.status(404).end();
  });
  app.put("/api/profile", (req, res) => {
    const b = req.body ?? {};
    if (!["designer", "researcher", "pm", "marketing", "cx", "other"].includes(b.role) || typeof b.team !== "string" || typeof b.area !== "string") return res.status(400).json({ error: "invalid profile" });
    db.prepare("INSERT INTO profiles(id,role,team,area,note,name,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,team=excluded.team,area=excluded.area,note=excluded.note,name=excluded.name,updated_at=excluded.updated_at")
      .run(req.user!.id, b.role, b.team.slice(0, 120), b.area.slice(0, 120), b.note ?? null, b.name ?? null, new Date().toISOString());
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
        : await answerQuestion(db, opts.ai, { question: b.question.trim(), audience, attachments: Array.isArray(b.attachments) ? b.attachments : [], ...(typeof b.contextAnswerId === "string" ? { contextAnswerId: b.contextAnswerId } : {}), includeUnreviewed: opts.includeUnreviewed });
      db.prepare("UPDATE answers SET user_id=? WHERE id=?").run(req.user!.id, a.id);
      res.json({ id: a.id });
    } catch (e) { console.error("answer failed:", (e as Error).message); res.status(502).json({ error: "answer generation failed" }); }
  });
  app.get("/api/answers/:id", (req, res) => {
    const r = db.prepare("SELECT answer_json j, user_id u FROM answers WHERE id=?").get(req.params.id) as { j: string; u: string | null } | undefined;
    return r && canSee(req, r.u) ? res.type("json").send(r.j) : res.status(404).end();
  });

  app.get("/api/evidence", (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    if (!ids.length) return res.json([]);
    const rows = db.prepare(`SELECT e.id,e.participant_id p,e.original_text q,e.translation tr,e.kind,e.provenance prov,s.id sid,s.title stitle,s.origin,s.quality,st.name study,s.source_type st,s.date d,s.original_language l
      FROM evidence e JOIN sources s ON s.id=e.source_id JOIN studies st ON st.id=s.study_id WHERE e.id IN (${ids.map(() => "?").join(",")}) AND e.status IN (${statuses().map(() => "?").join(",")})`).all(...ids, ...statuses()) as any[];
    const out: EvidenceItem[] = rows.map((r) => {
      // stance comes from the most recent answer that cited this evidence
      const like = `%"${r.id}":"%`;
      const ans = db.prepare("SELECT j FROM (SELECT answer_json j, created_at c FROM answers WHERE answer_json LIKE ? UNION ALL SELECT assessment_json j, created_at c FROM assessments WHERE assessment_json LIKE ?) ORDER BY c DESC LIMIT 1").get(like, like) as { j: string } | undefined;
      const stance = (ans && (JSON.parse(ans.j).evidenceStances ?? {})[String(r.id)]) || "supports";
      return { id: String(r.id), participantId: r.p, sourceType: r.st, date: r.d ?? "", quote: r.q, originalLanguage: r.l, translation: r.tr ?? undefined, kind: r.kind, stance,
        sourceContext: { simulated: false, reference: r.sid, title: r.stitle,
          context: `${r.study} · ${r.origin === "researcher_notes" ? (r.prov === "participant_verbatim" ? "researcher notes (participant words quoted)" : "researcher summary, not a verbatim quote") : "interview transcript"}${r.quality === "noisy_asr" ? " · noisy machine transcription" : ""}`,
          recording: "No recording attached" } };
    });
    res.json(out);
  });

  app.get("/api/saved-work", (req, res) => {
    const names = (j: string) => (JSON.parse(j) as AudienceRef[]).map((x) => x.name).join(" + ") || "All users";
    const answers = (db.prepare("SELECT id,question,variant,audience_json a,created_at c FROM answers WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user!.id) as any[]).map((r) => ({
      id: r.id, title: r.question.slice(0, 90), type: r.variant === "script_review" ? "script_review" : "answer", audience: names(r.a),
      status: r.variant === "insufficient" ? "Insufficient evidence" : r.variant === "script_review" ? "Reviewed" : r.variant === "study_plan" ? "Study plan" : "Answered", updatedAt: r.c, target: { to: "/ask/$id", id: r.id } }));
    const assessments = (db.prepare("SELECT id,task,audience_json a,created_at c,assessment_json j FROM assessments WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user!.id) as any[]).map((r) => ({
      id: r.id, title: (JSON.parse(r.j).title as string) || r.task.slice(0, 90), type: "assessment", audience: names(r.a), status: "Prediction", updatedAt: r.c, target: { to: "/assess/$id", id: r.id } }));
    const chats = (db.prepare("SELECT persona_name n, MAX(persona_id) pid, COUNT(*) c, MAX(created_at) t FROM persona_messages WHERE user_id=? GROUP BY persona_name").all(req.user!.id) as any[]).map((r) => {
      const current = db.prepare("SELECT id FROM personas WHERE name=? ORDER BY rowid DESC LIMIT 1").get(r.n) as { id: string } | undefined; // follow the persona across audience rebuilds
      return { id: `chat-${r.n}`, title: `Conversation with ${r.n}`, type: "persona_chat", audience: r.n, status: `${Math.ceil(r.c / 2)} question${Math.ceil(r.c / 2) === 1 ? "" : "s"}`, updatedAt: r.t, target: { to: "/persona-chat", persona: current?.id ?? r.pid } };
    });
    res.json([...answers, ...assessments, ...chats].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 100));
  });

  app.post("/api/answers/:id/follow-ups", async (req, res) => {
    const q = req.body?.question;
    if (typeof q !== "string" || !q.trim() || q.length > 2000) return res.status(400).json({ error: "question required" });
    if (!opts.ai) return res.status(503).json({ error: "AI provider not configured (set GEMINI_API_KEY)" });
    try {
      const o = answerOwner(req.params.id);
      if (!o || !canSee(req, o.u)) return res.status(404).end();
      const fu = await followUp(db, opts.ai, req.params.id, q.trim());
      return fu ? res.json(fu) : res.status(404).end();
    } catch (e) { console.error("follow-up failed:", (e as Error).message); res.status(502).json({ error: "follow-up failed" }); }
  });
  app.post("/api/assessments", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.task !== "string" || !b.task.trim() || b.task.length > 1000) return res.status(400).json({ error: "task required" });
    const audience: AudienceRef[] = Array.isArray(b.audience) ? b.audience : [];
    if (!audience.length) return res.status(400).json({ error: "choose an audience" });
    const proto = b.prototype ?? {};
    if (proto.kind === "figma_link") return res.status(422).json({ error: "Figma links can't be opened yet. Export the frame as a PNG or JPG and upload that image." });
    if (proto.kind !== "upload" || typeof proto.data !== "string") return res.status(400).json({ error: "upload a design image" });
    if (!["image/png", "image/jpeg", "image/webp"].includes(proto.mimeType)) return res.status(400).json({ error: "design must be a PNG, JPG or WebP image" });
    const data = Buffer.from(proto.data, "base64");
    if (!data.length || data.length > 10 * 1024 * 1024) return res.status(400).json({ error: "image must be under 10 MB" });
    if (!opts.ai) return res.status(503).json({ error: "AI provider not configured (set GEMINI_API_KEY)" });
    try {
      const a = await assessDesign(db, opts.ai, { image: { data, mimeType: proto.mimeType, name: String(proto.name ?? "design") }, task: b.task.trim(), ...(typeof b.goal === "string" && b.goal.trim() ? { goal: b.goal.trim() } : {}), audience, ...(opts.includeUnreviewed ? { includeUnreviewed: true } : {}), mediaDir: opts.assetsDir ?? "data/assessments" });
      db.prepare("UPDATE assessments SET user_id=? WHERE id=?").run(req.user!.id, a.id);
      res.json({ id: a.id });
    } catch (e) { console.error("assessment failed:", (e as Error).message); res.status(502).json({ error: "assessment failed" }); }
  });
  app.get("/api/assessments/:id/image", (req, res) => {
    const r = db.prepare("SELECT image_path p, image_mime m, user_id u FROM assessments WHERE id=?").get(req.params.id) as { p: string | null; m: string | null; u: string | null } | undefined;
    if (!r?.p || !canSee(req, r.u) || !fs.existsSync(r.p)) return res.status(404).end();
    res.type(r.m ?? "image/png").send(fs.readFileSync(r.p));
  });
  app.get("/api/assessments/:id", (req, res) => {
    const r = db.prepare("SELECT assessment_json j, user_id u FROM assessments WHERE id=?").get(req.params.id) as { j: string; u: string | null } | undefined;
    return r && canSee(req, r.u) ? res.type("json").send(r.j) : res.status(404).end();
  });
  // ---------- Persona chat: talk to a research-derived persona (a simulation, always grounded and labelled) ----------
  app.get("/api/personas/:id/conversation", (req, res) => {
    const persona = latestPersona(db, req.params.id);
    return persona ? res.json(conversation(db, req.user!.id, persona)) : res.status(404).end();
  });
  app.post("/api/personas/:id/messages", async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return res.status(400).json({ error: "message required" });
    const persona = latestPersona(db, req.params.id);
    if (!persona) return res.status(404).json({ error: "persona not found" });
    if (!opts.ai) return res.status(503).json({ error: "AI provider not configured (set GEMINI_API_KEY)" });
    try { res.json(await chatWithPersona(db, opts.ai, { userId: req.user!.id, persona, text: text.trim(), ...(opts.includeUnreviewed ? { includeUnreviewed: true } : {}) })); }
    catch (e) { console.error("persona chat failed:", (e as Error).message); res.status(502).json({ error: "the persona could not reply" }); }
  });

  return app;
}

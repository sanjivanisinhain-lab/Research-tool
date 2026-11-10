import express from "express";
import { audit, type Db } from "./db";

/** Research-team admin API. Nothing becomes usable evidence until a person approves it here. */
export function createApp(db: Db) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

  return app;
}

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";

let server: Server; let base = ""; const db = openDb(":memory:");
beforeAll(async () => {
  db.exec(`INSERT INTO studies VALUES ('S1','t','p','2026-01-01');
    INSERT INTO participants VALUES ('P001','S1','{}','2026-01-01');
    INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('SRC1','S1','P001','cx_call','researcher_notes','t','2026-01-01');
    INSERT INTO evidence(source_id,participant_id,original_text,kind,provenance,theme,sentiment,created_at) VALUES ('SRC1','P001','x','said','participant_verbatim','t','neutral','2026-01-01');`);
  server = createApp(db).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
const j = (p: string, init?: RequestInit) => fetch(base + p, { headers: { "content-type": "application/json" }, ...init }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("admin review API", () => {
  it("lists pending, approves, and records an audit entry", async () => {
    expect((await j("/api/admin/evidence")).body.total).toBe(1);
    expect((await j("/api/admin/evidence/1/approve", { method: "POST", body: JSON.stringify({ note: "ok" }) })).status).toBe(200);
    expect((await j("/api/admin/evidence")).body.total).toBe(0);
    expect((await j("/api/admin/evidence?status=approved")).body.items[0].quote).toBe("x");
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='evidence.approved'").get()).toEqual({ n: 1 });
  });
  it("never lets the quote be edited and validates input", async () => {
    await j("/api/admin/evidence/1", { method: "PATCH", body: JSON.stringify({ quote: "forged", theme: "Delivery" }) });
    expect(db.prepare("SELECT original_text, theme FROM evidence WHERE id=1").get()).toEqual({ original_text: "x", theme: "delivery" });
    expect((await j("/api/admin/evidence/1", { method: "PATCH", body: JSON.stringify({ sentiment: "weird" }) })).status).toBe(400);
    expect((await j("/api/admin/evidence/99/reject", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

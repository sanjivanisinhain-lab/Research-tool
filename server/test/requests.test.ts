// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";

const db = openDb(":memory:");
let server: Server; let base = "";
const plan = { id: "ans-plan", variant: "study_plan", question: "How should I test this?", headline: "Recommended next test: In-depth interviews", audience: [{ kind: "persona", id: "P", name: "Cash Cautious", participants: 5 }],
  studyPlan: { method: "In-depth interviews", objective: "o", audience: "a", task: "t", watchFor: "w", questions: ["q1"] }, known: [], unknowns: [{ title: "u", body: "b" }] };
beforeAll(() => {
  db.exec("INSERT INTO profiles(id,role,team,area,updated_at) VALUES ('local','designer','Shopping','PDP','x')");
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,answer_json,created_at) VALUES ('ans-plan','q','study_plan','[]',?,'x')").run(JSON.stringify(plan));
  db.prepare("INSERT INTO answers(id,question,variant,audience_json,answer_json,created_at) VALUES ('ans-std','q','standard','[]',?,'x')").run(JSON.stringify({ variant: "standard" }));
  server = createApp(db, { auth: { authDisabled: true } }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
const j = (p: string, init: RequestInit = {}, token = false) => fetch(base + p, { headers: { "content-type": "application/json", ...(token ? { "x-admin-token": "t" } : {}) }, ...init }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe("study requests", () => {
  it("a user can send a plan to the research team with a note; duplicates and non-plans are refused", async () => {
    expect((await j("/api/answers/ans-plan/study-request")).body).toBeNull();
    const r = await j("/api/answers/ans-plan/study-request", { method: "POST", body: JSON.stringify({ note: "  Need this before the Dec release  " }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "new", note: "Need this before the Dec release" });
    expect((await j("/api/answers/ans-plan/study-request", { method: "POST", body: "{}" })).status).toBe(409);
    expect((await j("/api/answers/ans-std/study-request", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await j("/api/answers/nope/study-request", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await j("/api/answers/ans-plan/study-request")).body).toMatchObject({ status: "new" });
  });
  it("the research team sees the plan and who asked, and can respond", async () => {
    const list = (await j("/api/admin/study-requests", {}, true)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "In-depth interviews", requester: { role: "designer", team: "Shopping", area: "PDP", email: "local@localhost" }, plan: { studyPlan: { questions: ["q1"] } }, status: "new" });
    const id = list[0].id;
    expect((await j(`/api/admin/study-requests/${id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted", teamNote: "We can run this in the week of 8 Dec" }) }, true)).status).toBe(200);
    expect((await j(`/api/admin/study-requests/${id}`, { method: "PATCH", body: JSON.stringify({ status: "bogus" }) }, true)).status).toBe(400);
    expect((await j("/api/admin/study-requests/none", { method: "PATCH", body: "{}" }, true)).status).toBe(404);
    // the requester sees the team's reply
    expect((await j("/api/answers/ans-plan/study-request")).body).toMatchObject({ status: "accepted", teamNote: "We can run this in the week of 8 Dec" });
  });
});

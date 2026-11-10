// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { hashPassword, verifyPassword, passwordProblem } from "../auth";

const PW = "correct horse battery";
const db = openDb(":memory:");
let server: Server; let base = "";
const mk = (auth = {}) => { const s = createApp(db, { auth }).listen(0); return { s, url: `http://127.0.0.1:${(s.address() as any).port}` }; };

// a tiny browser: keeps the session cookie and sends the request header the app requires
function client(url: () => string) {
  let cookie = "";
  return async (path: string, init: RequestInit & { json?: unknown; noHeader?: boolean } = {}) => {
    const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(init.noHeader ? {} : { "x-requested-with": "research-hub" }) };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(url() + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as any) });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => null), setCookie: set };
  };
}
beforeAll(() => { const a = mk(); server = a.s; base = a.url; });
afterAll(() => server.close());
const web = () => client(() => base);

describe("passwords", () => {
  it("hashes with scrypt, verifies, rejects wrong, never stores plaintext", () => {
    const h = hashPassword(PW);
    expect(h.startsWith("scrypt$")).toBe(true); expect(h).not.toContain(PW);
    expect(verifyPassword(PW, h)).toBe(true); expect(verifyPassword("wrong password!", h)).toBe(false);
    expect(hashPassword(PW)).not.toBe(h); // salted
  });
  it("enforces a sensible policy", () => {
    expect(passwordProblem("short", "a@b.co")).toMatch(/10/);
    expect(passwordProblem("aaaaaaaaaaaa", "a@b.co")).toMatch(/repetitive/);
    expect(passwordProblem("alexander-is-great", "alexander@x.com")).toMatch(/email/);
    expect(passwordProblem("password1234", "a@b.co")).toMatch(/common/);
    expect(passwordProblem(PW, "a@b.co")).toBeNull();
  });
});

describe("sign-up and sign-in", () => {
  const admin = web(); const bob = web(); const anon = web();
  it("everything except health and auth needs a signed-in user", async () => {
    expect((await anon("/api/health")).status).toBe(200);
    expect((await anon("/api/answers/x")).status).toBe(401);
    expect((await anon("/api/audiences")).status).toBe(401);
    expect((await anon("/api/admin/sources")).status).toBe(401);
    const me = await anon("/api/auth/me");
    expect(me.body).toMatchObject({ user: null, firstRun: true });
  });
  it("the first account becomes admin, with a secure cookie; later accounts are normal users", async () => {
    const r = await admin("/api/auth/signup", { json: { email: "Ana@Example.com", password: PW, name: "Ana" } });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: "ana@example.com", role: "admin" });
    expect(r.setCookie).toMatch(/HttpOnly/); expect(r.setCookie).toMatch(/SameSite=Lax/);
    expect(JSON.stringify((db.prepare("SELECT token_hash FROM sessions").all()))).not.toMatch(/=/); // hashed, not the cookie value
    expect((await bob("/api/auth/signup", { json: { email: "bob@example.com", password: PW } })).body.user.role).toBe("user");
    expect((await anon("/api/auth/me")).body.firstRun).toBe(false);
  });
  it("rejects duplicates, weak passwords and bad emails", async () => {
    expect((await web()("/api/auth/signup", { json: { email: "ana@EXAMPLE.com", password: PW } })).status).toBe(409);
    expect((await web()("/api/auth/signup", { json: { email: "c@example.com", password: "short" } })).status).toBe(400);
    expect((await web()("/api/auth/signup", { json: { email: "not-an-email", password: PW } })).status).toBe(400);
  });
  it("login gives the same error for a wrong password and an unknown email; correct login works; logout ends the session", async () => {
    const wrong = await web()("/api/auth/login", { json: { email: "ana@example.com", password: "nope nope nope" } });
    const unknown = await web()("/api/auth/login", { json: { email: "ghost@example.com", password: "nope nope nope" } });
    expect(wrong.status).toBe(401); expect(unknown.status).toBe(401); expect(wrong.body).toEqual(unknown.body);
    const c = web();
    expect((await c("/api/auth/login", { json: { email: "ana@example.com", password: PW } })).status).toBe(200);
    expect((await c("/api/auth/me")).body.user.email).toBe("ana@example.com");
    await c("/api/auth/logout", { method: "POST", json: {} });
    expect((await c("/api/audiences")).status).toBe(401);
  });
  it("throttles repeated failures", async () => {
    const c = web(); let last = 0;
    for (let i = 0; i < 7; i++) last = (await c("/api/auth/login", { json: { email: "bob@example.com", password: "wrong wrong wrong" } })).status;
    expect(last).toBe(429);
    expect((await c("/api/auth/login", { json: { email: "bob@example.com", password: PW } })).status).toBe(429); // even the right one, until the lock ends
  });
  it("state-changing requests without the app's header are refused (CSRF)", async () => {
    expect((await web()("/api/auth/login", { json: { email: "ana@example.com", password: PW }, noHeader: true })).status).toBe(403);
  });
});

describe("roles, privacy and account management", () => {
  const ana = web(); const bob = web();
  beforeAll(async () => { await ana("/api/auth/login", { json: { email: "ana@example.com", password: PW } }); await bob("/api/auth/login", { json: { email: "bob@example.com", password: "correct horse battery" } }).catch(() => null); });
  it("only admins reach the research team's area", async () => {
    // bob was throttled in an earlier test (same ip+email); sign in via a fresh account instead
    const u = web(); await u("/api/auth/signup", { json: { email: "dee@example.com", password: PW } });
    expect((await u("/api/admin/sources")).status).toBe(403);
    expect((await u("/api/admin/users")).status).toBe(403);
    expect((await ana("/api/admin/users")).status).toBe(200);
  });
  it("profiles and saved work are per user; answers are private to the owner but open to admins", async () => {
    const u = web(); await u("/api/auth/signup", { json: { email: "eve@example.com", password: PW } });
    expect((await u("/api/profile")).status).toBe(404);
    await u("/api/profile", { method: "PUT", json: { role: "designer", team: "T", area: "A" } });
    expect((await ana("/api/profile")).status).toBe(404); // ana has her own, separate (empty) profile
    const owner = (db.prepare("SELECT id FROM users WHERE email='eve@example.com'").get() as { id: string }).id;
    db.prepare("INSERT INTO answers(id,question,variant,audience_json,answer_json,created_at,user_id) VALUES ('ans-eve','q','standard','[]','{\"id\":\"ans-eve\"}','2026-01-01',?)").run(owner);
    expect((await u("/api/answers/ans-eve")).status).toBe(200);
    const other = web(); await other("/api/auth/signup", { json: { email: "fay@example.com", password: PW } });
    expect((await other("/api/answers/ans-eve")).status).toBe(404);
    expect((await ana("/api/answers/ans-eve")).status).toBe(200);
    expect((await u("/api/saved-work")).body.map((x: any) => x.id)).toEqual(["ans-eve"]);
    expect((await other("/api/saved-work")).body).toEqual([]);
  });
  it("admins can promote people but can't remove the last admin; disabling signs the person out", async () => {
    const users = (await ana("/api/admin/users")).body as any[];
    const me = users.find((x) => x.email === "ana@example.com"), dee = users.find((x) => x.email === "dee@example.com");
    expect((await ana(`/api/admin/users/${me.id}`, { method: "PATCH", json: { role: "user" } })).status).toBe(409); // last admin
    expect((await ana(`/api/admin/users/${me.id}`, { method: "PATCH", json: { disabled: true } })).status).toBe(409);
    expect((await ana(`/api/admin/users/${dee.id}`, { method: "PATCH", json: { role: "admin" } })).status).toBe(200);
    expect((await ana(`/api/admin/users/${me.id}`, { method: "PATCH", json: { role: "user" } })).status).toBe(200); // now allowed: dee is an admin too
    expect((await ana(`/api/admin/users/${me.id}`, { method: "PATCH", json: { role: "admin" } })).status).toBe(403); // ana is no longer admin
  });
  it("password reset gives a temporary password that must be changed; changing signs out other sessions", async () => {
    const dee = web(); await dee("/api/auth/login", { json: { email: "dee@example.com", password: PW } });
    const users = (await dee("/api/admin/users")).body as any[];
    const eve = users.find((x) => x.email === "eve@example.com");
    const t = (await dee(`/api/admin/users/${eve.id}/reset-password`, { method: "POST", json: {} })).body.temporaryPassword;
    expect(t.length).toBeGreaterThanOrEqual(10);
    const e = web(); expect((await e("/api/auth/login", { json: { email: "eve@example.com", password: PW } })).status).toBe(401); // old password dead
    expect((await e("/api/auth/login", { json: { email: "eve@example.com", password: t } })).status).toBe(200);
    expect((await e("/api/profile")).body).toMatchObject({ code: "must_change_password" });
    expect((await e("/api/auth/change-password", { json: { currentPassword: t, newPassword: "a brand new passphrase" } })).status).toBe(200);
    expect((await e("/api/profile")).status).toBe(200);
    const second = web(); await second("/api/auth/login", { json: { email: "eve@example.com", password: "a brand new passphrase" } });
    await e("/api/auth/change-password", { json: { currentPassword: "a brand new passphrase", newPassword: "yet another passphrase!" } });
    expect((await second("/api/profile")).status).toBe(401); // other session ended
    expect((await e("/api/auth/change-password", { json: { currentPassword: "wrong", newPassword: "whatever whatever" } })).status).toBe(400);
  });
});

describe("optional hardening", () => {
  it("can limit sign-up to given email domains", async () => {
    const d = openDb(":memory:"); const s = createApp(d, { auth: { allowedEmailDomains: ["snapdeal.com"] } }).listen(0);
    const c = client(() => `http://127.0.0.1:${(s.address() as any).port}`);
    expect((await c("/api/auth/signup", { json: { email: "x@gmail.com", password: PW } })).status).toBe(403);
    expect((await c("/api/auth/signup", { json: { email: "x@snapdeal.com", password: PW } })).status).toBe(201);
    s.close();
  });
  it("can require a setup code for the first (admin) account", async () => {
    const d = openDb(":memory:"); const s = createApp(d, { auth: { setupCode: "open-sesame" } }).listen(0);
    const c = client(() => `http://127.0.0.1:${(s.address() as any).port}`);
    expect((await c("/api/auth/me")).body.setupCodeRequired).toBe(true);
    expect((await c("/api/auth/signup", { json: { email: "x@a.com", password: PW } })).status).toBe(403);
    expect((await c("/api/auth/signup", { json: { email: "x@a.com", password: PW, setupCode: "open-sesame" } })).body.user.role).toBe("admin");
    s.close();
  });
  it("the first admin inherits work created before accounts existed", async () => {
    const d = openDb(":memory:");
    d.prepare("INSERT INTO answers(id,question,variant,audience_json,answer_json,created_at) VALUES ('old','q','standard','[]','{}','x')").run();
    d.prepare("INSERT INTO profiles(id,role,team,area,updated_at) VALUES ('me','pm','T','A','x')").run();
    const s = createApp(d, { auth: {} }).listen(0); const c = client(() => `http://127.0.0.1:${(s.address() as any).port}`);
    const r = await c("/api/auth/signup", { json: { email: "own@a.com", password: PW } });
    expect((d.prepare("SELECT user_id FROM answers WHERE id='old'").get() as any).user_id).toBe(r.body.user.id);
    expect((await c("/api/profile")).body).toMatchObject({ role: "pm" });
    s.close();
  });
});

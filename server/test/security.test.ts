// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { buildCsp } from "../static";
import { loadConfig, securityWarnings } from "../config";
import { GeminiProvider } from "../ai/provider";
import { slidingWindow } from "../limits";

const INLINE = "window.__x=1";
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "rh-dist-"));
fs.mkdirSync(path.join(dist, "assets"));
fs.writeFileSync(path.join(dist, "_shell.html"), `<!doctype html><html><head><script>${INLINE}</script><script type="module" src="/assets/app.js"></script></head><body></body></html>`);
fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)"); fs.writeFileSync(path.join(dist, "favicon.ico"), "ico");
fs.writeFileSync(path.join(dist, ".env"), "SECRET=1");

const servers: Server[] = [];
const start = (opts: Parameters<typeof createApp>[1]) => { const s = createApp(openDb(":memory:"), opts).listen(0); servers.push(s); return `http://127.0.0.1:${(s.address() as any).port}`; };
afterAll(() => { servers.forEach((s) => s.close()); fs.rmSync(dist, { recursive: true, force: true }); });

describe("serving the web app", () => {
  let base = "";
  beforeAll(() => { base = start({ staticDir: dist, auth: { authDisabled: true, cookieSecure: true } }); });
  it("page shell carries a strict CSP (inline script allowed only by its hash), no framing, no caching, HSTS", async () => {
    const r = await fetch(base + "/");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain(`'sha256-${crypto.createHash("sha256").update(INLINE).digest("base64")}'`);
    expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("object-src 'none'"); expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("strict-transport-security")).toMatch(/max-age/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff"); expect(r.headers.get("x-powered-by")).toBeNull();
  });
  it("client routes fall back to the shell; assets are cached; unknown assets are 404, never the page", async () => {
    expect(await (await fetch(base + "/audiences/persona/x")).text()).toContain("<script");
    expect((await fetch(base + "/assets/app.js")).headers.get("cache-control")).toMatch(/immutable/);
    const missing = await fetch(base + "/assets/nope.js"); expect(missing.status).toBe(404); expect(await missing.text()).not.toContain("<script");
  });
  it("does not expose the shell file, dotfiles or paths outside the build", async () => {
    expect((await fetch(base + "/_shell.html")).status).toBe(404);
    for (const p of ["/.env", "/.git/config", "/a/.hidden"]) expect((await fetch(base + p)).status).toBe(404);
    for (const p of ["/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fserver/db.ts", "/..%5c..%5csecret"]) { const r = await fetch(base + p); expect(await r.text()).not.toMatch(/root:|SECRET|openDb/); }
  });
  it("API responses are never cached, unknown API paths are JSON 404s", async () => {
    const r = await fetch(base + "/api/health"); expect(r.headers.get("cache-control")).toBe("no-store");
    const nf = await fetch(base + "/api/nothing-here"); expect(nf.status).toBe(404); expect(nf.headers.get("content-type")).toMatch(/json/);
  });
  it("hashes inline scripts the way a browser does: a NUL character becomes U+FFFD before hashing", () => {
    const csp = buildCsp("<script>a=\"x\u0000y\"</script>");
    expect(csp).toContain(`'sha256-${crypto.createHash("sha256").update("a=\"x\uFFFDy\"").digest("base64")}'`);
  });
  it("buildCsp lists every inline script hash", () => { expect(buildCsp("<script>a</script><script>b</script><script src='x'></script>").match(/sha256-/g)).toHaveLength(2); });
});

describe("limits and error handling", () => {
  it("rate-limits expensive AI endpoints and note posting per person", async () => {
    const base = start({ ai: null, auth: { authDisabled: true }, limits: { aiPerHour: 2, notesPerHour: 1 } });
    const post = (p: string) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q", text: "a note long enough" }) });
    expect([(await post("/api/answers")).status, (await post("/api/answers")).status]).toEqual([503, 503]);
    const third = await post("/api/answers"); expect(third.status).toBe(429); expect(third.headers.get("retry-after")).toBeTruthy();
    expect((await post("/api/contributions")).status).toBe(202); expect((await post("/api/contributions")).status).toBe(429);
  });
  it("bounds sign-ups per address and keeps big bodies behind sign-in", async () => {
    const base = start({ auth: {} });
    const json = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "research-hub" }, body: JSON.stringify(body) });
    expect((await json("/api/auth/login", { email: "a@b.co", password: "x".repeat(200_000) })).status).toBe(413); // small bodies only before sign-in
    expect((await json("/api/answers", { question: "x".repeat(1_000_000) })).status).toBe(401); // large route: refused as signed-out, not parsed
    let last = 0; for (let i = 0; i < 11; i++) last = (await json("/api/auth/signup", { email: `u${i}@example.com`, password: "a long enough passphrase" })).status;
    expect(last).toBe(429);
  }, 60_000);
  it("malformed input gets a generic error, never a stack trace", async () => {
    const base = start({ auth: {} });
    const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "research-hub" }, body: "{not json" });
    const text = await r.text(); expect(r.status).toBe(400); expect(text).not.toMatch(/at .*\.(ts|js):\d+|node_modules/);
  });
  it("sliding window forgets old attempts", () => {
    const w = slidingWindow(1000, 2);
    expect(w.take("k", 0).ok).toBe(true); expect(w.take("k", 10).ok).toBe(true); expect(w.take("k", 20)).toMatchObject({ ok: false, retryAfterSec: 1 });
    expect(w.take("k", 1500).ok).toBe(true);
  });
});

describe("configuration and secrets", () => {
  it("production defaults: secure cookies on, static app served; development: off", () => {
    expect(loadConfig({ NODE_ENV: "production", HOST: "0.0.0.0" })).toMatchObject({ cookieSecure: true, staticDir: "dist/client" });
    expect(loadConfig({ NODE_ENV: "production", TRUST_PROXY: "1" }).cookieSecure).toBe(true); // behind an https proxy
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({ cookieSecure: false, host: "127.0.0.1" }); // local-only, plain http: sign-in must stick
    expect(loadConfig({ NODE_ENV: "production", COOKIE_SECURE: "0" }).cookieSecure).toBe(false);
    expect(loadConfig({})).toMatchObject({ cookieSecure: false, staticDir: undefined, dbPath: path.join("data", "research.sqlite") });
    expect(loadConfig({ DATA_DIR: "/srv/rh" }).mediaDir).toBe(path.join("/srv/rh", "uploads"));
    expect(loadConfig({ ALLOWED_EMAIL_DOMAINS: "@Snapdeal.com, example.org" }).allowedEmailDomains).toEqual(["snapdeal.com", "example.org"]);
  });
  it("warns plainly about risky settings", () => {
    const risky = securityWarnings(loadConfig({ NODE_ENV: "production", HOST: "0.0.0.0", COOKIE_SECURE: "0" }), 0).join("\n");
    expect(risky).toMatch(/ANY email address/); expect(risky).toMatch(/first person to open the app becomes the admin/); expect(risky).toMatch(/unencrypted/); expect(risky).toMatch(/GEMINI_API_KEY/);
    const safe = securityWarnings(loadConfig({ NODE_ENV: "production", ALLOWED_EMAIL_DOMAINS: "snapdeal.com", ADMIN_SETUP_CODE: "x", GEMINI_API_KEY: "k", COOKIE_SECURE: "1" }), 1).join("\n");
    expect(safe).not.toMatch(/ANY email|first person|unencrypted|GEMINI/);
  });
  it("the Gemini key goes in a header by default, in the URL only when asked, and never appears in errors", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return new Response("{}", { status: 400 }); });
    vi.stubGlobal("fetch", stub);
    const g = new GeminiProvider("SECRET-KEY-123", "m", 0);
    const err = await g.generateJson({ system: "s", prompt: "p", schema: {} }).catch((e: Error) => e.message);
    expect(calls[0].url).not.toContain("SECRET-KEY-123"); expect(calls[0].headers["x-goog-api-key"]).toBe("SECRET-KEY-123");
    expect(String(err)).not.toContain("SECRET-KEY-123");
    vi.stubEnv("GEMINI_KEY_IN_URL", "1"); calls.length = 0;
    await g.generateJson({ system: "s", prompt: "p", schema: {} }).catch(() => null);
    expect(calls[0].url).toContain("key=SECRET-KEY-123"); expect(calls[0].headers["x-goog-api-key"]).toBeUndefined();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
});

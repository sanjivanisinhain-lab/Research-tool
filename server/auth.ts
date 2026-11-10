import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { audit, type Db } from "./db";

export type AuthUser = { id: string; email: string; name: string | null; role: "admin" | "user"; mustChangePassword: boolean };
declare global { namespace Express { interface Request { user?: AuthUser } } }

export type AuthOpts = {
  authDisabled?: boolean;            // tests only: every request is a built-in admin
  allowedEmailDomains?: string[];    // empty/undefined = anyone may sign up
  setupCode?: string;                // if set, the very first sign-up (the admin) must supply it
  cookieSecure?: boolean;            // set when served over https
  sessionDays?: number;
};

const COOKIE = "rh_session";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${h.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
const DUMMY = hashPassword("not-a-real-password"); // so unknown emails cost the same time as wrong passwords

export function passwordProblem(pw: unknown, email: string): string | null {
  if (typeof pw !== "string") return "Password required";
  if (pw.length < 10) return "Use at least 10 characters";
  if (pw.length > 128) return "Password is too long (128 characters at most)";
  if (/^(.)\1+$/.test(pw)) return "Choose a less repetitive password";
  if (pw.toLowerCase() === email.toLowerCase() || pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "Password shouldn't contain your email";
  if (["password12", "1234567890", "qwertyuiop", "password123"].some((w) => pw.toLowerCase().includes(w))) return "That password is too common";
  return null;
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function parseCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return null;
}

const toUser = (r: { id: string; email: string; name: string | null; role: "admin" | "user"; must_change_password: number }): AuthUser =>
  ({ id: r.id, email: r.email, name: r.name, role: r.role, mustChangePassword: !!r.must_change_password });

export function setupAuth(app: Express, db: Db, o: AuthOpts) {
  const days = o.sessionDays ?? 14;
  const failures = new Map<string, { n: number; until: number }>(); // login throttling, per ip+email
  const keyOf = (req: Request, email: string) => `${req.ip}|${email.toLowerCase()}`;

  const cookieAttrs = (maxAgeSec: number) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${o.cookieSecure ? "; Secure" : ""}`;
  function startSession(res: Response, userId: string) {
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(sha(token), userId, now(), new Date(Date.now() + days * 86_400_000).toISOString());
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(days * 86400)}`);
  }
  const endCookie = (res: Response) => res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(0)}`);

  // security headers + session loading + CSRF guard
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin");
    if (o.authDisabled) { req.user = { id: "local", email: "local@localhost", name: "Local", role: "admin", mustChangePassword: false }; return next(); }
    const token = parseCookie(req, COOKIE);
    if (token) {
      const row = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.must_change_password,u.disabled,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token)) as any;
      if (row && !row.disabled && row.expires_at > now()) req.user = toUser(row);
    }
    // Cross-site form posts can't set this header, and SameSite=Lax already withholds the cookie; both together.
    if (req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("x-requested-with") !== "research-hub") return res.status(403).json({ error: "missing request header" });
    next();
  });

  const publicUser = (u: AuthUser | undefined) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword } : null);
  const userCount = () => (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;

  app.get("/api/auth/me", (req, res) => {
    const first = userCount() === 0;
    res.json({ user: publicUser(req.user), firstRun: first, setupCodeRequired: first && !!o.setupCode, allowedEmailDomains: o.allowedEmailDomains ?? [] });
  });

  app.post("/api/auth/signup", (req, res) => {
    const b = req.body ?? {};
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address" });
    if (o.allowedEmailDomains?.length && !o.allowedEmailDomains.includes(email.split("@")[1])) return res.status(403).json({ error: `Sign-up is limited to ${o.allowedEmailDomains.map((d) => "@" + d).join(", ")} addresses` });
    const problem = passwordProblem(b.password, email); if (problem) return res.status(400).json({ error: problem });
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : null;
    const hash = hashPassword(b.password);
    db.exec("BEGIN IMMEDIATE");
    try {
      const first = userCount() === 0;
      if (first && o.setupCode && b.setupCode !== o.setupCode) { db.exec("ROLLBACK"); return res.status(403).json({ error: "Setup code required for the first account" }); }
      if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) { db.exec("ROLLBACK"); return res.status(409).json({ error: "An account with this email already exists" }); }
      const id = "u-" + crypto.randomBytes(6).toString("hex");
      db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at,last_login_at) VALUES (?,?,?,?,?,?,?)").run(id, email, name, hash, first ? "admin" : "user", now(), now());
      if (first) { // the first admin inherits everything created before accounts existed
        for (const t of ["answers", "assessments", "study_requests"]) db.prepare(`UPDATE ${t} SET user_id=? WHERE user_id IS NULL`).run(id);
        db.prepare("UPDATE profiles SET id=? WHERE id='me'").run(id);
      }
      audit(db, "auth.signup", { userId: id, role: first ? "admin" : "user" });
      db.exec("COMMIT");
      startSession(res, id);
      res.status(201).json({ user: { id, email, name, role: first ? "admin" : "user", mustChangePassword: false } });
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
  });

  app.post("/api/auth/login", (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const pw = typeof req.body?.password === "string" ? req.body.password : "";
    const k = keyOf(req, email), f = failures.get(k);
    if (f && f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    const row = db.prepare("SELECT id,email,name,role,must_change_password,disabled,password_hash FROM users WHERE email=?").get(email) as any;
    const ok = verifyPassword(pw.slice(0, 200), row?.password_hash ?? DUMMY) && !!row && !row.disabled;
    if (!ok) {
      failures.set(k, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      audit(db, "auth.login_failed", { email: email.slice(0, 80) });
      return res.status(401).json({ error: "Email or password is incorrect" }); // same message whichever part was wrong
    }
    failures.delete(k);
    db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(now(), row.id);
    startSession(res, row.id);
    audit(db, "auth.login", { userId: row.id });
    res.json({ user: publicUser(toUser(row)) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = parseCookie(req, COOKIE);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(token));
    endCookie(res); res.json({ ok: true });
  });

  // everything below this line needs a signed-in user
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    if (req.user.mustChangePassword && req.path !== "/auth/change-password") return res.status(403).json({ error: "Change your temporary password first", code: "must_change_password" });
    next();
  });

  app.post("/api/auth/change-password", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    const { currentPassword, newPassword } = req.body ?? {};
    const row = db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id) as { password_hash: string } | undefined;
    if (!row || typeof currentPassword !== "string" || !verifyPassword(currentPassword.slice(0, 200), row.password_hash)) return res.status(400).json({ error: "Current password is incorrect" });
    const problem = passwordProblem(newPassword, req.user.email); if (problem) return res.status(400).json({ error: problem });
    if (newPassword === currentPassword) return res.status(400).json({ error: "Choose a different password" });
    db.prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?").run(hashPassword(newPassword), req.user.id);
    const token = parseCookie(req, COOKIE);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(req.user.id, token ? sha(token) : ""); // sign out everywhere else
    audit(db, "auth.password_changed", { userId: req.user.id });
    res.json({ ok: true });
  });

  // admin area
  app.use("/api/admin", (req, res, next) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "Research team only" })));

  app.get("/api/admin/users", (_req, res) => {
    res.json(db.prepare("SELECT id,email,name,role,disabled,must_change_password AS mustChangePassword,created_at AS createdAt,last_login_at AS lastLoginAt FROM users ORDER BY created_at").all());
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    const target = db.prepare("SELECT id,role,disabled FROM users WHERE id=?").get(req.params.id) as { id: string; role: string; disabled: number } | undefined;
    if (!target) return res.status(404).json({ error: "not found" });
    const b = req.body ?? {};
    if (b.role !== undefined && !["admin", "user"].includes(b.role)) return res.status(400).json({ error: "bad role" });
    const admins = (db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get() as { n: number }).n;
    const losesAdmin = target.role === "admin" && !target.disabled && ((b.role === "user") || b.disabled === true);
    if (losesAdmin && admins <= 1) return res.status(409).json({ error: "There must be at least one active admin" });
    if (b.disabled === true && target.id === req.user!.id) return res.status(409).json({ error: "You can't disable your own account" });
    db.prepare("UPDATE users SET role=COALESCE(?,role), disabled=COALESCE(?,disabled) WHERE id=?").run(b.role ?? null, b.disabled === undefined ? null : b.disabled ? 1 : 0, target.id);
    if (b.disabled === true) db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    audit(db, "user.update", { by: req.user!.id, userId: target.id, role: b.role ?? null, disabled: b.disabled ?? null });
    res.json({ id: target.id });
  });
  // No email service: an admin issues a temporary password, shown once, which must be changed at next sign-in.
  app.post("/api/admin/users/:id/reset-password", (req, res) => {
    const target = db.prepare("SELECT id FROM users WHERE id=?").get(req.params.id) as { id: string } | undefined;
    if (!target) return res.status(404).json({ error: "not found" });
    const temp = crypto.randomBytes(9).toString("base64url");
    db.prepare("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?").run(hashPassword(temp), target.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    audit(db, "user.password_reset", { by: req.user!.id, userId: target.id });
    res.json({ temporaryPassword: temp });
  });
}

export const requireUser = (req: Request, res: Response, next: NextFunction) => (req.user ? next() : res.status(401).json({ error: "Sign in required" }));

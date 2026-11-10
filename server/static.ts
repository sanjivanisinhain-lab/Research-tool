import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

/** Content-Security-Policy for the app's single page. Inline scripts are allowed only by their exact hash. */
export function buildCsp(shellHtml: string): string {
  // A browser hashes the script text AFTER HTML parsing, which turns a NUL character into U+FFFD (the framework's data script contains one).
  const hashes = [...shellHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash("sha256").update(m[1].replace(/\u0000/g, "\uFFFD")).digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(" ")}`.trim(), "style-src 'self' 'unsafe-inline'", // inline style attributes are used by the UI
    "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "media-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

/** Serve the built single-page app: hashed assets with long caching, everything else falls back to the page shell. Returns false if there is no build. */
export function mountStatic(app: Express, dir: string, opts: { secure?: boolean } = {}): boolean {
  const shellFile = path.join(dir, "_shell.html");
  if (!fs.existsSync(shellFile)) return false;
  const shell = fs.readFileSync(shellFile, "utf8");
  const csp = buildCsp(shell);
  const pageHeaders = (res: express.Response) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()"); // microphone is left to the app (question dictation asks first)
    if (opts.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  };
  app.get("/_shell.html", (_req, res) => res.status(404).end());
  app.use("/assets", express.static(path.join(dir, "assets"), { immutable: true, maxAge: "1y", index: false, fallthrough: false })); // unknown asset = 404, never the page
  app.use(express.static(dir, { index: false, maxAge: "1h", dotfiles: "ignore" }));
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/") || path.extname(req.path)) return next();
    if (req.path.split("/").some((seg) => seg.startsWith("."))) return res.status(404).end(); // /.env, /.git/config and friends are never pages
    pageHeaders(res); res.type("html").send(shell);
  });
  return true;
}

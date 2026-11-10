import fs from "node:fs";
import { openDb } from "./db";
import { createApp } from "./app";
import { startWorker } from "./jobs";
import { providerFromEnv } from "./ai/provider";
import { loadConfig, securityWarnings } from "./config";

process.umask(0o077); // everything we create (database, recordings, name list) is private to the service user
const cfg = loadConfig(process.env);
for (const d of [cfg.dataDir, cfg.mediaDir, cfg.assetsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

const db = openDb(cfg.dbPath);
let ai = null as ReturnType<typeof providerFromEnv> | null;
try { ai = providerFromEnv(); } catch { /* reported by securityWarnings */ }
const userCount = (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
for (const w of securityWarnings(cfg, userCount)) console.warn(`WARNING: ${w}`);

const stopWorker = startWorker(db, ai, 2000, cfg.mediaDir);
const app = createApp(db, {
  ai, includeUnreviewed: cfg.includeUnreviewed, termsPath: cfg.termsPath, mediaDir: cfg.mediaDir, assetsDir: cfg.assetsDir,
  ...(cfg.staticDir ? { staticDir: cfg.staticDir } : {}), limits: { aiPerHour: cfg.rateAiPerHour, notesPerHour: cfg.rateNotesPerHour },
  auth: { allowedEmailDomains: cfg.allowedEmailDomains, ...(cfg.setupCode ? { setupCode: cfg.setupCode } : {}), cookieSecure: cfg.cookieSecure },
});
if (cfg.trustProxy) app.set("trust proxy", 1); // behind a reverse proxy: use the real client address for throttling
const server = app.listen(cfg.port, cfg.host, () => console.log(`Research Hub on http://${cfg.host}:${cfg.port} (${cfg.production ? "production" : "development"}), data in ${cfg.dataDir}`));

// Clean shutdown: stop taking requests, let the worker stop, close the database. Unfinished jobs resume at next start.
let closing = false;
function shutdown(signal: string) {
  if (closing) return; closing = true;
  console.log(`${signal}: shutting down`);
  stopWorker();
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

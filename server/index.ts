import { openDb } from "./db";
import { createApp } from "./app";
import { startWorker } from "./jobs";
import { providerFromEnv } from "./ai/provider";

const db = openDb();

/** Sign-in settings come from the environment so the same build runs anywhere. */
function authFromEnv() {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return {
    allowedEmailDomains: domains,                                   // empty = anyone may sign up
    ...(process.env.ADMIN_SETUP_CODE ? { setupCode: process.env.ADMIN_SETUP_CODE } : {}), // protects the first (admin) sign-up
    cookieSecure: process.env.COOKIE_SECURE === "1",                // set to 1 when served over https
  };
}
const port = Number(process.env.PORT ?? 8787);
let ai = null;
try { ai = providerFromEnv(); } catch { console.warn("GEMINI_API_KEY not set: Ask will return 503 until it is."); }
const includeUnreviewed = process.env.ALLOW_UNREVIEWED === "1";
if (includeUnreviewed) console.warn("ALLOW_UNREVIEWED=1: answers will include evidence the research team has NOT approved, and say so.");
const mediaDir = process.env.MEDIA_DIR ?? "data/uploads";
startWorker(db, ai, 2000, mediaDir);
const app = createApp(db, { ai, includeUnreviewed, termsPath: process.env.REDACTION_TERMS_PATH ?? "data/redaction-terms.json", mediaDir, auth: authFromEnv() });
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1); // behind a reverse proxy: use the real client address for sign-in throttling
const host = process.env.HOST ?? "127.0.0.1"; // set HOST=0.0.0.0 to accept connections from other machines
app.listen(port, host, () => console.log(`API on http://${host}:${port}`));

import { openDb } from "./db";
import { createApp } from "./app";
import { startWorker } from "./jobs";
import { providerFromEnv } from "./ai/provider";

const db = openDb();
const port = Number(process.env.PORT ?? 8787);
let ai = null;
try { ai = providerFromEnv(); } catch { console.warn("GEMINI_API_KEY not set: Ask will return 503 until it is."); }
const includeUnreviewed = process.env.ALLOW_UNREVIEWED === "1";
if (includeUnreviewed) console.warn("ALLOW_UNREVIEWED=1: answers will include evidence the research team has NOT approved, and say so.");
startWorker(db, ai);
createApp(db, { ai, includeUnreviewed, termsPath: process.env.REDACTION_TERMS_PATH ?? "data/redaction-terms.json", adminToken: process.env.ADMIN_TOKEN || undefined }).listen(port, "127.0.0.1", () => console.log(`API on http://127.0.0.1:${port}`));

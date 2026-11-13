import path from "node:path";

export type Config = {
  production: boolean; port: number; host: string; dataDir: string;
  dbPath: string; termsPath: string; mediaDir: string; assetsDir: string; staticDir: string | undefined;
  cookieSecure: boolean; trustProxy: boolean; allowedEmailDomains: string[]; setupCode: string | undefined;
  rateAiPerHour: number; rateNotesPerHour: number; includeUnreviewed: boolean; hasGeminiKey: boolean; figmaToken: string | undefined;
};

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** All settings come from the environment, so the same build runs anywhere. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const production = env["NODE_ENV"] === "production";
  const dataDir = env["DATA_DIR"] ?? "data";
  const host = env["HOST"] ?? "127.0.0.1";
  const localOnly = ["127.0.0.1", "localhost", "::1"].includes(host) && env["TRUST_PROXY"] !== "1"; // only this computer can reach it, over plain http
  return {
    production, port: num(env["PORT"], 8787), host, dataDir,
    dbPath: env["DB_PATH"] ?? path.join(dataDir, "research.sqlite"),
    termsPath: env["REDACTION_TERMS_PATH"] ?? path.join(dataDir, "redaction-terms.json"),
    mediaDir: env["MEDIA_DIR"] ?? path.join(dataDir, "uploads"),
    assetsDir: env["ASSETS_DIR"] ?? path.join(dataDir, "assessments"),
    staticDir: env["STATIC_DIR"] ?? (production ? "dist/client" : undefined),
    cookieSecure: env["COOKIE_SECURE"] !== undefined ? env["COOKIE_SECURE"] === "1" : production && !localOnly, // secure cookies by default when others can reach it (needs https); a local-only run is plain http
    trustProxy: env["TRUST_PROXY"] === "1",
    allowedEmailDomains: (env["ALLOWED_EMAIL_DOMAINS"] ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
    setupCode: env["ADMIN_SETUP_CODE"] || undefined,
    rateAiPerHour: num(env["RATE_AI_PER_HOUR"], 60), rateNotesPerHour: num(env["RATE_NOTES_PER_HOUR"], 20),
    includeUnreviewed: env["ALLOW_UNREVIEWED"] === "1", hasGeminiKey: !!env["GEMINI_API_KEY"], figmaToken: env["FIGMA_TOKEN"] || undefined,
  };
}

/** Plain-language warnings about settings that put research data at risk. Shown at every start. */
export function securityWarnings(c: Config, userCount: number): string[] {
  const w: string[] = [];
  const reachable = c.host !== "127.0.0.1" && c.host !== "localhost" && c.host !== "::1";
  if (!c.allowedEmailDomains.length) w.push("Sign-up is open to ANY email address. Anyone who can reach this server can create an account and read the research. Set ALLOWED_EMAIL_DOMAINS (e.g. snapdeal.com) before others can reach it.");
  if (userCount === 0 && !c.setupCode) w.push("No accounts exist yet and no ADMIN_SETUP_CODE is set: the first person to open the app becomes the admin. Open it yourself first, or set ADMIN_SETUP_CODE.");
  if (reachable && !c.cookieSecure) w.push("Listening beyond this machine with COOKIE_SECURE off: sign-in cookies travel unencrypted unless something in front provides https. Serve over https and set COOKIE_SECURE=1.");
  if (c.cookieSecure && c.production) w.push("COOKIE_SECURE is on: the app must be opened over https (or http://localhost) or sign-in will not stick. For plain-http internal use set COOKIE_SECURE=0.");
  if (c.includeUnreviewed) w.push("ALLOW_UNREVIEWED=1: answers include evidence nobody approved.");
  if (!c.hasGeminiKey) w.push("GEMINI_API_KEY is not set: AI features return 503 and background reading is paused.");
  if (!c.staticDir && c.production) w.push("No web app build found (STATIC_DIR): only the API will be served.");
  return w;
}

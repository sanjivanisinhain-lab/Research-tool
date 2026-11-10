// Usage: bun server/cli.ts ingest <calls-csv|transcript-speaker|transcript-docx> <file> --study "Name" --product Snapdeal [--names "A,B"] [--date 2026-09-20]
import fs from "node:fs";
import { openDb } from "./db";
import { docxToText, ingestCallsCsv, ingestTranscript } from "./ingest";

const [cmd, kind, file, ...rest] = process.argv.slice(2);
if (cmd === "backup" || cmd === "verify-backup" || cmd === "restore") {
  const { createBackup, verifyBackup, restoreBackup } = await import("./backup");
  const { loadConfig } = await import("./config");
  const cfg = loadConfig(process.env); const pass = process.env["BACKUP_PASSPHRASE"] || undefined;
  const paths = { dbPath: cfg.dbPath, termsPath: cfg.termsPath, assetsDir: cfg.assetsDir };
  const dir = process.env["BACKUP_DIR"] ?? `${cfg.dataDir}/backups`;
  try {
    if (cmd === "backup") { const r = createBackup(paths, { outDir: dir, ...(pass ? { passphrase: pass } : {}), keep: Number(process.env["BACKUP_KEEP"] ?? 14) }); console.log(`Backup written: ${r.file}${pass ? " (encrypted)" : " (NOT encrypted: set BACKUP_PASSPHRASE)"}\n`, JSON.stringify(r.manifest.counts)); }
    else if (cmd === "verify-backup") { const r = verifyBackup(kind!, pass); console.log(r.ok ? `OK: backup is intact. ${JSON.stringify(r.counts)}` : `PROBLEMS:\n - ${r.problems.join("\n - ")}`); process.exit(r.ok ? 0 : 1); }
    else { const r = restoreBackup(kind!, paths, { ...(pass ? { passphrase: pass } : {}), force: process.argv.includes("--force") }); console.log(`Restored. ${JSON.stringify(r.counts)}${r.movedTo ? `\nPrevious database kept at ${r.movedTo}` : ""}`); }
  } catch (e) { console.error((e as Error).message); process.exit(1); }
  process.exit(0);
}
if (cmd === "reset-password" || cmd === "make-admin") {
  // Recovery from the command line on the server itself (for example when the only admin forgot their password).
  const { openDb: open2, audit } = await import("./db");
  const { hashPassword } = await import("./auth");
  const crypto = await import("node:crypto");
  const { loadConfig } = await import("./config");
  const d = open2(loadConfig(process.env).dbPath);
  const email = (kind ?? "").trim().toLowerCase();
  const u = d.prepare("SELECT id FROM users WHERE email=?").get(email) as { id: string } | undefined;
  if (!u) { console.error(`No account with the email ${email || "(none given)"}.`); process.exit(1); }
  if (cmd === "make-admin") { d.prepare("UPDATE users SET role='admin', disabled=0 WHERE id=?").run(u.id); audit(d, "cli.make_admin", { userId: u.id }); console.log(`${email} is now an admin.`); }
  else {
    const temp = crypto.randomBytes(9).toString("base64url");
    d.prepare("UPDATE users SET password_hash=?, must_change_password=1, disabled=0 WHERE id=?").run(hashPassword(temp), u.id);
    d.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id); audit(d, "cli.password_reset", { userId: u.id });
    console.log(`Temporary password for ${email}: ${temp}\nThey must choose their own at next sign-in.`);
  }
  process.exit(0);
}
if (cmd === "apply-trust-policy") {
  // Evidence extracted from research-team sources is trusted; approve any that is still pending (logged).
  const { audit } = await import("./db");
  const d = openDb();
  const r = d.prepare("UPDATE evidence SET status='approved' WHERE status='pending' AND source_id IN (SELECT id FROM sources WHERE submitted_by='research_team')").run();
  d.prepare("UPDATE sources SET status='approved' WHERE status='pending' AND submitted_by='research_team'").run();
  audit(d, "policy.research_team_trusted", { evidenceApproved: Number(r.changes) });
  console.log(JSON.stringify({ evidenceApproved: Number(r.changes) }));
  process.exit(0);
}
if (cmd === "themes") {
  const { canonicaliseThemes } = await import("./ai/themes");
  const { providerFromEnv } = await import("./ai/provider");
  console.log(JSON.stringify(await canonicaliseThemes(openDb(), providerFromEnv())));
  process.exit(0);
}
if (cmd === "synthesise") {
  const { synthesise } = await import("./ai/personas");
  const { providerFromEnv } = await import("./ai/provider");
  const r = await synthesise(openDb(), providerFromEnv(), { includePending: process.argv.includes("--include-unreviewed") });
  console.log(JSON.stringify(r));
  process.exit(0);
}
if (cmd === "extract") {
  const { extractSource } = await import("./ai/extract");
  const { providerFromEnv } = await import("./ai/provider");
  const db0 = openDb();
  const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 1e9;
  const type = process.argv.includes("--type") ? process.argv[process.argv.indexOf("--type") + 1] : null;
  const rows = db0.prepare("SELECT id FROM sources WHERE (? IS NULL OR source_type=?) ORDER BY created_at, id").all(type, type) as { id: string }[];
  const ai = providerFromEnv();
  let n = 0;
  for (const { id } of rows.slice(0, limit)) {
    try { const r = await extractSource(db0, ai, id); console.log(JSON.stringify(r)); n++; }
    catch (e) { console.error(id, (e as Error).message); }
  }
  console.log("done", n);
  process.exit(0);
}
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd !== "ingest" || !kind || !file) { console.error("usage: ingest <kind> <file> --study NAME --product NAME"); process.exit(1); }
const db = openDb();
const submittedBy = process.argv.includes("--contributor") ? "contributor" as const : "research_team" as const;
const termsPath = process.env.REDACTION_TERMS_PATH ?? `${process.env.DATA_DIR ?? "data"}/redaction-terms.json`;
const study = flag("study") ?? "Untitled study";
const product = flag("product") ?? "";
const names = (flag("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
let res;
if (kind === "calls-csv") res = ingestCallsCsv(db, fs.readFileSync(file, "utf8"), { studyName: study, product, termsPath, submittedBy });
else if (kind === "transcript-speaker") res = ingestTranscript(db, fs.readFileSync(file, "utf8"), { studyName: study, product, knownNames: names, termsPath, submittedBy, noisy: true, format: "speaker_blocks", date: flag("date") });
else if (kind === "transcript-docx") res = ingestTranscript(db, await docxToText(fs.readFileSync(file)), { studyName: study, product, knownNames: names, termsPath, submittedBy, format: "labelled", date: flag("date") });
else { console.error("unknown kind", kind); process.exit(1); }
console.log(JSON.stringify(res, null, 2));

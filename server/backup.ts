import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAGIC = Buffer.from("RHB1"); // marks an encrypted backup
type Entry = { path: string; sha256: string; bytes: number };
export type Manifest = { version: 1; createdAt: string; files: Entry[]; counts: Record<string, number> };
export type BackupPaths = { dbPath: string; termsPath: string; assetsDir: string };

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const tmp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `rh-${label}-`));
const walk = (dir: string, base = dir): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]) : [];

function key(pass: string, salt: Buffer) { return crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }); }
/** AES-256-GCM with a key derived from the passphrase. Layout: magic | salt | iv | ciphertext | tag. */
export function encryptFile(src: string, dest: string, pass: string) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(pass, salt), iv);
  const body = Buffer.concat([c.update(fs.readFileSync(src)), c.final()]);
  fs.writeFileSync(dest, Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]), { mode: 0o600 });
}
export function decryptFile(src: string, dest: string, pass: string) {
  const b = fs.readFileSync(src);
  if (!b.subarray(0, 4).equals(MAGIC)) throw new Error("not an encrypted backup");
  const d = crypto.createDecipheriv("aes-256-gcm", key(pass, b.subarray(4, 20)), b.subarray(20, 32));
  d.setAuthTag(b.subarray(b.length - 16));
  try { fs.writeFileSync(dest, Buffer.concat([d.update(b.subarray(32, b.length - 16)), d.final()])); }
  catch { throw new Error("wrong passphrase, or the backup is damaged"); }
}
const isEncrypted = (f: string) => { const fd = fs.openSync(f, "r"); const h = Buffer.alloc(4); fs.readSync(fd, h, 0, 4, 0); fs.closeSync(fd); return h.equals(MAGIC); };

/** Consistent snapshot of the database plus the files that go with it, as one archive (optionally encrypted). Safe to run while the app is running. */
export function createBackup(p: BackupPaths, o: { outDir: string; passphrase?: string; keep?: number; now?: Date }): { file: string; manifest: Manifest } {
  const stage = tmp("bk");
  try {
    const db = new DatabaseSync(p.dbPath);
    try { db.exec(`VACUUM INTO '${path.join(stage, "research.sqlite").replace(/'/g, "''")}'`); } finally { db.close(); }
    if (fs.existsSync(p.termsPath)) fs.copyFileSync(p.termsPath, path.join(stage, "redaction-terms.json"));
    for (const f of walk(p.assetsDir)) { const to = path.join(stage, "assessments", f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(p.assetsDir, f), to); }
    const snap = new DatabaseSync(path.join(stage, "research.sqlite"), { readOnly: true });
    const counts: Record<string, number> = {};
    for (const t of ["sources", "participants", "evidence", "users", "answers"]) {
      try { counts[t] = (snap.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n; } catch { /* an older database may not have this table yet */ }
    }
    snap.close();
    const files = walk(stage).map((f) => ({ path: f.split(path.sep).join("/"), sha256: sha256(path.join(stage, f)), bytes: fs.statSync(path.join(stage, f)).size }));
    const manifest: Manifest = { version: 1, createdAt: (o.now ?? new Date()).toISOString(), files, counts };
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(o.outDir, { recursive: true, mode: 0o700 });
    const base = path.join(o.outDir, `rh-backup-${manifest.createdAt.replace(/[:.]/g, "-")}.tar.gz`);
    execFileSync("tar", ["-czf", base, "-C", stage, "."]);
    let file = base;
    if (o.passphrase) { file = `${base}.enc`; encryptFile(base, file, o.passphrase); fs.rmSync(base); }
    fs.chmodSync(file, 0o600);
    const keep = o.keep ?? 14;
    const all = fs.readdirSync(o.outDir).filter((f) => f.startsWith("rh-backup-")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(o.outDir, old));
    return { file, manifest };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function open(archive: string, pass: string | undefined): { dir: string; manifest: Manifest } {
  const dir = tmp("rs");
  try {
    let tgz = archive;
    if (isEncrypted(archive)) { if (!pass) throw new Error("this backup is encrypted: a passphrase is required"); tgz = path.join(dir, "archive.tar.gz"); decryptFile(archive, tgz, pass); }
    const out = path.join(dir, "x"); fs.mkdirSync(out);
    try { execFileSync("tar", ["-xzf", tgz, "-C", out], { stdio: "pipe" }); } catch { throw new Error("the archive is damaged or not a backup"); }
    if (!fs.existsSync(path.join(out, "manifest.json"))) throw new Error("the archive has no manifest");
    return { dir: out, manifest: JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) as Manifest };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

/** Check a backup without touching live data: every file matches its recorded hash, the database is intact, search works, counts match. */
export function verifyBackup(archive: string, passphrase?: string): { ok: boolean; problems: string[]; counts: Record<string, number> } {
  const problems: string[] = []; const { dir, manifest } = open(archive, passphrase);
  try {
    for (const f of manifest.files) {
      const full = path.join(dir, f.path);
      if (!fs.existsSync(full)) problems.push(`missing file ${f.path}`);
      else if (sha256(full) !== f.sha256) problems.push(`file changed or damaged: ${f.path}`);
    }
    const dbFile = path.join(dir, "research.sqlite");
    if (fs.existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const ic = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
        if (ic !== "ok") problems.push(`database integrity check: ${ic}`);
        if (db.prepare("PRAGMA foreign_key_check").all().length) problems.push("foreign key problems in the database");
        try { db.prepare("SELECT COUNT(*) n FROM evidence_fts WHERE evidence_fts MATCH 'a OR the OR delivery'").get(); } catch { problems.push("the search index could not be read"); }
        for (const [t, n] of Object.entries(manifest.counts)) {
          try { const got = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n; if (got !== n) problems.push(`${t}: expected ${n} rows, found ${got}`); }
          catch { if (n !== 0) problems.push(`table ${t} unreadable`); } // a table that is absent and was recorded as 0 rows (older backups) is fine
        }
      } finally { db.close(); }
    } else problems.push("the backup has no database");
    return { ok: problems.length === 0, problems, counts: manifest.counts };
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
}

/** Put a verified backup back. Refuses to overwrite an existing database unless forced (then the old one is kept beside it). */
export function restoreBackup(archive: string, p: BackupPaths, o: { passphrase?: string; force?: boolean }): { counts: Record<string, number>; movedTo?: string } {
  const v = verifyBackup(archive, o.passphrase);
  if (!v.ok) throw new Error(`backup failed verification: ${v.problems.join("; ")}`);
  if (fs.existsSync(p.dbPath) && !o.force) throw new Error(`${p.dbPath} already exists: stop the app and use --force to replace it (the old one is kept)`);
  const { dir } = open(archive, o.passphrase);
  try {
    let movedTo: string | undefined;
    if (fs.existsSync(p.dbPath)) { movedTo = `${p.dbPath}.before-restore-${Date.now()}`; fs.renameSync(p.dbPath, movedTo); for (const ext of ["-wal", "-shm"]) fs.rmSync(p.dbPath + ext, { force: true }); }
    fs.mkdirSync(path.dirname(p.dbPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(dir, "research.sqlite"), p.dbPath); fs.chmodSync(p.dbPath, 0o600);
    if (fs.existsSync(path.join(dir, "redaction-terms.json"))) { fs.mkdirSync(path.dirname(p.termsPath), { recursive: true }); fs.copyFileSync(path.join(dir, "redaction-terms.json"), p.termsPath); fs.chmodSync(p.termsPath, 0o600); }
    for (const f of walk(path.join(dir, "assessments"))) { const to = path.join(p.assetsDir, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(dir, "assessments", f), to); }
    return { counts: v.counts, ...(movedTo ? { movedTo } : {}) };
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
}

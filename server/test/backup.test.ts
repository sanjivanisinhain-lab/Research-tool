// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { createBackup, restoreBackup, verifyBackup } from "../backup";

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-world-"));
  const p = { dbPath: path.join(root, "data", "research.sqlite"), termsPath: path.join(root, "data", "terms.json"), assetsDir: path.join(root, "data", "assessments") };
  fs.mkdirSync(p.assetsDir, { recursive: true });
  const db = openDb(p.dbPath);
  db.exec(`INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P1','S','{}','x');
    INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('X','S','P1','cx_call','researcher_notes','t','x');
    INSERT INTO evidence(source_id,participant_id,original_text,translation,kind,provenance,theme,sentiment,status,created_at) VALUES ('X','P1','delivery late','delivery arrives late','said','participant_verbatim','delivery','negative','approved','x');
    INSERT INTO users(id,email,password_hash,role,created_at) VALUES ('u1','a@b.co','scrypt$x','admin','x');`);
  fs.writeFileSync(p.termsPath, JSON.stringify({ names: ["Asha"], places: [] }));
  fs.writeFileSync(path.join(p.assetsDir, "asm-1.png"), Buffer.from("fake-image-bytes"));
  return { root, p, db, out: path.join(root, "backups") };
}

describe("backup and restore", () => {
  it("backs up while the database is open, verifies, and restores database, search index and files", () => {
    const w = world();
    const { file, manifest } = createBackup(w.p, { outDir: w.out });
    expect(manifest.counts).toMatchObject({ sources: 1, evidence: 1, users: 1 });
    expect(verifyBackup(file)).toMatchObject({ ok: true, problems: [] });
    // disaster: evidence deleted, a file lost, the name list wiped
    w.db.exec("DELETE FROM evidence"); w.db.close(); fs.rmSync(path.join(w.p.assetsDir, "asm-1.png")); fs.rmSync(w.p.termsPath);
    expect(() => restoreBackup(file, w.p, {})).toThrow(/already exists/); // never overwrites silently
    const r = restoreBackup(file, w.p, { force: true });
    expect(r.movedTo).toBeTruthy(); expect(fs.existsSync(r.movedTo!)).toBe(true); // the previous database is kept
    const db = openDb(w.p.dbPath);
    expect((db.prepare("SELECT COUNT(*) n FROM evidence").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM evidence_fts WHERE evidence_fts MATCH 'delivery'").get() as any).n).toBe(1); // search works again
    expect(fs.readFileSync(path.join(w.p.assetsDir, "asm-1.png")).toString()).toBe("fake-image-bytes");
    expect(JSON.parse(fs.readFileSync(w.p.termsPath, "utf8")).names).toEqual(["Asha"]);
    expect(fs.statSync(w.p.dbPath).mode & 0o077).toBe(0); // private to the owner
  });
  it("encrypts when given a passphrase: no readable data in the file, wrong passphrase refused, right one works", () => {
    const w = world();
    const { file } = createBackup(w.p, { outDir: w.out, passphrase: "correct horse battery" });
    expect(file.endsWith(".enc")).toBe(true);
    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from("SQLite format 3"))).toBe(false); expect(raw.includes(Buffer.from("Asha"))).toBe(false);
    expect(() => verifyBackup(file)).toThrow(/passphrase/);
    expect(() => verifyBackup(file, "wrong passphrase!!")).toThrow(/wrong passphrase/);
    expect(verifyBackup(file, "correct horse battery").ok).toBe(true);
  });
  it("detects a damaged backup", () => {
    const w = world();
    const { file } = createBackup(w.p, { outDir: w.out });
    const b = fs.readFileSync(file); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(file, b);
    expect(() => { const r = verifyBackup(file); if (!r.ok) throw new Error(r.problems.join(";")); }).toThrow();
  });
  it("keeps only the newest N backups", () => {
    const w = world();
    for (let i = 0; i < 4; i++) createBackup(w.p, { outDir: w.out, keep: 2, now: new Date(Date.UTC(2026, 10, 1 + i)) });
    expect(fs.readdirSync(w.out).filter((f) => f.startsWith("rh-backup-"))).toHaveLength(2);
  });
});

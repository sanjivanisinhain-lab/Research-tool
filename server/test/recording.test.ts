// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDb } from "../db";
import { createApp } from "../app";
import { MockProvider } from "../ai/provider";
import { runNextJob, cleanupUploads } from "../jobs";
import { ffmpegAvailable } from "../media";

const hasFfmpeg = await ffmpegAvailable();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-rec-"));
const db = openDb(":memory:");
let server: Server; let base = ""; let sample: Buffer;

beforeAll(() => {
  if (hasFfmpeg) { // 11 minutes of tone -> three 5-minute chunks
    const f = path.join(dir, "tone.mp3");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=650", "-b:a", "16k", f]);
    sample = fs.readFileSync(f);
  }
  server = createApp(db, { auth: { authDisabled: true }, mediaDir: path.join(dir, "uploads"), maxMediaBytes: 50 * 1024 * 1024 }).listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const put = (qs: string, body: Buffer) => fetch(`${base}/api/admin/upload?${qs}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: body as any });

describe.skipIf(!hasFfmpeg)("recording upload and transcription", () => {
  it("refuses without the privacy acknowledgement, and without a study", async () => {
    expect((await put("study=Rec&filename=a.mp3", sample)).status).toBe(400);
    expect((await put("study=&filename=a.mp3&ack=1", sample)).status).toBe(400);
  });
  it("queues, transcribes in chunks with correct timestamps, redacts, deletes the recording, queues extraction", async () => {
    const r = await put("study=Rec&product=Shop&kind=interview&names=Rakesh&filename=Rakesh-call.mp3&ack=1", sample);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ status: "queued", jobsQueued: 1 });
    expect(fs.readdirSync(path.join(dir, "uploads"))).toHaveLength(1);

    let call = 0;
    const ai = new MockProvider(() => ({ turns: [{ speaker: "interviewer", start_seconds: 2, text: "Aap kaise shopping karte hain?" }, { speaker: "participant", start_seconds: 9.5, text: `Main Rakesh bol raha hoon, ${++call}. COD use karta hoon, call me on 9876543210` }] }));
    expect(await runNextJob(db, ai)).toBe(true);
    expect(ai.calls).toBe(3);
    expect(ai.media.every((m) => m.length === 1 && m[0].mimeType === "audio/mp3" && m[0].data.length > 1000)).toBe(true);

    const u = db.prepare("SELECT speaker, text, start_sec FROM utterances ORDER BY seq").all() as { speaker: string; text: string; start_sec: number }[];
    expect(u).toHaveLength(6);
    expect(u.map((x) => x.start_sec)).toEqual([2, 9.5, 302, 309.5, 602, 609.5]); // each chunk offset by 300 s
    expect(JSON.stringify(u)).not.toMatch(/Rakesh|9876543210/);
    expect(db.prepare("SELECT quality, origin, submitted_by, status FROM sources").get()).toEqual({ quality: "asr_gemini", origin: "verbatim_transcript", submitted_by: "research_team", status: "approved" });
    expect(fs.readdirSync(path.join(dir, "uploads"))).toHaveLength(0); // recording not kept
    expect(db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='extract' AND status='queued'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT status, note FROM jobs WHERE kind='transcribe'").get()).toMatchObject({ status: "done", note: "Transcribed 6 turns from 3 parts" });
  });
  it("does not transcribe the same recording twice", async () => {
    const r = await (await put("study=Rec&filename=copy.mp3&ack=1", sample)).json();
    expect(r.message).toMatch(/already imported/i);
    expect(db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='transcribe'").get()).toEqual({ n: 1 });
  });
  it("records a failure with a reason and keeps the file for retry; silence is reported", async () => {
    const other = Buffer.concat([sample, Buffer.from([0])]); // different hash
    await put("study=Rec2&filename=b.mp3&ack=1", other);
    const ai = new MockProvider(() => ({ turns: [] }));
    while (await runNextJob(db, ai)); // drain: earlier extraction jobs run first
    expect(db.prepare("SELECT status, error FROM jobs WHERE id=(SELECT MAX(id) FROM jobs WHERE kind='transcribe')").get()).toEqual({ status: "failed", error: "No speech was found in this recording" });
    expect(fs.readdirSync(path.join(dir, "uploads"))).toHaveLength(1);
    cleanupUploads(db, path.join(dir, "uploads"), 0); // still needed by the failed job: kept
    expect(fs.readdirSync(path.join(dir, "uploads"))).toHaveLength(1);
  });
  it("rejects a file that is not really audio, with a clear reason", async () => {
    await put("study=Rec3&filename=fake.mp3&ack=1", Buffer.from("this is not audio at all"));
    const ai = new MockProvider(() => ({ turns: [] }));
    while (await runNextJob(db, ai));
    const j = db.prepare("SELECT status, error FROM jobs WHERE id=(SELECT MAX(id) FROM jobs WHERE kind='transcribe')").get() as { status: string; error: string };
    expect(j.status).toBe("failed");
    expect(j.error.length).toBeGreaterThan(5);
  });
});

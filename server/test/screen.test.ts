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
import { runNextJob } from "../jobs";
import { extractSource } from "../ai/extract";
import { ffmpegAvailable } from "../media";

const hasFfmpeg = await ffmpegAvailable();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-screen-"));
const db = openDb(":memory:");
let server: Server; let base = ""; let withSound: Buffer; let silent: Buffer; let audioOnly: Buffer;

beforeAll(() => {
  if (hasFfmpeg) { // 310 s: two 5-minute audio parts, three 150 s picture clips
    const v = (name: string, extra: string[]) => { const f = path.join(dir, name); execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...extra, f]); return fs.readFileSync(f); };
    withSound = v("av.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=2:duration=310", "-f", "lavfi", "-i", "sine=frequency=300:duration=310", "-c:v", "libx264", "-crf", "40", "-b:a", "16k", "-shortest"]);
    silent = v("silent.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=2:duration=20", "-c:v", "libx264", "-crf", "40"]);
    audioOnly = v("a.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-b:a", "16k"]);
  }
  server = createApp(db, { auth: { authDisabled: true }, mediaDir: path.join(dir, "uploads") }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const put = (qs: string, body: Buffer) => fetch(`${base}/api/admin/upload?${qs}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: body as any });
const ACK = "ack=1&screen=1&ackScreen=1";

const ai = (log: { audio: number; video: number } = { audio: 0, video: 0 }) => new MockProvider((req) => {
  if (req.system.includes("screen recording")) {
    log.video++;
    return { observations: [
      { start_seconds: 10, action: "view", friction: "none", description: "The screen shows the cart with Rs 998 total." },
      { start_seconds: 20, action: "wait", friction: "hesitation", description: "The participant pauses on the cart screen for 10 seconds, where Rakesh Sharma's address 12 MG Road is shown." }] };
  }
  if (!req.system.includes("You transcribe")) return { findings: [] }; // evidence extraction jobs also run in the queue
  log.audio++;
  return { turns: [{ speaker: "participant", start_seconds: 15, text: "Delivery charge dekh ke rukna pada" }] };
});

describe.skipIf(!hasFfmpeg)("screen recording analysis", () => {
  it("requires its own privacy acknowledgement, and a file that has a picture", async () => {
    expect((await put("study=Scr&filename=a.mp4&ack=1&screen=1", withSound)).status).toBe(400); // screen without ackScreen
    const noPic = await put(`study=Scr&filename=a.mp3&${ACK}`, audioOnly);
    expect(noPic.status).toBe(400); expect((await noPic.json()).error).toMatch(/no picture/i);
    expect(fs.existsSync(path.join(dir, "uploads")) ? fs.readdirSync(path.join(dir, "uploads")).length : 0).toBe(0); // rejected file not kept
  });
  it("transcribes speech and describes the screen in one session, interleaved in time, redacted, flagged as machine output", async () => {
    const r = await put(`study=Scr&product=Shop&names=Rakesh%20Sharma&filename=session.mp4&${ACK}`, withSound);
    expect(r.status).toBe(202); expect((await r.json()).message).toMatch(/screen analysis/i);
    const log = { audio: 0, video: 0 }; const mock = ai(log);
    while (await runNextJob(db, mock));
    expect(log).toEqual({ audio: 2, video: 3 });
    const mimes = mock.media.flat().map((m) => m.mimeType);
    expect(mimes.filter((m) => m === "video/mp4")).toHaveLength(3); expect(mimes.filter((m) => m === "audio/mp3")).toHaveLength(2);

    const u = db.prepare("SELECT speaker, start_sec s, text FROM utterances ORDER BY seq").all() as { speaker: string; s: number; text: string }[];
    expect(u.map((x) => x.s)).toEqual([...u.map((x) => x.s)].sort((a, b) => a - b)); // time order
    expect(u.filter((x) => x.speaker === "screen").map((x) => Math.round(x.s))).toEqual([10, 20, 160, 170, 310, 320]); // clip offsets about 0, 150, 300 (taken from each clip's real length)
    expect(u.find((x) => x.speaker === "screen" && x.s === 20)!.text).toContain("Friction: hesitation.");
    expect(JSON.stringify(u)).not.toMatch(/Rakesh|Sharma/); // names removed even when the model copied them
    expect(db.prepare("SELECT quality, origin FROM sources").get()).toEqual({ quality: "asr_screen_gemini", origin: "verbatim_transcript" });
    expect(db.prepare("SELECT status FROM jobs WHERE kind='transcribe' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ status: "done" });
  });
  it("evidence from screen lines is marked as an AI observation of behaviour, never as the participant's words", async () => {
    const src = db.prepare("SELECT id FROM sources").get() as { id: string };
    const line = db.prepare("SELECT id FROM utterances WHERE source_id=? AND speaker='screen' AND start_sec=20").get(src.id) as { id: number };
    const ext = new MockProvider(() => ({ findings: [{ utterance_id: line.id, quote: "The participant pauses on the cart screen for 10 seconds", kind: "said", theme: "cart hesitation", sentiment: "negative" }] }));
    db.prepare("DELETE FROM extraction_runs").run(); // the queued extraction job already ran (and cached) with the stand-in model
    await extractSource(db, ext, src.id);
    expect(db.prepare("SELECT kind, provenance, flags FROM evidence WHERE source_id=?").get(src.id)).toMatchObject({ kind: "did", provenance: "screen_observation" });
    expect((db.prepare("SELECT flags FROM evidence WHERE source_id=?").get(src.id) as any).flags).toContain("ai_observation");
  });
  it("lets an admin read the stored transcript, with times and speakers, to check machine output", async () => {
    const src = db.prepare("SELECT id FROM sources").get() as { id: string };
    const body = await (await fetch(`${base}/api/admin/sources/${src.id}/utterances`)).json();
    expect(body.quality).toBe("asr_screen_gemini");
    expect(body.utterances.some((x: any) => x.speaker === "screen" && x.startSec === 160)).toBe(true);
    expect((await fetch(`${base}/api/admin/sources/nope/utterances`)).status).toBe(404);
  });
  it("handles a silent screen recording (picture only) and explains a silent one without the option", async () => {
    await put(`study=Silent&filename=s.mp4&${ACK}`, silent);
    const log = { audio: 0, video: 0 };
    while (await runNextJob(db, ai(log)));
    expect(log).toEqual({ audio: 0, video: 1 }); // no audio track: no speech call
    await put("study=Silent2&filename=s2.mp4&ack=1", Buffer.concat([silent, Buffer.from([0])]));
    while (await runNextJob(db, ai()));
    expect(db.prepare("SELECT status, error FROM jobs WHERE kind='transcribe' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ status: "failed", error: expect.stringMatching(/no audio track/i) });
  });
});

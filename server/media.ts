import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const run = promisify(execFile);
export const MEDIA_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".mp4", ".mov", ".mkv", ".webm", ".avi", ".3gp"]);
export const CHUNK_SECONDS = 300; // keeps each AI request short and its output well inside limits

export async function ffmpegAvailable(): Promise<boolean> {
  try { await run("ffmpeg", ["-version"]); return true; } catch { return false; }
}

export async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("Could not read the recording (no audio found)");
  return n;
}

/** Extract the audio track (video is ignored), downmix to mono 16 kHz and split into fixed-length chunks. */
export async function toAudioChunks(input: string, outDir: string, chunkSeconds = CHUNK_SECONDS): Promise<{ file: string; offset: number }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1", path.join(outDir, "chunk%03d.mp3")], { maxBuffer: 10 * 1024 * 1024 });
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith("chunk") && f.endsWith(".mp3")).sort();
  if (!files.length) throw new Error("No audio could be extracted from this file");
  return withOffsets(files.map((f) => path.join(outDir, f)));
}

/** Which kinds of stream a file has ("audio", "video"). */
export async function streamKinds(file: string): Promise<{ audio: boolean; video: boolean }> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
    const kinds = new Set(stdout.split(/\s+/).filter(Boolean));
    return { audio: kinds.has("audio"), video: kinds.has("video") };
  } catch { return { audio: false, video: false }; }
}

let h264: boolean | undefined;
async function hasH264(): Promise<boolean> {
  if (h264 === undefined) { try { h264 = (await run("ffmpeg", ["-hide_banner", "-encoders"])).stdout.includes("libx264"); } catch { h264 = false; } }
  return h264;
}

export const VIDEO_CHUNK_SECONDS = 150;

/** Shrink the picture (no sound) into short clips small enough to send inline: capped size, 2 frames a second. Screens barely change, so this compresses very well. */
export async function toVideoChunks(input: string, outDir: string, chunkSeconds = VIDEO_CHUNK_SECONDS): Promise<{ file: string; offset: number }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const codec = (await hasH264()) ? ["-c:v", "libx264", "-crf", "30", "-preset", "veryfast"] : ["-c:v", "mpeg4", "-q:v", "8"];
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", input, "-an", "-vf", "scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=2,format=yuv420p", ...codec,
    "-force_key_frames", `expr:gte(t,n_forced*${chunkSeconds})`, "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1", "-segment_format", "mp4", path.join(outDir, "clip%03d.mp4")], { maxBuffer: 10 * 1024 * 1024 });
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith("clip") && f.endsWith(".mp4")).sort();
  if (!files.length) throw new Error("No picture could be extracted from this file");
  return withOffsets(files.map((f) => path.join(outDir, f)));
}

/** Start time of each clip = the real length of the clips before it (cuts never land exactly where asked, so never assume a fixed length). */
async function withOffsets(files: string[]): Promise<{ file: string; offset: number }[]> {
  const out: { file: string; offset: number }[] = []; let t = 0;
  for (const f of files) { out.push({ file: f, offset: t }); t += await durationSeconds(f).catch(() => 0); }
  return out;
}

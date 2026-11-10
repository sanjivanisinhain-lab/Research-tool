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
  return files.map((f, i) => ({ file: path.join(outDir, f), offset: i * chunkSeconds }));
}

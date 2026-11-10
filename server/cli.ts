// Usage: bun server/cli.ts ingest <calls-csv|transcript-speaker|transcript-docx> <file> --study "Name" --product Snapdeal [--names "A,B"] [--date 2026-09-20]
import fs from "node:fs";
import { openDb } from "./db";
import { docxToText, ingestCallsCsv, ingestTranscript } from "./ingest";

const [cmd, kind, file, ...rest] = process.argv.slice(2);
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
const termsPath = process.env.REDACTION_TERMS_PATH ?? "data/redaction-terms.json";
const study = flag("study") ?? "Untitled study";
const product = flag("product") ?? "";
const names = (flag("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
let res;
if (kind === "calls-csv") res = ingestCallsCsv(db, fs.readFileSync(file, "utf8"), { studyName: study, product, termsPath });
else if (kind === "transcript-speaker") res = ingestTranscript(db, fs.readFileSync(file, "utf8"), { studyName: study, product, knownNames: names, termsPath, noisy: true, format: "speaker_blocks", date: flag("date") });
else if (kind === "transcript-docx") res = ingestTranscript(db, await docxToText(fs.readFileSync(file)), { studyName: study, product, knownNames: names, termsPath, format: "labelled", date: flag("date") });
else { console.error("unknown kind", kind); process.exit(1); }
console.log(JSON.stringify(res, null, 2));

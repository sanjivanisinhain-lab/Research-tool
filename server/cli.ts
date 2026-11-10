// Usage: bun server/cli.ts ingest <calls-csv|transcript-speaker|transcript-docx> <file> --study "Name" --product Snapdeal [--names "A,B"] [--date 2026-09-20]
import fs from "node:fs";
import { openDb } from "./db";
import { docxToText, ingestCallsCsv, ingestTranscript } from "./ingest";

const [cmd, kind, file, ...rest] = process.argv.slice(2);
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

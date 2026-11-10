// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import * as XLSX from "xlsx";
import { openDb } from "../db";
import { createApp } from "../app";
import { detectTranscriptFormat } from "../upload";
import { enqueueExtractions, enqueueRebuild, retryJob, runNextJob } from "../jobs";
import { MockProvider } from "../ai/provider";

const CSV = "name,city,mobile number,notes,date\nAsha Verma,Pune,9876543210,\"Prefers COD, said \"\"delivery late\"\"\",17-09-2026\n";
const db = openDb(":memory:");
let server: Server; let base = "";
beforeAll(() => { server = createApp(db, { auth: { authDisabled: true } }).listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`; });
afterAll(() => server.close());
const put = (qs: string, body: Buffer | string, token = "secret") => fetch(`${base}/api/admin/upload?${qs}`, { method: "PUT", headers: { "x-admin-token": token, "content-type": "application/octet-stream" }, body: body as any });

describe("upload endpoint", () => {
  it("imports a call-notes CSV with case-insensitive headers, redacts PII, queues extraction, trusts research team", async () => {
    const r = await put("study=Calls&product=Shop&filename=Asha.csv", CSV);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ status: "processed", sourcesAdded: 1, jobsQueued: 1 });
    const sources = await (await fetch(`${base}/api/admin/sources`, { headers: { "x-admin-token": "secret" } })).json();
    expect(sources[0]).toMatchObject({ status: "approved", submittedBy: "research_team", job: "queued" });
    expect(JSON.stringify(sources)).not.toMatch(/Asha|Pune|9876543210/); // filename and PII never stored
    expect(JSON.stringify(db.prepare("SELECT text FROM utterances").all())).not.toMatch(/Asha|Verma|Pune|9876543210/);
  });
  it("re-uploading is idempotent and queues nothing new", async () => {
    const body = await (await put("study=Calls&product=Shop&filename=again.csv", CSV)).json();
    expect(body).toMatchObject({ sourcesAdded: 0, jobsQueued: 0 });
    expect(body.message).toMatch(/already imported/i);
  });
  it("handles Excel sheets, skipping sheets without a Notes column and saying so", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Notes"], ["Ravi Rao", "Orders mostly online, delivery on time"]]), "Calls");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Totals"], [5]]), "Summary");
    const r = await put("study=Xl&filename=x.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect(await r.json()).toMatchObject({ status: "partial", sourcesAdded: 1 });
  });
  it("reports unsupported and unusable files clearly, never silently", async () => {
    const av = await put("study=S&filename=call.mp3", Buffer.from("x"));
    expect(av.status).toBe(400); // recordings need the privacy acknowledgement first
    expect((await av.json()).error).toMatch(/Gemini/);
    const noNotes = await (await put("study=S&filename=b.csv", "a,b\n1,2\n")).json();
    expect(noNotes).toMatchObject({ status: "failed" });
    expect(noNotes.message).toMatch(/Notes/);
    expect((await put("study=S&filename=z.zip", Buffer.from("x"))).status).toBe(422);
    expect((await put("study=&filename=a.csv", CSV)).status).toBe(400);
  });
  it("plain text notes become trusted researcher notes with the names you give removed", async () => {
    const r = await put("study=Notes&kind=cx_call&names=Meera&filename=n.txt", "Meera said the delivery was late again and she will not order.");
    expect(await r.json()).toMatchObject({ status: "processed", format: "plain text / notes" });
    expect(JSON.stringify(db.prepare("SELECT text FROM utterances WHERE text LIKE '%delivery was late again%'").all())).not.toContain("Meera");
  });
});

function tinyPdf(text: string): Buffer {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
describe("pdf", () => {
  it("reads a text PDF and flags one with no readable text (needs OCR)", async () => {
    const ok = await (await put("study=Pdf&filename=a.pdf", tinyPdf("Interviewer: hello there how do you shop online? Participant: mostly on Snapdeal because delivery is quick and prices are fair"))).json();
    expect(ok).toMatchObject({ status: "processed", sourcesAdded: 1 });
    const scanned = await put("study=Pdf&filename=scan.pdf", tinyPdf(""));
    expect(scanned.status).toBe(422);
    expect((await scanned.json()).message).toMatch(/scanned/i);
  });
});

describe("format detection and jobs", () => {
  it("detects transcript formats", () => {
    expect(detectTranscriptFormat("Speaker A ............... 00:00:07\nhi")).toBe("speaker_blocks");
    expect(detectTranscriptFormat("Interviewer: hi\nParticipant: hello")).toBe("labelled");
    expect(detectTranscriptFormat("just some notes")).toBe("plain");
  });
  it("runs queued extraction jobs, records failures, supports retry, and enqueueing is idempotent", async () => {
    const d = openDb(":memory:");
    d.exec(`INSERT INTO studies VALUES ('S','s','p','x'); INSERT INTO participants VALUES ('P001','S','{}','x');
      INSERT INTO sources(id,study_id,participant_id,source_type,origin,title,created_at) VALUES ('A','S','P001','cx_call','researcher_notes','t','x');
      INSERT INTO utterances(source_id,participant_id,speaker,seq,text) VALUES ('A','P001','note',0,'delivery was late')`);
    expect(enqueueExtractions(d)).toBe(1); expect(enqueueExtractions(d)).toBe(0);
    let fail = true;
    const ai = new MockProvider(() => { if (fail) throw new Error("boom"); return { findings: [] }; });
    await runNextJob(d, ai);
    expect(d.prepare("SELECT status, error FROM jobs").get()).toEqual({ status: "failed", error: "boom" });
    fail = false; expect(retryJob(d, 1)).toBe(true);
    await runNextJob(d, ai);
    expect(d.prepare("SELECT status FROM jobs").get()).toEqual({ status: "done" });
    expect(await runNextJob(d, ai)).toBe(false);
    expect(enqueueRebuild(d)).toBe(enqueueRebuild(d)); // one open rebuild at a time
  });
});

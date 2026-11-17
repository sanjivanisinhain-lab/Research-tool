// A research sheet that arrives as an uploaded Excel or CSV file instead of a Google Sheet. It goes through the same review and sync as a linked sheet.
import fs from "node:fs";
import path from "node:path";
import type { SheetsClient } from "./google";

export type FileTab = { title: string; values: string[][] };

export class FileSheets implements SheetsClient {
  serviceAccountEmail = "";
  constructor(private tabs: FileTab[], private name = "Uploaded file") {}
  async spreadsheet() { return { title: this.name, tabs: this.tabs.map((t, i) => ({ title: t.title, gid: String(i), hidden: false })) }; }
  async values(_id: string, tab: string) { return (this.tabs.find((t) => t.title === tab)?.values ?? []).map((r) => [...r]); }
}

/** The file's contents wait here (private to the service user) between the upload and the person pressing Import. They are deleted once imported. */
export const pendingFile = (dir: string, linkId: string) => path.join(dir, `${linkId}.json`);
export function savePending(dir: string, linkId: string, tabs: FileTab[]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingFile(dir, linkId), JSON.stringify(tabs), { mode: 0o600 });
}
export function loadPending(dir: string, linkId: string, name?: string): FileSheets | null {
  try { return new FileSheets(JSON.parse(fs.readFileSync(pendingFile(dir, linkId), "utf8")) as FileTab[], name); } catch { return null; }
}
export const clearPending = (dir: string, linkId: string) => fs.rmSync(pendingFile(dir, linkId), { force: true });

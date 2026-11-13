// Read-only access to Google Sheets with a service account (a robot Google account that can open only the sheets shared with it).
// The key never leaves the server and is never written to the database or logs.
import crypto from "node:crypto";
import fs from "node:fs";

/** An error whose message is safe to show to the person using the tool. */
export class GoogleError extends Error { constructor(message: string, readonly status: 422 | 502 = 422) { super(message); } }

export type SheetTab = { title: string; gid: string; hidden: boolean };
/** What the sync needs from Google. Tests pass a fake. */
export interface SheetsClient {
  serviceAccountEmail: string;
  spreadsheet(id: string): Promise<{ title: string; tabs: SheetTab[] }>;
  values(id: string, tab: string): Promise<string[][]>;
}

type Creds = { client_email: string; private_key: string };
type F = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** The key comes from GOOGLE_SERVICE_ACCOUNT_JSON (the JSON itself) or GOOGLE_SERVICE_ACCOUNT_FILE (a path to it). */
export function loadGoogleCreds(env: Record<string, string | undefined>): Creds | null {
  let raw = env["GOOGLE_SERVICE_ACCOUNT_JSON"];
  const file = env["GOOGLE_SERVICE_ACCOUNT_FILE"];
  if (!raw && file) { try { raw = fs.readFileSync(file, "utf8"); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_FILE can't be read"); } }
  if (!raw) return null;
  let j: Partial<Creds>;
  try { j = JSON.parse(raw); } catch { throw new Error("The Google service account key is not valid JSON"); }
  if (!j.client_email || !j.private_key) throw new Error("The Google service account key needs client_email and private_key");
  return { client_email: j.client_email, private_key: j.private_key };
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export class GoogleSheets implements SheetsClient {
  private token: { value: string; exp: number } | null = null;
  constructor(private creds: Creds, private f: F = (url, init) => fetch(url, init as RequestInit) as any) {}
  get serviceAccountEmail() { return this.creds.client_email; }

  private async accessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > nowSec) return this.token.value;
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64(JSON.stringify({ iss: this.creds.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
    let sig: string;
    try { sig = crypto.createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.creds.private_key).toString("base64url"); }
    catch { throw new GoogleError("The Google service account key could not be used to sign in. Check GOOGLE_SERVICE_ACCOUNT_JSON.", 502); }
    let r;
    try { r = await this.f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${head}.${claims}.${sig}` }); }
    catch { throw new GoogleError("Couldn't reach Google from the server. Check its network access to oauth2.googleapis.com and sheets.googleapis.com.", 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.access_token !== "string") throw new GoogleError("Google refused the service account sign-in. The key may be disabled or expired.", 502);
    this.token = { value: j.access_token, exp: nowSec + Number(j.expires_in ?? 3600) };
    return j.access_token;
  }

  private async get(path: string): Promise<any> {
    const t = await this.accessToken();
    let r;
    try { r = await this.f(`https://sheets.googleapis.com${path}`, { headers: { Authorization: `Bearer ${t}` } }); }
    catch { throw new GoogleError("Couldn't reach Google Sheets from the server. Check its network access to sheets.googleapis.com.", 502); }
    if (r.status === 403 || r.status === 404) throw new GoogleError(`Google won't let the service account open this sheet. In Google Sheets choose Share and add ${this.creds.client_email} as a Viewer.`);
    if (r.status === 429) throw new GoogleError("Google is rate limiting requests. It will retry on the next check.", 502);
    if (!r.ok) throw new GoogleError(`Google Sheets returned an error (${r.status}).`, 502);
    return r.json();
  }

  async spreadsheet(id: string) {
    const j = await this.get(`/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.title,sheets.properties(title,sheetId,hidden)`);
    return { title: String(j?.properties?.title ?? "Sheet"), tabs: ((j?.sheets ?? []) as any[]).map((s) => ({ title: String(s.properties.title), gid: String(s.properties.sheetId), hidden: !!s.properties.hidden })) };
  }
  async values(id: string, tab: string): Promise<string[][]> {
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A:ZZ`);
    const j = await this.get(`/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    return ((j?.values ?? []) as unknown[][]).map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
  }
}

/** Accepts a docs.google.com/spreadsheets link or a bare spreadsheet id. */
export function parseSheetUrl(input: string): string | null {
  const t = input.trim();
  const m = t.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:[/?#]|$)/);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{30,60}$/.test(t) ? t : null;
}

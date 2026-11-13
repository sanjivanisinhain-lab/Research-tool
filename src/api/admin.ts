// Research-team data API (upload, sources, review queue, jobs). HTTP only: there is no mock for real data management.
const BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";

export class AdminAuthError extends Error {} // signed out
export class AdminForbiddenError extends Error {} // signed in, but not on the research team

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "x-requested-with": "research-hub", ...(init.headers ?? {}) } });
  if (res.status === 401) throw new AdminAuthError("Sign in required");
  if (res.status === 403) throw new AdminForbiddenError("Research team only");
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export type Redaction = { names: number; phones: number; emails: number; places: number };
export type UploadResult = { status: "processed" | "partial" | "failed" | "unsupported" | "queued"; message: string; format?: string; sourcesAdded: number; sourcesSkipped: number; participantsAdded: number; redaction: Redaction; jobsQueued?: number };
export type UploadMeta = { study: string; product: string; kind: "cx_call" | "interview"; date: string; names: string };
export type AdminSource = { id: string; title: string; sourceType: string; origin: string; status: string; submittedBy: "research_team" | "contributor"; date: string | null; quality: string | null; language: string; redaction: Redaction; study: string; participantId: string; createdAt: string; evidence: number; pendingEvidence: number; job: string | null };
export type TeamUser = { id: string; email: string; name: string | null; role: "admin" | "user"; disabled: number; mustChangePassword: number; createdAt: string; lastLoginAt: string | null };
export type SourceText = { title: string; quality: string | null; utterances: { seq: number; speaker: string; startSec: number | null; text: string }[] };
export type JobsInfo = { counts: { status: string; n: number }[]; transcriptions: { id: number; status: string; note: string; study: string; createdAt: string }[]; recentFailures: { id: number; kind: string; sourceId: string | null; error: string }[]; aiConfigured: boolean };
export type ReviewItem = { id: number; participantId: string; quote: string; translation: string | null; kind: "said" | "did"; provenance: string; theme: string; sentiment: string; flags: string; sourceType: string; date: string | null; originalLanguage: string; sourceTitle: string; quality: string | null };

export type StudyRequestItem = {
  id: string; answerId: string; title: string; note: string | null; teamNote: string | null; status: "new" | "accepted" | "in_progress" | "done" | "declined"; createdAt: string; updatedAt: string;
  requester: { role?: string; team?: string; area?: string; name?: string };
  plan: { question: string; audience: { name: string }[]; studyPlan: { method?: string; objective: string; audience: string; task: string; watchFor: string; questions: string[] }; known: { title: string; body: string }[]; unknowns: { title: string; body: string }[] };
};

export type SheetSync = { ok: boolean; status: "ok" | "error" | "needs_confirmation"; message: string; added: number; edited: number; removed: number; linked: number; unchanged: number };
export type SheetLinkInfo = { id: string; name: string; spreadsheetId: string; studyName: string; product: string; enabled: boolean; lastSyncedAt: string | null; lastStatus: "ok" | "error" | "needs_confirmation" | null; lastMessage: string | null; rows: number; removedRows: number; tabs: { title: string; gid: string | null }[] };
export type SheetsInfo = { configured: boolean; serviceAccountEmail: string | null; links: SheetLinkInfo[] };
export type SheetView = { id: string; name: string; spreadsheetId: string; tab: string; gid: string | null; tabs: { title: string; gid: string | null }[]; header: string[]; from: number; rows: { row: number; cells: string[]; removed: boolean; participantId: string | null }[]; hasPrev: boolean; hasNext: boolean; lastSyncedAt: string | null };
const orThrow = <T extends object>(body: T): T => { if ("error" in body && typeof (body as { error: unknown }).error === "string") throw new Error((body as { error: string }).error); return body; };

export const adminApi = {
  sheets: () => call<SheetsInfo>("/api/admin/sheets"),
  linkSheet: async (v: { url: string; name: string; study: string; product: string }) => orThrow(await call<{ id: string; sync: SheetSync }>("/api/admin/sheets", json("POST", v))),
  syncSheet: async (id: string, force = false) => orThrow(await call<SheetSync>(`/api/admin/sheets/${id}/sync`, json("POST", { force }))),
  setSheetEnabled: (id: string, enabled: boolean) => call<{ ok: boolean }>(`/api/admin/sheets/${id}`, json("PATCH", { enabled })),
  sheetView: (id: string, o: { tab?: string; from?: number; limit?: number }) => {
    const q = new URLSearchParams(); if (o.tab) q.set("tab", o.tab); if (o.from) q.set("from", String(o.from)); if (o.limit) q.set("limit", String(o.limit));
    return call<SheetView>(`/api/sheets/${id}/view?${q}`);
  },
  upload(file: File, m: UploadMeta, ackRecordings = false, analyseScreen = false): Promise<UploadResult> {
    const q = new URLSearchParams({ study: m.study, product: m.product, kind: m.kind, names: m.names, filename: file.name });
    if (ackRecordings) q.set("ack", "1");
    if (analyseScreen) { q.set("screen", "1"); q.set("ackScreen", "1"); } // ticking the screen box is the approval for sending the picture
    if (m.date) q.set("date", m.date);
    return call(`/api/admin/upload?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
  },
  sources: () => call<AdminSource[]>("/api/admin/sources"),
  sourceText: (id: string) => call<SourceText>(`/api/admin/sources/${id}/utterances`),
  jobs: () => call<JobsInfo>("/api/admin/jobs"),
  rebuildAudiences: () => call<{ jobId: number }>("/api/admin/jobs/rebuild-audiences", json("POST")),
  retryJob: (id: number) => call<{ ok: boolean }>(`/api/admin/jobs/${id}/retry`, json("POST")),
  review: (status: "pending" | "approved" | "rejected", limit = 25) => call<{ total: number; items: ReviewItem[] }>(`/api/admin/evidence?status=${status}&limit=${limit}`),
  setStatus: (id: number, action: "approve" | "reject", note?: string) => call(`/api/admin/evidence/${id}/${action}`, json("POST", { note })),
  approveSource: (id: string) => call<{ approved: number }>(`/api/admin/sources/${id}/approve-all`, json("POST")),
  studyRequests: () => call<StudyRequestItem[]>("/api/admin/study-requests"),
  updateStudyRequest: (id: string, patch: { status?: StudyRequestItem["status"]; teamNote?: string }) => call(`/api/admin/study-requests/${id}`, json("PATCH", patch)),
  users: () => call<TeamUser[]>("/api/admin/users"),
  updateUser: (id: string, patch: { role?: "admin" | "user"; disabled?: boolean }) => call(`/api/admin/users/${id}`, json("PATCH", patch)),
  resetPassword: (id: string) => call<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, json("POST", {})),
  contribute: (text: string, kind: "cx_call" | "interview") => call<{ received: boolean }>("/api/contributions", json("POST", { text, kind })),
};

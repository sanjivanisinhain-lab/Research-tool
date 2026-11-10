// Research-team data API (upload, sources, review queue, jobs). HTTP only: there is no mock for real data management.
const BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";
const KEY = "research-hub-admin-token";

export class AdminAuthError extends Error {}
export const adminToken = {
  get: () => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } },
  set: (t: string) => { try { sessionStorage.setItem(KEY, t); } catch { /* session storage unavailable */ } },
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(adminToken.get() ? { "x-admin-token": adminToken.get() } : {}) } });
  if (res.status === 401) throw new AdminAuthError("Admin passcode required");
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export type Redaction = { names: number; phones: number; emails: number; places: number };
export type UploadResult = { status: "processed" | "partial" | "failed" | "unsupported"; message: string; format?: string; sourcesAdded: number; sourcesSkipped: number; participantsAdded: number; redaction: Redaction; jobsQueued?: number };
export type UploadMeta = { study: string; product: string; kind: "cx_call" | "interview"; date: string; names: string };
export type AdminSource = { id: string; title: string; sourceType: string; origin: string; status: string; submittedBy: "research_team" | "contributor"; date: string | null; quality: string | null; language: string; redaction: Redaction; study: string; participantId: string; createdAt: string; evidence: number; pendingEvidence: number; job: string | null };
export type JobsInfo = { counts: { status: string; n: number }[]; recentFailures: { id: number; kind: string; sourceId: string | null; error: string }[]; aiConfigured: boolean };
export type ReviewItem = { id: number; participantId: string; quote: string; translation: string | null; kind: "said" | "did"; provenance: string; theme: string; sentiment: string; flags: string; sourceType: string; date: string | null; originalLanguage: string; sourceTitle: string; quality: string | null };

export const adminApi = {
  upload(file: File, m: UploadMeta): Promise<UploadResult> {
    const q = new URLSearchParams({ study: m.study, product: m.product, kind: m.kind, names: m.names, filename: file.name });
    if (m.date) q.set("date", m.date);
    return call(`/api/admin/upload?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
  },
  sources: () => call<AdminSource[]>("/api/admin/sources"),
  jobs: () => call<JobsInfo>("/api/admin/jobs"),
  rebuildAudiences: () => call<{ jobId: number }>("/api/admin/jobs/rebuild-audiences", json("POST")),
  retryJob: (id: number) => call<{ ok: boolean }>(`/api/admin/jobs/${id}/retry`, json("POST")),
  review: (status: "pending" | "approved" | "rejected", limit = 25) => call<{ total: number; items: ReviewItem[] }>(`/api/admin/evidence?status=${status}&limit=${limit}`),
  setStatus: (id: number, action: "approve" | "reject", note?: string) => call(`/api/admin/evidence/${id}/${action}`, json("POST", { note })),
  approveSource: (id: string) => call<{ approved: number }>(`/api/admin/sources/${id}/approve-all`, json("POST")),
  contribute: (text: string, kind: "cx_call" | "interview") => call<{ received: boolean }>("/api/contributions", json("POST", { text, kind })),
};

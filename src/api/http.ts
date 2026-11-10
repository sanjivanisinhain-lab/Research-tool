// HTTP stub for the future Node/Express/SQLite backend. Every endpoint except
// /api/health and /api/records is PROPOSED — see docs/API_CONTRACT.md.
import type { ResearchApi } from "./types";

const BASE = import.meta.env['VITE_API_BASE_URL'] ?? "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 404) return null as T;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}
const post = <T>(path: string, body: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body) });

export const httpApi: ResearchApi = {
  getProfile: () => req("/api/profile"),
  saveProfile: (p) => req("/api/profile", { method: "PUT", body: JSON.stringify(p) }),
  listAudiences: () => req("/api/audiences"),
  getAudience: (kind, id) => req(`/api/audiences/${kind}/${id}`),
  countParticipants: (a) => post<{ count: number }>("/api/audiences/count", { audience: a }).then((r) => r.count),
  ask: (input) => post("/api/answers", input),
  getAnswer: (id) => req(`/api/answers/${id}`),
  followUp: (id, question) => post(`/api/answers/${id}/follow-ups`, { question }),
  getStudyRequest: (answerId) => req(`/api/answers/${answerId}/study-request`),
  requestStudy: (answerId, note) => post(`/api/answers/${answerId}/study-request`, { note }),
  getEvidence: (ids) => req(`/api/evidence?ids=${encodeURIComponent(ids.join(","))}`),
  listSavedWork: () => req("/api/saved-work"),
  createAssessment: (input) => post("/api/assessments", input),
  getAssessment: (id) => req(`/api/assessments/${id}`),
  getPersonaConversation: (pid) => req(`/api/personas/${pid}/conversation`),
  sendPersonaMessage: (pid, text) => post(`/api/personas/${pid}/messages`, { text }),
};

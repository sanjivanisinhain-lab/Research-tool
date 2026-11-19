// Audiences picked by details (age, tier, state, how they pay). HTTP only: there is no demo version of this.
import type { AudienceRef } from "@/types/research";
const BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";

export type AudienceFilter = { ageMin?: number; ageMax?: number; tiers?: string[]; states?: string[]; genders?: string[]; payments?: string[]; customers?: string[] };
export type Facets = {
  total: number; known: Record<"age" | "tier" | "state" | "gender" | "payment" | "customer", number>; age: { min: number; max: number } | null;
  tiers: { value: string; n: number }[]; states: { value: string; n: number }[]; genders: { value: string; n: number }[]; payments: { value: string; n: number }[]; customers: { value: string; n: number }[];
};
export type FilterPreview = { matching: number; undetermined: number; total: number; name: string; empty: boolean };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "x-requested-with": "research-hub", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const filtersApi = {
  facets: () => call<Facets>("/api/attributes/facets"),
  preview: (filter: AudienceFilter) => call<FilterPreview>("/api/audiences/custom/preview", { method: "POST", body: JSON.stringify({ filter }) }),
  save: (filter: AudienceFilter, name?: string) => call<AudienceRef>("/api/audiences/custom", { method: "POST", body: JSON.stringify({ filter, ...(name?.trim() ? { name: name.trim() } : {}) }) }),
  remove: (id: string) => call<{ ok: boolean }>(`/api/audiences/custom/${id}`, { method: "DELETE" }),
};

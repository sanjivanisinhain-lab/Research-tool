// Account API: sign up, sign in, sign out, change password. Real backend only (the demo mock has no accounts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IS_MOCK } from "@/config/dataMode";

const BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";
export const AUTH_REQUIRED_EVENT = "rh-auth-required";

export type Me = { user: { id: string; email: string; name: string | null; role: "admin" | "user"; mustChangePassword: boolean } | null; firstRun: boolean; setupCodeRequired: boolean; allowedEmailDomains: string[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-requested-with": "research-hub", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const authApi = {
  me: () => call<Me>("/api/auth/me"),
  signup: (v: { email: string; password: string; name?: string; setupCode?: string }) => call("/api/auth/signup", v),
  login: (v: { email: string; password: string }) => call("/api/auth/login", v),
  logout: () => call("/api/auth/logout", {}),
  changePassword: (v: { currentPassword: string; newPassword: string }) => call("/api/auth/change-password", v),
};

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: authApi.me, staleTime: 60_000, retry: false, enabled: !IS_MOCK });

/** Run an account action, then drop everything cached for the previous person and reload who is signed in. */
export function useAccountAction<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: async () => { qc.clear(); await qc.invalidateQueries({ queryKey: ["me"] }); } });
}

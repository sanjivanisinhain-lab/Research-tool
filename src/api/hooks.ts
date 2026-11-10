import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./index";
import type { AudienceKind, AudienceRef, Profile } from "@/types/research";

export const useProfile = () => useQuery({ queryKey: ["profile"], queryFn: () => api.getProfile(), staleTime: Infinity });
export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (p: Profile) => api.saveProfile(p), onSuccess: (p) => qc.setQueryData(["profile"], p) });
}
export const useAudiences = () => useQuery({ queryKey: ["audiences"], queryFn: () => api.listAudiences() });
export const useAudience = (kind: AudienceKind, id: string) =>
  useQuery({ queryKey: ["audience", kind, id], queryFn: () => api.getAudience(kind, id) });
export const useParticipantCount = (a: AudienceRef[]) =>
  useQuery({ queryKey: ["count", a.map((x) => x.id).sort()], queryFn: () => api.countParticipants(a), placeholderData: (p) => p });
export const useAnswer = (id: string) => useQuery({ queryKey: ["answer", id], queryFn: () => api.getAnswer(id) });
export const useAssessment = (id: string) => useQuery({ queryKey: ["assessment", id], queryFn: () => api.getAssessment(id) });
export const useEvidence = (ids: string[]) =>
  useQuery({ queryKey: ["evidence", [...ids].sort()], queryFn: () => api.getEvidence(ids), enabled: ids.length > 0 });
export const useSavedWork = () => useQuery({ queryKey: ["saved"], queryFn: () => api.listSavedWork() });
export const usePersonaConversation = (pid: string) =>
  useQuery({ queryKey: ["persona-chat", pid], queryFn: () => api.getPersonaConversation(pid) });

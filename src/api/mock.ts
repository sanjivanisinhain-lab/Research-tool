import type { ResearchApi } from "./types";
import type { Answer, Assessment, ChatMessage, FollowUp, Profile } from "@/types/research";
import {
  ANSWERS,
  ASSESSMENTS,
  AUDIENCE_PARTICIPANTS,
  AUDIENCE_PROFILES,
  COMPARISON_COLUMNS,
  COMPARISON_TEMPLATE,
  EVIDENCE,
  PERSONA_CONVERSATIONS,
  SAVED_WORK,
} from "@/fixtures/research";
import { countUniqueParticipants } from "@/lib/participants";
import { personaReply } from "./personaReplies";

const PROFILE_KEY = "research-hub.profile"; // localStorage is used for the profile only
const delay = <T>(v: T, ms = 300) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

const answers = new Map<string, Answer>(ANSWERS.map((a) => [a.id, structuredClone(a)]));
const assessments = new Map<string, Assessment>(ASSESSMENTS.map((a) => [a.id, structuredClone(a)]));
const chats = new Map<string, ChatMessage[]>(Object.entries(structuredClone(PERSONA_CONVERSATIONS)));

function pickVariant(q: string): string {
  const s = q.toLowerCase();
  if (/dark mode|dark theme/.test(s)) return "a-dark-mode";
  if (/how should (i|we) test|what should we change|test plan|study plan/.test(s)) return "a-study-plan";
  if (/do you think|interview guide|script|easier than/.test(s)) return "a-script-review";
  return "a-tier2-cart";
}

function noEvidenceReply(topic: string): Omit<ChatMessage, "id" | "from"> {
  return {
    text: `No evidence. The research doesn't cover ${topic}. I won't guess.`,
    label: "no_evidence",
    evidenceIds: [],
    suggestedStudy: `Add a question about ${topic} to the next study and run a short preference test with 6 participants.`,
  };
}

export const mockApi: ResearchApi = {
  async getProfile() {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(PROFILE_KEY);
    return delay(raw ? (JSON.parse(raw) as Profile) : null, 50);
  },
  async saveProfile(profile) {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return delay(profile, 150);
  },
  listAudiences: () => delay(AUDIENCE_PROFILES),
  getAudience: (kind, id) => delay(AUDIENCE_PROFILES.find((a) => a.ref.kind === kind && a.ref.id === id) ?? null),
  countParticipants: (aud) => delay(countUniqueParticipants(aud.map((a) => AUDIENCE_PARTICIPANTS[a.id] ?? [])), 80),

  async ask(input) {
    const id = uid("a");
    const now = new Date().toISOString();
    let answer: Answer;
    if (input.mode === "compare" && input.audience.length >= 2) {
      answer = {
        ...structuredClone(COMPARISON_TEMPLATE),
        id,
        question: input.question,
        audience: input.audience,
        savedAt: now,
        comparison: {
          columns: input.audience.slice(0, 3).map((a) => {
            const column = COMPARISON_COLUMNS[a.id];
            if (!column) throw new Error(`Unknown audience: ${a.id}`);
            return { audience: a, ...structuredClone(column) };
          }),
          biggestDifference: "Late fees drive abandonment for price-focused audiences; delivery certainty matters more for others.",
          designImplication: "Show the full total early for everyone, then tailor delivery reassurance by audience.",
        },
      };
    } else {
      const base = answers.get(pickVariant(input.question));
      if (!base) throw new Error("Answer template not found");
      answer = { ...structuredClone(base), id, question: input.question, audience: input.audience, savedAt: now, followUps: [] };
    }
    answer.attachments = input.attachments;
    answers.set(id, answer);
    return delay({ id }, 200);
  },
  getAnswer: (id) => delay(answers.get(id) ?? null),
  // The demo has no research team to receive requests; nothing is sent anywhere.
  getStudyRequest: () => delay(null),
  requestStudy: () => Promise.reject(new Error("Requests to the research team are only available with the real backend")),
  async followUp(answerId, question) {
    const a = answers.get(answerId);
    if (!a) throw new Error("Answer not found");
    const noEv = /dark mode|colour|color|font|age|gender/i.test(question);
    const f: FollowUp = noEv
      ? { id: uid("f"), question, reply: "No evidence. The research doesn't address this. Consider adding it to the next study.", label: "no_evidence", evidenceIds: [], createdAt: new Date().toISOString() }
      : { id: uid("f"), question, reply: "Within this audience, the same evidence suggests fee visibility matters most at the cart step. This is an inference from the patterns above.", label: "inference", evidenceIds: ["e2", "e5"], createdAt: new Date().toISOString() };
    a.followUps = [...(a.followUps ?? []), f];
    return delay(f, 700);
  },
  getEvidence: (ids) => delay(EVIDENCE.filter((e) => ids.includes(e.id)).map((e) => ({ ...e, sourceContext: {
    simulated: true as const,
    reference: `${e.sourceType}-${e.participantId}-${e.id}`,
    title: e.sourceType === "cx_call" ? "Caller notes" : e.sourceType === "ab_test" ? "Historical test notes" : e.kind === "did" ? "Observation notes" : "Transcript excerpt",
    context: e.kind === "said" ? "Participant discussing purchase decisions during a simulated research session." : "Researcher observation recorded in the simulated study.",
    recording: e.audio ? "Synthetic Hindi/Hinglish voice · simulated quote reading" : "Demo only · no recording attached",
  } })), 150),
  listSavedWork: () => delay(SAVED_WORK),
  async createAssessment(input) {
    const id = uid("as");
    const base = assessments.get("as-offer-card");
    if (!base) throw new Error("Assessment template not found");
    const { goal: _goal, ...template } = structuredClone(base);
    assessments.set(id, { ...template, id, task: input.task, ...(input.goal ? { goal: input.goal } : {}), audience: input.audience, prototype: input.prototype, savedAt: new Date().toISOString() });
    return delay({ id }, 600);
  },
  getAssessment: (id) => delay(assessments.get(id) ?? null),
  getPersonaConversation: (pid) => delay(chats.get(pid) ?? []),
  async sendPersonaMessage(pid, text) {
    const reply = personaReply(pid, text);
    const user: ChatMessage = { id: uid("m"), from: "user", text };
    const msg: ChatMessage = { id: uid("m"), from: "persona", ...reply };
    chats.set(pid, [...(chats.get(pid) ?? []), user, msg]);
    return delay(msg, 800);
  },
};

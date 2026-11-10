import type {
  Answer,
  Assessment,
  Attachment,
  AudienceKind,
  AudienceProfile,
  AudienceRef,
  ChatMessage,
  EvidenceItem,
  FollowUp,
  Profile,
  SavedWorkItem,
  StudyRequest,
} from "@/types/research";

export type AskInput = {
  question: string;
  audience: AudienceRef[];
  mode: "combine" | "compare";
  attachments: Attachment[];
  autoAudience?: boolean; // let the server pick the audience from the question
  contextAnswerId?: string; // the answer this question is about (used by "How should I test this?")
};

export type AssessmentInput = {
  prototype: Assessment["prototype"] & { data?: string }; // data = base64 image, only for uploads
  task: string;
  goal?: string;
  audience: AudienceRef[];
};

export interface ResearchApi {
  // profile
  getProfile(): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<Profile>;
  // audiences
  listAudiences(): Promise<AudienceProfile[]>;
  getAudience(kind: AudienceKind, id: string): Promise<AudienceProfile | null>;
  countParticipants(audience: AudienceRef[]): Promise<number>;
  // ask
  ask(input: AskInput): Promise<{ id: string }>;
  getAnswer(id: string): Promise<Answer | null>;
  followUp(answerId: string, question: string): Promise<FollowUp>;
  // study requests: send a planned study to the research team
  getStudyRequest(answerId: string): Promise<StudyRequest | null>;
  requestStudy(answerId: string, note: string): Promise<StudyRequest>;
  // evidence
  getEvidence(ids: string[]): Promise<EvidenceItem[]>;
  // saved work
  listSavedWork(): Promise<SavedWorkItem[]>;
  // assessments
  createAssessment(input: AssessmentInput): Promise<{ id: string }>;
  getAssessment(id: string): Promise<Assessment | null>;
  // persona chat
  getPersonaConversation(personaId: string): Promise<ChatMessage[]>;
  sendPersonaMessage(personaId: string, text: string): Promise<ChatMessage>;
}

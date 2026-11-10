// Core research domain types. Data model: Participant → Segment → Persona → Evidence → Answer.

export type Signal = "strong" | "mixed" | "risk";
export type ClaimLabel = "evidence" | "inference" | "no_evidence";
export type AudienceKind = "segment" | "persona";
export type AudienceRef = { kind: AudienceKind; id: string; name: string; participants: number };
export type Role = "designer" | "researcher" | "pm" | "marketing" | "cx" | "other";

export type Participant = { id: string }; // non-identifying, e.g. "P018"

export type SourceType = "interview" | "cx_call" | "diary" | "usability" | "ab_test";

export type EvidenceItem = {
  id: string;
  participantId: string;
  sourceType: SourceType;
  date: string; // ISO
  quote: string; // verbatim, in original language
  originalLanguage: "en" | "hi" | "hinglish";
  translation?: string; // never shown as verbatim
  kind: "said" | "did";
  stance: "supports" | "contradicts";
  audio?: { simulated: true; url: string; duration: number; cues: { start: number; end: number; text: string }[] };
  sourceContext?: { simulated: boolean; reference: string; title: string; context: string; recording: string };
};

export type ConfidenceLabel = "high" | "medium" | "low" | "very_low";

export type Confidence = {
  score: number | null;
  label: ConfidenceLabel;
  participants: number;
  factors: { sample: number; agreement: number; recency: number; contradictions: number };
  methodStatus: "illustrative" | "computed_v1"; // computed_v1 = deterministic formula in server/confidence.ts
};

export type Pattern = {
  id: string;
  title: string;
  summary: string;
  signal: Signal;
  label: ClaimLabel;
  evidenceIds: string[];
};

export type Implication = { keep: string; change: string; watch: string };
export type Implications = Record<Role, Implication>;

export type KnownItem = { title: string; body: string; label: ClaimLabel; evidenceIds?: string[] };

export type StudyPlan = {
  method?: string; // e.g. "Moderated usability test"
  rationale?: string; // why this method suits the objective and the existing evidence
  objective: string;
  audience: string;
  task: string;
  watchFor: string;
  questions: string[];
};

export type ScriptQuestion = {
  id: string;
  original: string;
  status: "good" | "improve" | "leading";
  issue?: "Leading" | "Double-barrelled" | "Hypothetical" | "Vague";
  note?: string;
  rewrite?: string;
};

export type ScriptReview = {
  readiness: string;
  counts: { good: number; improve: number; leading: number };
  questions: ScriptQuestion[];
  overlap: { title: string; body: string; evidenceIds: string[] };
};

export type ComparisonColumn = {
  audience: AudienceRef;
  direction?: { label: string; pct: number };
  confidence: Confidence;
  dimensions: { name: string; signal: Signal; summary: string }[];
};

export type Comparison = {
  columns: ComparisonColumn[];
  biggestDifference: string;
  designImplication: string;
};

export type Attachment = { name: string; kind: "local" | "link" | "transcript"; text?: string; mimeType?: string; data?: string /* base64 of the file, sent only when the server needs to read it */ };

export type FollowUp = {
  id: string;
  question: string;
  reply: string;
  label: ClaimLabel;
  evidenceIds: string[];
  createdAt: string;
};

export type AnswerVariant = "standard" | "study_plan" | "insufficient" | "script_review" | "comparison";

export type Answer = {
  id: string;
  question: string;
  audience: AudienceRef[];
  autoAudience?: boolean; // the audience was chosen from the question, not by the user
  variant: AnswerVariant;
  headline: string;
  summary: string;
  direction?: { label: string; pct: number }; // omitted when confidence is below threshold
  confidence: Confidence;
  sources: number;
  patterns: Pattern[];
  conflict?: { title: string; body: string; evidenceIds: string[] };
  unknowns: { title: string; body: string }[];
  known?: KnownItem[];
  studyPlan?: StudyPlan;
  scriptReview?: ScriptReview;
  comparison?: Comparison;
  implications: Implications;
  attachments?: Attachment[];
  followUps?: FollowUp[];
  evidenceStances?: Record<string, "supports" | "contradicts">; // per cited evidence id, relative to this answer
  evidenceStatus?: "approved_only" | "includes_unreviewed"; // unreviewed = research team has not approved all cited evidence
  savedAt: string;
};

export type AudienceProfile = {
  ref: AudienceRef;
  initials: string;
  description: string;
  evidenceStrength: number;
  corePatterns: number;
  sources: number;
  updatedAt: string;
  definingBehaviours: string[];
  needs: string[];
  painPoints: string[];
  language: { quote: string; lang: "en" | "hi" | "hinglish"; translation?: string; participantId: string }[];
  gaps: string[];
  jobs?: string[];
  triggers?: string[];
  trustBarriers?: string[];
  saidVsDid?: { said: string; did: string }[];
};

export type Annotation = {
  id: string;
  element: string; // "price" | "countdown" | "original_price" for the sample card; any label for uploaded designs
  box?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] on a 0-1000 scale, for uploaded designs
  title: string;
  signal: Signal;
  summary: string;
  participants: number;
  evidenceIds: string[];
};

export type Assessment = {
  id: string;
  title: string;
  prototype: { kind: "local_sample" } | { kind: "figma_link"; url: string } | { kind: "upload"; name: string; mimeType: string };
  task: string;
  goal?: string;
  audience: AudienceRef[];
  headline: string;
  summary: string;
  direction?: { label: string; pct: number };
  confidence: Confidence;
  annotations: Annotation[];
  conflict?: { title: string; body: string; evidenceIds: string[] };
  unknowns: { title: string; body: string }[];
  implications: Implications;
  evidenceStances?: Record<string, "supports" | "contradicts">;
  evidenceStatus?: "approved_only" | "includes_unreviewed";
  savedAt: string;
};

export type ChatMessage = {
  id: string;
  from: "user" | "persona";
  text: string;
  label?: ClaimLabel;
  evidenceIds?: string[];
  suggestedStudy?: string;
};

export type SavedWorkType = "answer" | "assessment" | "persona_chat" | "script_review";

export type SavedWorkItem = {
  id: string;
  title: string;
  type: SavedWorkType;
  audience: string;
  status: string;
  updatedAt: string; // ISO
  target: { to: "/ask/$id"; id: string } | { to: "/assess/$id"; id: string } | { to: "/persona-chat"; persona: string };
};

export type Profile = { role: Role; team: string; area: string; note?: string; name?: string };

export type StudyRequestStatus = "new" | "accepted" | "in_progress" | "done" | "declined";
export type StudyRequest = { id: string; status: StudyRequestStatus; note?: string | null; teamNote?: string | null; createdAt: string; updatedAt: string };

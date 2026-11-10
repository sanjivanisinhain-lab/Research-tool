# API contract
Existing: GET /api/health, GET /api/records, POST /api/records, DELETE /api/records.

All endpoints below are **PROPOSED**. Types live in src/types/research.ts and src/api/types.ts.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /api/profile | – | Profile \| 404 |
| PUT | /api/profile | Profile | Profile |
| GET | /api/audiences | – | AudienceProfile[] |
| GET | /api/audiences/:kind/:id | – | AudienceProfile |
| POST | /api/audiences/count | { audience: AudienceRef[] } | { count } (unique participants) |
| POST | /api/answers | AskInput | { id } |
| GET | /api/answers/:id | – | Answer |
| POST | /api/answers/:id/follow-ups | { question } | FollowUp |
| GET | /api/evidence?ids= | – | EvidenceItem[] |
| GET | /api/saved-work | – | SavedWorkItem[] |
| POST | /api/assessments | AssessmentInput | { id } |
| GET | /api/assessments/:id | – | Assessment |
| GET | /api/personas/:id/conversation | – | ChatMessage[] |
| POST | /api/personas/:id/messages | { text } | ChatMessage |

## Runtime and boundaries

The frontend is a local, fixture-backed prototype, not a reasoning backend. `src/api/index.ts` selects the real HTTP client by default; `VITE_USE_MOCK=true` selects the typed demo client (fixtures), with optional `VITE_API_BASE_URL`. All research reads and mutations go through this client. No AI model, web search, database, hosted authentication or external integration is connected. The existing health/records endpoints above were supplied in the brief, not verified against a running backend. Every research endpoint in the table is **PROPOSED**, not implemented here.

Requests use JSON. `AskInput` contains `{ question: string, audience: AudienceRef[], mode: "combine" | "compare", attachments: Attachment[] }`. `AssessmentInput` contains `{ prototype: { kind: "local_sample" } | { kind: "figma_link", url: string }, task: string, goal?: string, audience: AudienceRef[] }`. Evidence IDs are comma-separated in the `ids` query parameter. Nullable client reads use HTTP 404 as not-found; other errors reject. Figma links are supplied material only, not a working Figma integration.

## PROPOSED Node.js / Express / SQLite schema

No schema below is installed. Research-team ingestion is separate from normal-user flows.

| Table | Proposed columns and relationships |
|---|---|
| participants | id TEXT PRIMARY KEY (non-identifying, e.g. P018) |
| segments | id TEXT PRIMARY KEY, name TEXT, characteristic TEXT |
| segment_participants | segment_id REFERENCES segments, participant_id REFERENCES participants; composite PRIMARY KEY |
| personas | id TEXT PRIMARY KEY, name TEXT, behavioural_profile_json TEXT; composite profiles, never people |
| persona_segments | persona_id REFERENCES personas, segment_id REFERENCES segments; composite PRIMARY KEY |
| persona_participants | persona_id REFERENCES personas, participant_id REFERENCES participants; composite PRIMARY KEY |
| sources | id TEXT PRIMARY KEY, source_type TEXT CHECK interview/cx_call/diary/usability/ab_test, date TEXT ISO, original_language TEXT, context_json TEXT, simulated INTEGER |
| evidence | id TEXT PRIMARY KEY, participant_id REFERENCES participants, source_id REFERENCES sources, original_text TEXT, translation TEXT NULL, kind TEXT CHECK said/did, stance TEXT CHECK supports/contradicts |
| persona_evidence | persona_id REFERENCES personas, evidence_id REFERENCES evidence; composite PRIMARY KEY |
| profiles | id TEXT PRIMARY KEY, role TEXT, team TEXT, area TEXT, note TEXT NULL |
| answers | id TEXT PRIMARY KEY, question TEXT, variant TEXT, audience_json TEXT, confidence_json TEXT, direction_json TEXT NULL, content_json TEXT, saved_at TEXT |
| answer_claims | id TEXT PRIMARY KEY, answer_id REFERENCES answers, claim_text TEXT, label TEXT CHECK evidence/inference/no_evidence |
| claim_evidence | claim_id REFERENCES answer_claims, evidence_id REFERENCES evidence; composite PRIMARY KEY |
| assessments | id TEXT PRIMARY KEY, task TEXT, goal TEXT NULL, prototype_json TEXT, audience_json TEXT, content_json TEXT, saved_at TEXT |
| conversations | id TEXT PRIMARY KEY, persona_id REFERENCES personas, created_at TEXT |
| messages | id TEXT PRIMARY KEY, conversation_id REFERENCES conversations, sender TEXT CHECK user/persona, text TEXT, label TEXT NULL, evidence_ids_json TEXT, created_at TEXT |
| saved_work | id TEXT PRIMARY KEY, type TEXT, target_id TEXT, title TEXT, status TEXT, updated_at TEXT |

Enable foreign keys. Participant → Segment → Persona → Evidence → Answer describes the domain, not a single exclusive hierarchy: memberships overlap and personas cite multiple evidence records. The proposed backend must validate audience membership and resolve citations from stored evidence.

## Trust and confidence rules

- Count distinct participant IDs in the union of selected memberships; never add audience totals or count mentions. The mock uses `countUniqueParticipants` over fixture memberships.
- `EvidenceItem.kind` distinguishes said from did. The answer displays separate distinct-participant counts within cited evidence; the same participant can occur in both groups. These displayed counts are not the full underlying study sample.
- Quotes retain participant ID, source type, date and original language; optional translations are separate, never verbatim. `sourceContext` is supplied by the typed client as `{ simulated: true, reference, title, context, recording }` in the mock; no real recording is available.
- Every supported claim must cite evidence; inference remains labelled, and gaps remain No evidence. Persona replies are deterministic conversational simulations, not actual participants or AI predictions.
- Confidence `score` and `factors: { sample, agreement, recency, contradictions }` are independent supplied fixture values, **not a computed weighted score**. Factor weighting and backend calibration remain unresolved. Higher contradictions-factor values mean fewer contradictions.
- Placeholder confidence bands: below 25 very low, below 50 low, below 75 medium, otherwise high. Below 40 or null, withhold evidence direction entirely. Proposed backend responses must also remove predictions and return the insufficient state below that threshold.
- Evidence direction indicates a share of relevant evidence, never a percentage of all users. Response confidence measures trust in that conclusion, never likely reaction.
- Profile role changes recommendation framing only, not the evidence or conclusion.

Mock answers and assessments reuse predetermined demonstration templates; their scores, sample sizes and conclusions are not recalculated for arbitrary questions or changed audiences. A genuine audience-aware retrieval and confidence engine must be implemented in the future backend. Created work lives in memory for the current session; profile alone persists locally.

## CX voice and supplied transcripts

`EvidenceItem.audio?` contains `{ simulated: true, url: string, duration: number, cues: { start: number, end: number, text: string }[] }`. The mock provides synthetic Hindi readings of its existing Hinglish CX quotes, not real caller recordings. Timing is illustrative phrase alignment; original wording and separately labelled English translation remain inspectable. Playback requires no AI or transcription API. A future backend can store recording references and cue JSON in the proposed sources table, with appropriate consent and access controls; no recording upload endpoint exists here.

`Attachment.kind` additionally accepts `transcript` with optional `text`. Pasted CX text is user material passed through `AskInput`; it never becomes repository evidence. The mock only preserves it on the answer and does not analyse it. Microphone question dictation uses the browser SpeechRecognition API, when supported, and requests user permission; the browser may use a vendor speech service. It is not a connected CX platform, app-hosted transcription service, or stored audio recorder.

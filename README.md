> **Running and deploying this app:** see [docs/DEPLOY.md](docs/DEPLOY.md) (setup, backups, operations), [docs/SECURITY.md](docs/SECURITY.md) (what is protected and what is still your decision) and [docs/AUTH.md](docs/AUTH.md) (accounts). `.env.example` lists every setting. Run `npm run typecheck` and `npm test` before changing code.

# Research Hub

i am giving Product context, don't generate anything right now: 

Research Hub is an evidence-backed research decision assistant for any team that makes decisions about users (product designers, UX researchers, product managers, CX, marketing).

Answers come only from the team's own research: interview and call transcripts, CX feedback and historical A/B results. They never come from general AI knowledge about users. Every answer shows its evidence and how far it can be trusted. When the research is silent, it says "No evidence".

Positioning: other tools answer "what do our customers say?". Research Hub answers "how sure can I be, and what should I test next?"

Who does what

The research team maintains the data in the backend.

Normal users never upload transcripts, build personas or manage evidence.

Normal users do five things: set up a profile, choose an audience, ask a question or show an idea, read an evidence-backed answer, and decide what to do next.

Data model (use these names in code)

Participant → Segment → Persona → Evidence → Answer

Participant: one interviewee or caller. Non-identifying ID such as P018.

Segment: a cohort of participants grouped by a characteristic (Tier 2 users, New users, Repeat buyers).

Persona: a behavioural profile derived from evidence (Deal-Driven Explorer, Trust-Conscious Shopper, Convenience Seeker). It is a composite, never a real person.

Evidence: a quote or observed behaviour with participant ID, source type, date, original language, English translation, and a said/did flag. Trust rules (non-negotiable, visible in the UI and encoded in the types)

Only supplied research counts as evidence. The frontend never calls an AI model or the web.

Every claim is labelled Evidence, Inference or No evidence.

Every claim traces to a quote, participant ID, source type and date. Original-language text sits beside its translation, and a translation is never presented as verbatim.

Never invent quotes, IDs, dates or participant counts in UI copy. All fixture data is clearly marked "Simulated research data".

Count participants, not mentions.

What people said and what they did are shown separately.

"Conflicting evidence" and "What we don't know" are first-class sections, not footnotes.

Personas are labelled as research-derived composites.

Two metrics are never blurred:

Evidence direction / likely reaction means what the evidence points toward. It is not "74% of users will like this".

Response confidence means how far to trust that conclusion.

Always label both. Below a confidence threshold, withhold the prediction entirely and show the Insufficient Evidence state.

The user's role changes how recommendations are framed, never what the evidence says.Technical constraints

Frontend only: React 18, Vite, TypeScript, Tailwind, shadcn/ui, React Router, TanStack Query.

Do NOT add Supabase, Lovable Cloud, any hosted database, auth provider or new backend.

The real backend will be added later in Kiro: Node.js, Express and SQLite. Existing endpoints are GET /api/health, GET /api/records, POST /api/records and DELETE /api/records.

All data access goes through a typed client in src/api/. Ship a mock implementation backed by fixtures, plus an HTTP implementation stub selected by VITE_USE_MOCK.

Any endpoint the UI needs that is not in the list above goes into docs/API_CONTRACT.md marked PROPOSED. Do not pretend it exists.

Do not claim any integration (CX calling platform, Mixpanel, Figma API) works.

Local-first. AI features are off by default.

Visual language

Calm, editorial and evidence-first. This is approximate, taken from the reference screenshots:

Warm cream page background, near-black buttons and text, deep forest-green brand colour used for the onboarding panel and positive accents.

Signal colours: green = strong signal, amber = mixed signal, muted red = potential risk. Muted purple tint for personas and study-plan badges. Soft grey for "What we don't know".

Large, tightly tracked grotesk display headings; DM Sans (or similar) for UI text. Small uppercase tracked eyebrow labels above headings.

Rounded cards with hairline borders, generous whitespace, and pill chips.

Currency is ₹. Language mix is English, Hindi and Hinglish.

Reusable components (build once, use everywhere)

AudienceChips, AudiencePickerDialog, AnswerHero, EvidenceDirectionBar, ConfidenceRing (with an expandable breakdown), SignalPattern (title, signal pill, summary, citation chips), CitationChip, EvidenceDrawer, ConflictCard, UnknownCard, DesignImplications (Keep / Change / Watch), NextActions, FollowUpComposer, StatusBadge, SimulatedDataBadge.

we will build now-- Build the Research Hub frontend as a clickable, mock-data-driven app, matching the attached screenshots closely. The screenshots are the source of truth for layout, copy and visual style. Where a screen is described below but not shown in the screenshots, design it consistently with the ones that are. Follow the Project Knowledge strictly.
App shell
Left sidebar, light beige:
Logo mark, "Research Hub" and a "Demo" badge.
Dark "+ New question" button.
Nav: Ask, Assess prototype, Persona chat, Audiences, Saved work.
A divider, then "RECENT WORK" with a "View all" link and three items (icon, truncated title, relative time). Recent items open their answer, prototype assessment or persona conversation.
Footer: amber dot with "Simulated research data", then a user chip (initials, role, team).
Main content area on the right, max-width around 1100px, scrolls independently.
Routes: /welcome, /onboarding/role, /onboarding/context, / (Ask), /ask/:id, /assess, /assess/:id, /persona-chat, /audiences, /audiences/:kind/:id, /saved.
1. Onboarding (3 steps, shown on first visit only)
Split layout. Left panel is dark forest green with the Research Hub logo and "Demo" badge. The eyebrow reads "EVIDENCE, NOT GUESSWORK", the large headline "Make decisions with your actual users in mind.", and the subtext "Ask questions, assess ideas, and explore audience perspectives, all grounded in your team's research." At the bottom is a shield icon with "Answers show sources, uncertainty, and gaps. Your role only changes how recommendations are framed."
The right panel is cream with a 3-segment progress bar at the top.
Welcome: eyebrow "WELCOME", heading "Research that can show its work.", short paragraph, then three check cards: Direct answers / Visible uncertainty / Traceable evidence (each with a one-line description). "Continue →".
Your lens: "What best describes your role?" with subtext "This tailors recommendations, not the underlying evidence." Single-select card grid: Product Designer, UX Researcher, Product Manager, Marketing, Customer Experience, Other. The selected card shows a check and a green border. "Continue" is disabled until one is selected. "Back" link.
Work context: "What are you working on?" with subtext "Save this once. You can change it from your profile later." Fields: Team or product (placeholder "e.g. Shopping experience"), Area of work (placeholder "e.g. Discovery and PDP"), Anything else? (optional textarea). Button "Enter Research Hub →", disabled until the two required fields are filled.
Persist the profile (role, team, area, note) in a profile service behind the API client. The mock implementation may use localStorage for the profile only. The sidebar user chip reads from it. Provide a profile editor reachable from the user chip menu.
2. Ask (home)
Eyebrow "EVIDENCE-ONLY ASSISTANT", heading "What do you want to understand?", subtext "Ask about behaviour, assess an idea, or improve your research. Answers stay inside the evidence your team already has."
Audience row: label AUDIENCE, with a right-aligned "36 represented participants" counter. Selected audiences show as removable chips. Segments and personas have distinct chip styling: segments in a neutral green tint, personas in a purple tint. A dashed "+ Add or compare" chip opens the Audience Picker.
Composer: large textarea ("Ask what the research suggests, review a script, or share an idea…"), an "Add material" attach button, and a primary "Ask research" button, disabled when empty.
Helper line under the composer: "Attachments are your material, not repository evidence. Local files must be reattached after a reload."
Four starter cards that prefill the composer only (they are not modes): BEHAVIOUR "Why do Tier 2 users abandon their cart?", DESIGN FEEDBACK "Would this offer card work for Deal-Driven Explorers?", SCRIPT REVIEW "Do you think this new checkout is easier than the old one?", EVIDENCE GAP "Do new users prefer dark mode?".
Submitting shows a short processing state with real-sounding steps ("Finding relevant evidence", "Checking agreement", "Checking contradictions", "Assessing evidence strength"). Then navigate to /ask/:id.
3. Audience Picker (dialog, reused by Ask, Assess and the answer page)
Eyebrow AUDIENCE, title "Who do you want to understand?", close button.
Segmented toggle: Combine ("One shared audience") and Compare ("Separate results").
Search field "Search segments and personas".
Section "PARTICIPANT SEGMENTS" (right label "Cohorts"), with checkbox rows:
Tier 2 users (36): Participants living in emerging urban markets across India.
New users (24): Participants within their first 30 days of using the product.
Repeat buyers (42): Participants with three or more completed purchases.
Section "RESEARCH-BACKED PERSONAS" (right label "Behavioural profiles"):
Deal-Driven Explorer (31): Price-conscious explorers who browse broadly and verify savings before committing.
Trust-Conscious Shopper (27): Careful shoppers who look for credibility and control before purchase.
Convenience Seeker (19): Time-sensitive shoppers who value a short, predictable path to completion.
Sticky footer: selection name or summary, then "36 matching participants, counted once" (combined selections de-duplicate participants, not a naive sum), and a dark "Use this audience" button.
The AI never selects an audience silently. It may suggest one with a visible "Suggested" tag that the user must accept.
4. Answer page (/ask/:id), the standard response component
This is the master component. Every substantial answer uses it. Top to bottom:
Back link "← New question", the question as H1, a meta line "Tier 2 users · saved just now", and a "Change audience" button at the top right.
"YOU ASKED" card.
Badge "Evidence-backed answer" plus "For Tier 2 users". Then the conclusion headline first ("Unexpected total cost is the clearest reason people abandon."), followed by a 2-line summary.
Two-part metrics card:
EVIDENCE DIRECTION: "76% price-related" with a horizontal bar. Tooltip: "Share of relevant evidence pointing this way. Not a share of all users."
Response confidence: ring "83%" with "High confidence" and "18 relevant participants", expandable. The expanded breakdown has four bars: Sample strength, Evidence agreement, Recency, Contradictions. Add a "How confidence is calculated" info link. Mark it "Illustrative until the method is defined".
WHAT THE EVIDENCE SAYS: "Three patterns explain the finding" (right label "4 sources · 18 participants"). Each pattern is a row with a dot, title, signal pill (Strong signal / Mixed signal / Potential risk), a one-line summary and citation chips like P018 · Research interview ›. Clicking a chip opens the Evidence Drawer.
Amber Conflicting evidence card ("Price does not explain every abandonment.") with an "Inspect source →" link.
Grey What we don't know card with a ? icon.
FOR YOUR DESIGN: "Turn the finding into a safer decision". Three cards: KEEP / CHANGE / WATCH. The wording of this section comes from the user's role (see the role lens below).
Next actions: dark "Ask follow-up", outline "Compare audience", outline "Plan usability test". Actions depend on the answer state.
Sticky bottom composer "Ask a follow-up…" with an attach icon and send button, and the caption "Follow-ups keep this question, audience, and evidence in context." Make sure the sticky composer never overlaps the content: add enough bottom padding.
Study-plan variant (for "How should I test this?" or "What should we change in cart?"): badge "Study plan · Based on current evidence gaps", headline "Test the trust boundary, not whether price matters.", a "Suggested next step" card with a "Copy plan" button and a 2×2 grid (OBJECTIVE, AUDIENCE, TASK, WATCH FOR), then a "Questions to ask" list.
Insufficient-evidence variant: no reaction percentage at all. Show an "Insufficient evidence" headline, a very-low confidence ring (for example 21%), "What we do know" (with a "Some evidence" pill), "What we don't know" (with "No evidence" pills), the recommendation "Don't make a decision from this prediction", and a "Build test plan" button.
Script-review variant: no reaction percentage. Show a readiness headline, a summary (7 good / 3 could improve / 2 potentially leading), question cards (original, issue tag such as Leading or Double-barrelled, suggested rewrite), and an "Existing evidence overlap" card.
Compare mode: when the audience dialog is in Compare mode, render side-by-side columns: reaction, confidence, then per-dimension signals, then "Biggest difference" and "Design implication". If either column's confidence is below threshold, show "Comparison inconclusive" instead of ranking the audiences.
5. Evidence Drawer (right-side sheet)
Title "Supporting evidence" with a participant count. Filter tabs: Supporting / Contradicting. Each item shows participant ID, a quote in the original language (for example "Pehle discount dekhta hoon, fir product."), the language tag, the English translation labelled "Translation", source type, date, a said/did tag, and an "Open source" button. Original and translation are always side by side.
6. Assess prototype (/assess)
Eyebrow PROTOTYPE ASSESSMENT, heading "Spot likely friction before a usability test.", subtext "Use existing research to predict risks. This does not claim that participants tested your prototype."
Step 1 Choose a prototype: toggle Local sample / Figma link (the Figma link is a text input only; do not claim it is fetched). The local sample is a ShopEasy product card: "URBAN STEP / Cloudwalk Everyday", price ₹899 with ₹1,499 struck through and a "Save ₹600" tag, a red "Offer ends in 08:42" strip, and an "Add to cart" button. Build it as a real component so the countdown can be annotated.
Step 2 Define the assessment: Task or flow (prefilled "Find a product under ₹1,000 and continue to checkout"), Learning goal (optional, prefilled "Understand whether the offer feels credible before checkout").
Step 3 Choose the audience: chips plus "+ Add or compare", prefilled "Deal-Driven Explorer".
Footer: "Predictions are labelled and linked to evidence." and a dark "Begin assessment" button.
Result (/assess/:id) reuses the standard response anatomy. Every prediction carries a visible "Prediction" label. Show element-level annotations tied to the prototype (price prominence = strong, countdown timer = mixed, original price = potential trust risk), each with participant counts and citation chips. Then conflicting evidence, what we don't know (for example "Product image hierarchy"), Keep / Change / Watch, and next actions.
7. Persona chat (/persona-chat)
Eyebrow PERSONA CONVERSATION, heading "Explore a perspective, without pretending it's a person.", subtext "Responses simulate a behavioural profile grounded in research. Inspect evidence when available."
Left list "CHOOSE ONE PERSONA": Deal-Driven Explorer (31 participants · 87% strength), Trust-Conscious Shopper (27 · 81%), Convenience Seeker (19 · 63%). Below it, a "Simulation boundary" note: "No invented memories or preferences beyond research."
Right chat panel with the persona header and a "Research simulation" badge. The first message is "I can help you explore this persona using patterns in the research. I'm a simulation, not a real participant, and I won't invent personal experiences." Every response has an "Evidence behind this response" link that opens the Evidence Drawer.
Suggested chips: "What makes an offer feel genuine?", "How do you react to countdown timers?", "Would you prefer dark mode?". The dark mode question must return a "No evidence" reply with a suggested study. This is the demo of the "no evidence" behaviour.
Evidence mode is the default.
8. Audiences (/audiences, /audiences/:kind/:id)
Eyebrow "AUDIENCE LIBRARY", heading "Understand who your research represents.", subtext "Segments are participant cohorts. Personas are behavioural profiles derived from evidence."
Tabs Segments | Personas, plus search. Cards show an initials tile, an "82% evidence" badge (green for high, amber for medium), name, description, participants and core-pattern counts, and an "Explore profile →" link. Fixtures: Tier 2 users (82%), New users (68%, amber), Repeat buyers (88%).
Detail page: a "← All audiences" link, an eyebrow SEGMENT or PERSONA, a large title, a description, and a dark "Ask about this audience" button that opens Ask with that audience preselected. A dark stat card shows represented participants, evidence strength, research sources and "Updated 5 Oct 2026". Beside it sit cards for Defining behaviours, Needs and motivations, Pain points, Language in context (Hinglish quotes such as "Final kitna padega?" and "Delivery pakki hai?") and Contradictions and gaps ("Keep this profile provisional"). Personas add Jobs to be done, Purchase triggers, Trust barriers and Said vs Did.
9. Saved work (/saved)
Eyebrow SAVED WORK, heading "Return to a decision with its context intact.", subtext "Questions, materials, audiences, and answers are preserved together." Search plus an "All work" filter. A table with columns TITLE (icon, title, type), AUDIENCE, STATUS pill, UPDATED, and a chevron. Rows:
"Why do Tier 2 users abandon cart?", Research answer, Tier 2 users, Answered, 12 minutes ago
"Offer card checkout flow", Prototype assessment, Deal-Driven Explorer, Assessment ready, Yesterday
"Trust language for promotions", Persona conversation, Trust-Conscious Shopper, 6 messages, 2 days ago
"Checkout interview guide review", Script review, New users, Answered, 5 days ago
Opening an item restores its question, attachment, audience, full response and follow-ups.
Role lens
Implement the same evidence rendered with role-specific framing in the "For your design" section only. The section title and the wording of Keep / Change / Watch change by role:
Designer: "Reduce the visual prominence of urgency messaging."
UX Researcher: "Existing evidence on urgency is contradictory. Test it specifically."
PM: "Urgency presents a potential trust risk before rollout."
Provide a roleLens.ts map so the evidence objects stay identical across roles.
Data and types
Create src/types/research.ts with at least:
ts
type Signal = 'strong' | 'mixed' | 'risk';
type ClaimLabel = 'evidence' | 'inference' | 'no_evidence';
type AudienceRef = { kind: 'segment' | 'persona'; id: string; name: string; participants: number };

type EvidenceItem = {
  id: string; participantId: string;           // e.g. "P018"
  sourceType: 'interview' | 'cx_call' | 'diary' | 'usability' | 'ab_test';
  date: string;                                // ISO
  quote: string; originalLanguage: 'en' | 'hi' | 'hinglish';
  translation?: string;                        // never shown as verbatim
  kind: 'said' | 'did'; stance: 'supports' | 'contradicts';
};

type Confidence = {
  score: number | null; label: 'high' | 'medium' | 'low' | 'very_low';
  participants: number;
  factors: { sample: number; agreement: number; recency: number; contradictions: number };
  methodStatus: 'illustrative';                // flip when a real method exists
};

type Pattern = { id: string; title: string; summary: string; signal: Signal; label: ClaimLabel; evidenceIds: string[] };

type Answer = {
  id: string; question: string; audience: AudienceRef[]; variant: 'standard'|'study_plan'|'insufficient'|'script_review'|'comparison';
  headline: string; summary: string;
  direction?: { label: string; pct: number };  // omitted when confidence is below threshold
  confidence: Confidence; patterns: Pattern[];
  conflict?: { title: string; body: string; evidenceIds: string[] };
  unknowns: { title: string; body: string }[];
  implications: Record<'designer'|'researcher'|'pm'|'marketing'|'cx'|'other', { keep: string; change: string; watch: string }>;
  savedAt: string;
};
Put the confidence thresholds (very low < 25, low < 50, medium < 75, high ≥ 75, and "withhold prediction below 40") in a single src/config/confidence.ts marked as placeholders.
Use the numbers from the screenshots for the main fixtures: Tier 2 cart-abandonment answer = 76% price-related, 83% confidence, 18 participants, 4 sources. Pattern citations: P018 and P024 (research interviews), P033 (CX call), P052 (diary study), P061 (usability session). Write the other fixtures (comparison, insufficient-evidence, script review, study plan, persona chat) so they cover every variant above.
API layer
src/api/types.ts defines a ResearchApi interface (profile, audiences, ask, followUp, evidence, savedWork, assessments, personaChat).
src/api/mock.ts implements it from fixtures with a small artificial delay.
src/api/http.ts calls the real backend at /api/... and is the default. The fixture-backed demo client is used only when VITE_USE_MOCK=true.
docs/API_CONTRACT.md lists every endpoint the UI calls, with request and response types, each marked PROPOSED except the four existing /api/* ones.
States and quality bar
Every list and page has loading skeleton, empty and error-with-retry states.
The Insufficient Evidence state is treated as a feature, not an error.
Desktop first, but usable at tablet width. The sidebar collapses to an icon rail below 1024px.
Keyboard accessible (dialog focus trap, visible focus rings), and meaning is never carried by colour alone (signal pills always have text).
Do not add features that are not described here. If something is ambiguous, pick the simplest option, note it in docs/OPEN_QUESTIONS.md, and move on.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8a43696b-cd3c-439a-9aa6-cd9456494470).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

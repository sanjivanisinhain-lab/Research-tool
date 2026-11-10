// SIMULATED RESEARCH DATA — every quote, participant ID, date and count below is
// fixture data for the demo. It is not real research.
import type {
  Answer,
  Assessment,
  AudienceProfile,
  AudienceRef,
  ChatMessage,
  ComparisonColumn,
  Confidence,
  EvidenceItem,
  Implications,
  SavedWorkItem,
} from "@/types/research";
import { confidenceLabel } from "@/config/confidence";
import totalAudio from "@/assets/cx-final-total.mp3.asset.json";
import paymentAudio from "@/assets/cx-payment.mp3.asset.json";

export const SIMULATED = true;

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `P${String(from + i).padStart(3, "0")}`);

// Participant membership per audience (used to count participants once, never mentions).
export const AUDIENCE_PARTICIPANTS: Record<string, string[]> = {
  "tier-2": range(1, 36),
  "new-users": range(25, 48),
  "repeat-buyers": range(30, 71),
  "deal-driven": range(5, 35),
  "trust-conscious": range(20, 46),
  "convenience-seeker": range(40, 58),
};

export const AUDIENCE_REFS: AudienceRef[] = [
  { kind: "segment", id: "tier-2", name: "Tier 2 users", participants: 36 },
  { kind: "segment", id: "new-users", name: "New users", participants: 24 },
  { kind: "segment", id: "repeat-buyers", name: "Repeat buyers", participants: 42 },
  { kind: "persona", id: "deal-driven", name: "Deal-Driven Explorer", participants: 31 },
  { kind: "persona", id: "trust-conscious", name: "Trust-Conscious Shopper", participants: 27 },
  { kind: "persona", id: "convenience-seeker", name: "Convenience Seeker", participants: 19 },
];
export const ref = (id: string): AudienceRef => {
  const audience = AUDIENCE_REFS.find((a) => a.id === id);
  if (!audience) throw new Error(`Unknown audience: ${id}`);
  return audience;
};

export const EVIDENCE: EvidenceItem[] = [
  { id: "e1", participantId: "P018", sourceType: "interview", date: "2026-09-14", quote: "Pehle discount dekhta hoon, fir product.", originalLanguage: "hinglish", translation: "First I look at the discount, then the product.", kind: "said", stance: "supports" },
  { id: "e2", participantId: "P024", sourceType: "interview", date: "2026-09-16", quote: "Cart mein jaake pata chala delivery charge alag hai. Wahi chhod diya.", originalLanguage: "hinglish", translation: "Only in the cart did I find the delivery charge was extra. I left it there.", kind: "said", stance: "supports" },
  { id: "e3", participantId: "P033", sourceType: "cx_call", date: "2026-09-22", quote: "Final kitna padega? Pehle bata do.", originalLanguage: "hinglish", translation: "How much will it come to in the end? Tell me first.", kind: "said", stance: "supports", audio: { simulated: true, url: totalAudio.url, duration: 3.54, cues: [{ start: 0, end: 1.75, text: "Final kitna padega?" }, { start: 1.75, end: 3.54, text: "Pehle bata do." }] } },
  { id: "e4", participantId: "P052", sourceType: "diary", date: "2026-09-28", quote: "Added three items, saw the total with fees, removed two and closed the app.", originalLanguage: "en", kind: "did", stance: "supports" },
  { id: "e5", participantId: "P061", sourceType: "usability", date: "2026-10-02", quote: "Scrolled back to the product page twice to re-check the price before paying.", originalLanguage: "en", kind: "did", stance: "supports" },
  { id: "e6", participantId: "P029", sourceType: "interview", date: "2026-09-18", quote: "Delivery pakki hai? Agar date pakki nahi toh main COD bhi nahi karti.", originalLanguage: "hinglish", translation: "Is delivery certain? If the date isn't certain I won't even do cash on delivery.", kind: "said", stance: "contradicts" },
  { id: "e7", participantId: "P012", sourceType: "cx_call", date: "2026-09-25", quote: "Price theek tha, bas payment fail ho gaya do baar.", originalLanguage: "hinglish", translation: "The price was fine, the payment just failed twice.", kind: "said", stance: "contradicts", audio: { simulated: true, url: paymentAudio.url, duration: 3.93, cues: [{ start: 0, end: 1.35, text: "Price theek tha," }, { start: 1.35, end: 3.93, text: "bas payment fail ho gaya do baar." }] } },
  { id: "e8", participantId: "P021", sourceType: "interview", date: "2026-09-20", quote: "Timer dekh ke lagta hai jaldi karo, par sach mein khatam hota hai kya?", originalLanguage: "hinglish", translation: "Seeing the timer makes me feel I should hurry, but does it really end?", kind: "said", stance: "supports" },
  { id: "e9", participantId: "P027", sourceType: "usability", date: "2026-10-01", quote: "Ignored the countdown strip and went straight to the price comparison.", originalLanguage: "en", kind: "did", stance: "contradicts" },
  { id: "e10", participantId: "P031", sourceType: "interview", date: "2026-09-19", quote: "Itna bada discount? Kahin pehle se price badhaya toh nahi?", originalLanguage: "hinglish", translation: "Such a big discount? Did they raise the price beforehand?", kind: "said", stance: "supports" },
  { id: "e11", participantId: "P009", sourceType: "ab_test", date: "2026-08-30", quote: "Variant showing the saving amount in rupees had higher add-to-cart than the percentage variant (historical test).", originalLanguage: "en", kind: "did", stance: "supports" },
  { id: "e12", participantId: "P040", sourceType: "usability", date: "2026-10-03", quote: "Kept the item in cart for two days and bought it after a price-drop notification.", originalLanguage: "en", kind: "did", stance: "supports" },
  { id: "e13", participantId: "P036", sourceType: "interview", date: "2026-09-21", quote: "मुझे पहले यह जानना है कि वापसी कैसे होगी।", originalLanguage: "hi", translation: "I first want to know how returns will work.", kind: "said", stance: "supports" },
];

const conf = (score: number | null, participants: number, f: Confidence["factors"]): Confidence => ({
  score,
  label: confidenceLabel(score),
  participants,
  factors: f,
  methodStatus: "illustrative",
});

const cartImplications: Implications = {
  designer: { keep: "Keep the rupee saving visible on the product card.", change: "Show delivery and fees before the cart, not after it.", watch: "Reduce the visual prominence of urgency messaging." },
  researcher: { keep: "Treat total-cost surprise as the established finding.", change: "Separate price objections from payment failures in the next study.", watch: "Existing evidence on urgency is contradictory. Test it specifically." },
  pm: { keep: "Prioritise upfront total-cost display over new offers.", change: "Scope fee transparency before the next checkout release.", watch: "Urgency presents a potential trust risk before rollout." },
  marketing: { keep: "Lead with the rupee saving, not a percentage.", change: "Avoid offers that hide fees until checkout.", watch: "Countdown claims may read as pressure. Use them sparingly." },
  cx: { keep: "Prepare agents to quote the final payable amount early.", change: "Log fee-related abandonment separately from payment failures.", watch: "Expect questions about whether timers are genuine." },
  other: { keep: "Keep savings visible.", change: "Show the full cost earlier.", watch: "Be careful with urgency messaging." },
};

const genericImplications = (keep: string, change: string, watch: string): Implications => {
  const i = { keep, change, watch };
  return { designer: i, researcher: i, pm: i, marketing: i, cx: i, other: i };
};

const NOW = "2026-10-22T12:36:00Z";

export const ANSWERS: Answer[] = [
  {
    id: "a-tier2-cart",
    question: "Why do Tier 2 users abandon their cart?",
    audience: [ref("tier-2")],
    variant: "standard",
    headline: "Unexpected total cost is the clearest reason people abandon.",
    summary: "Most relevant evidence points to delivery fees and extra charges appearing late in checkout. Payment failures and delivery uncertainty explain a smaller share.",
    direction: { label: "price-related", pct: 76 },
    confidence: conf(83, 18, { sample: 78, agreement: 86, recency: 90, contradictions: 72 }),
    sources: 4,
    patterns: [
      { id: "p1", title: "Fees revealed late break the decision", summary: "Participants leave when delivery or platform fees appear only in the cart.", signal: "strong", label: "evidence", evidenceIds: ["e2", "e4"] },
      { id: "p2", title: "People need the final amount before committing", summary: "Participants ask for the final payable amount and re-check prices before paying.", signal: "strong", label: "evidence", evidenceIds: ["e3", "e5"] },
      { id: "p3", title: "Savings anchor attention, then get re-verified", summary: "Discounts draw people in, but large savings trigger doubt about the original price.", signal: "mixed", label: "inference", evidenceIds: ["e1", "e10"] },
    ],
    conflict: { title: "Price does not explain every abandonment.", body: "Some participants left because payment failed or delivery dates felt uncertain, even when the price was acceptable.", evidenceIds: ["e6", "e7"] },
    unknowns: [{ title: "Whether showing fees earlier changes completion", body: "No evidence yet tests fee placement directly with Tier 2 users. A comparison test is needed." }],
    implications: cartImplications,
    savedAt: "2026-10-22T12:24:00Z",
  },
  {
    id: "a-study-plan",
    question: "How should I test this?",
    audience: [ref("deal-driven")],
    variant: "study_plan",
    headline: "Test the trust boundary, not whether price matters.",
    summary: "Price sensitivity is already well evidenced. The gap is how much urgency and discount size people accept before they start doubting the offer.",
    confidence: conf(68, 14, { sample: 62, agreement: 70, recency: 84, contradictions: 58 }),
    sources: 3,
    patterns: [],
    unknowns: [{ title: "Where credibility tips into doubt", body: "No evidence isolates discount size or timer presence as the trigger for distrust." }],
    studyPlan: {
      objective: "Find the point at which discount size or urgency makes an offer feel less credible.",
      audience: "6–8 Deal-Driven Explorers, mixed Tier 1 and Tier 2, recent discount shoppers.",
      task: "Compare three offer cards (no timer, timer, large discount + timer) and choose one to buy.",
      watchFor: "Hesitation, price re-checking, mentions of fake or inflated original prices.",
      questions: [
        "Walk me through what you looked at first on this card.",
        "What would make you trust this price more?",
        "Tell me about the last time an offer felt too good to be true.",
        "What did you expect to happen when the timer ended?",
      ],
    },
    implications: genericImplications("Keep price sensitivity as an established finding.", "Run the trust-boundary test before changing urgency.", "Don't generalise from fewer than 6 sessions."),
    savedAt: NOW,
  },
  {
    id: "a-dark-mode",
    question: "Do new users prefer dark mode?",
    audience: [ref("new-users")],
    variant: "insufficient",
    headline: "Insufficient evidence",
    summary: "The research does not contain enough evidence to predict whether new users prefer dark mode.",
    confidence: conf(21, 2, { sample: 12, agreement: 30, recency: 40, contradictions: 50 }),
    sources: 1,
    patterns: [],
    known: [{ title: "Some new users browse late at night", body: "Two diary entries mention evening browsing. They don't mention display preferences.", label: "evidence" }],
    unknowns: [
      { title: "Display preference", body: "No participant was asked about light or dark themes." },
      { title: "Effect on completion", body: "No historical A/B result covers theme changes." },
    ],
    implications: genericImplications("Keep the current theme until there is evidence.", "Add a theme question to the next new-user study.", "Don't treat feature requests as preference evidence."),
    savedAt: NOW,
  },
  {
    id: "a-script-review",
    question: "Do you think this new checkout is easier than the old one?",
    audience: [ref("new-users")],
    variant: "script_review",
    headline: "Nearly ready. Two questions may lead participants.",
    summary: "Most questions are open and behaviour-focused. Rewrite the leading and double-barrelled ones before fieldwork.",
    confidence: conf(70, 9, { sample: 60, agreement: 72, recency: 80, contradictions: 66 }),
    sources: 2,
    patterns: [],
    unknowns: [],
    scriptReview: {
      readiness: "Nearly ready. Two questions may lead participants.",
      counts: { good: 7, improve: 3, leading: 2 },
      overlap: {
        title: "Existing evidence overlap",
        body: "Existing research already covers late fees, price re-checking, and payment failures. Use the revised questions to explore the checkout experience without assuming it has improved.",
        evidenceIds: ["e2", "e5", "e7"],
      },
      questions: [
        { id: "q1", original: "Do you think this new checkout is easier than the old one?", status: "leading", issue: "Leading", note: "Suggests the new checkout is easier and invites agreement.", rewrite: "Walk me through how you completed checkout today." },
        { id: "q2", original: "How fast and clear was the payment step?", status: "improve", issue: "Double-barrelled", note: "Asks about speed and clarity at once.", rewrite: "Tell me about the payment step. What, if anything, slowed you down?" },
        { id: "q3", original: "Would you use UPI if it were offered first?", status: "improve", issue: "Hypothetical", note: "Predicts future behaviour; answers are unreliable.", rewrite: "How did you pay the last time you bought online? Why that method?" },
        { id: "q4", original: "Tell me about the last time you left a purchase unfinished.", status: "good" },
      ],
    },
    implications: genericImplications("Keep the behaviour-based opening questions.", "Rewrite the two leading questions before fieldwork.", "Watch for agreement bias in moderated sessions."),
    savedAt: "2026-10-17T10:00:00Z",
  },
];

// Per-audience comparison columns (used when the dialog is in Compare mode).
export const COMPARISON_COLUMNS: Record<string, Omit<ComparisonColumn, "audience">> = {
  "tier-2": { direction: { label: "price-related", pct: 76 }, confidence: conf(83, 18, { sample: 78, agreement: 86, recency: 90, contradictions: 72 }), dimensions: [{ name: "Total cost surprise", signal: "strong", summary: "Late fees are the main trigger." }, { name: "Delivery certainty", signal: "mixed", summary: "Matters for COD users." }, { name: "Urgency", signal: "risk", summary: "Timers raise doubt." }] },
  "new-users": { confidence: conf(32, 5, { sample: 28, agreement: 40, recency: 70, contradictions: 45 }), dimensions: [{ name: "Total cost surprise", signal: "mixed", summary: "Few relevant sessions." }, { name: "Delivery certainty", signal: "mixed", summary: "Limited evidence." }, { name: "Urgency", signal: "mixed", summary: "Not studied." }] },
  "repeat-buyers": { direction: { label: "price-related", pct: 48 }, confidence: conf(71, 15, { sample: 70, agreement: 68, recency: 82, contradictions: 64 }), dimensions: [{ name: "Total cost surprise", signal: "mixed", summary: "Already expect fees." }, { name: "Delivery certainty", signal: "strong", summary: "Main reason to drop." }, { name: "Urgency", signal: "mixed", summary: "Mostly ignored." }] },
  "deal-driven": { direction: { label: "price-related", pct: 81 }, confidence: conf(79, 16, { sample: 74, agreement: 80, recency: 88, contradictions: 70 }), dimensions: [{ name: "Total cost surprise", signal: "strong", summary: "Compare totals across apps." }, { name: "Delivery certainty", signal: "mixed", summary: "Secondary." }, { name: "Urgency", signal: "risk", summary: "Large discounts trigger doubt." }] },
  "trust-conscious": { direction: { label: "trust-related", pct: 63 }, confidence: conf(74, 13, { sample: 66, agreement: 76, recency: 84, contradictions: 68 }), dimensions: [{ name: "Total cost surprise", signal: "mixed", summary: "Want clarity, not lowest price." }, { name: "Delivery certainty", signal: "strong", summary: "Returns and dates matter most." }, { name: "Urgency", signal: "risk", summary: "Reads as pressure." }] },
  "convenience-seeker": { direction: { label: "effort-related", pct: 58 }, confidence: conf(61, 9, { sample: 52, agreement: 64, recency: 80, contradictions: 60 }), dimensions: [{ name: "Total cost surprise", signal: "mixed", summary: "Tolerate small fees." }, { name: "Delivery certainty", signal: "strong", summary: "Predictable date wins." }, { name: "Urgency", signal: "mixed", summary: "Largely ignored." }] },
};

export const COMPARISON_TEMPLATE: Omit<Answer, "id" | "question" | "audience" | "savedAt" | "comparison"> = {
  variant: "comparison",
  headline: "These audiences abandon for different reasons.",
  summary: "Compare the evidence direction and confidence for each audience before deciding where to focus.",
  confidence: conf(70, 0, { sample: 0, agreement: 0, recency: 0, contradictions: 0 }),
  sources: 4,
  patterns: [],
  unknowns: [{ title: "Overlap between audiences", body: "Some participants appear in both audiences. They are counted once in each column." }],
  implications: genericImplications("Keep total-cost clarity for all audiences.", "Tailor delivery messaging per audience.", "Don't rank audiences when confidence is low."),
};

export const AUDIENCE_PROFILES: AudienceProfile[] = [
  {
    ref: ref("tier-2"), initials: "T2", description: "Participants living in emerging urban markets across India.", evidenceStrength: 82, corePatterns: 6, sources: 4, updatedAt: "2026-10-05",
    definingBehaviours: ["Compare final totals across apps before paying", "Prefer cash on delivery for first purchases", "Browse in Hinglish and Hindi interfaces"],
    needs: ["Know the full cost up front", "Certainty about delivery dates", "Easy returns"],
    painPoints: ["Fees revealed late in checkout", "Payment failures on slow networks", "Unclear return policies"],
    language: [{ quote: "Final kitna padega?", lang: "hinglish", translation: "How much will it come to in the end?", participantId: "P033" }, { quote: "Delivery pakki hai?", lang: "hinglish", translation: "Is delivery certain?", participantId: "P029" }],
    gaps: ["Few participants from the North-East", "No evidence on app vs. mobile web differences"],
  },
  {
    ref: ref("new-users"), initials: "NU", description: "Participants within their first 30 days of using the product.", evidenceStrength: 68, corePatterns: 4, sources: 3, updatedAt: "2026-10-05",
    definingBehaviours: ["Browse widely before a first purchase", "Read reviews before adding to cart"],
    needs: ["Reassurance the platform is legitimate", "Simple onboarding"],
    painPoints: ["Account creation at checkout", "Unfamiliar payment options"],
    language: [{ quote: "मुझे पहले यह जानना है कि वापसी कैसे होगी।", lang: "hi", translation: "I first want to know how returns will work.", participantId: "P036" }],
    gaps: ["No evidence on display or theme preferences", "Small sample for first-week behaviour"],
  },
  {
    ref: ref("repeat-buyers"), initials: "RB", description: "Participants with three or more completed purchases.", evidenceStrength: 88, corePatterns: 7, sources: 4, updatedAt: "2026-10-05",
    definingBehaviours: ["Use saved addresses and UPI", "Wait for price-drop notifications"],
    needs: ["Fast, predictable checkout", "Reliable delivery dates"],
    painPoints: ["Delivery delays", "Re-entering details after app updates"],
    language: [{ quote: "Price drop aaya toh le liya.", lang: "hinglish", translation: "When the price dropped, I bought it.", participantId: "P040" }],
    gaps: ["Limited evidence on subscription interest"],
  },
  {
    ref: ref("deal-driven"), initials: "DE", description: "Price-conscious explorers who browse broadly and verify savings before committing.", evidenceStrength: 87, corePatterns: 6, sources: 4, updatedAt: "2026-10-05",
    definingBehaviours: ["Look at the discount before the product", "Re-check prices across apps"],
    needs: ["Genuine, verifiable savings", "Rupee amounts, not percentages"],
    painPoints: ["Suspected inflated original prices", "Fees that erase the saving"],
    language: [{ quote: "Pehle discount dekhta hoon, fir product.", lang: "hinglish", translation: "First I look at the discount, then the product.", participantId: "P018" }],
    gaps: ["Urgency evidence is contradictory"],
    jobs: ["Get the best deal without being tricked"], triggers: ["Visible rupee saving", "Price-drop notifications"], trustBarriers: ["Very large discounts", "Countdown timers that reset"],
    saidVsDid: [{ said: "Timers make me hurry.", did: "Some ignored the timer and compared prices instead." }],
  },
  {
    ref: ref("trust-conscious"), initials: "TC", description: "Careful shoppers who look for credibility and control before purchase.", evidenceStrength: 81, corePatterns: 5, sources: 3, updatedAt: "2026-10-05",
    definingBehaviours: ["Check returns before adding to cart", "Prefer COD until trust is built"],
    needs: ["Clear return policy", "Certain delivery dates"],
    painPoints: ["Pressure tactics", "Unclear seller identity"],
    language: [{ quote: "Delivery pakki hai?", lang: "hinglish", translation: "Is delivery certain?", participantId: "P029" }],
    gaps: ["Few observed (did) sessions"],
    jobs: ["Buy without risk of loss"], triggers: ["Visible return policy", "Trusted payment options"], trustBarriers: ["Urgency messaging", "Hidden fees"],
    saidVsDid: [{ said: "I always read the return policy.", did: "About half opened the policy in usability sessions." }],
  },
  {
    ref: ref("convenience-seeker"), initials: "CS", description: "Time-sensitive shoppers who value a short, predictable path to completion.", evidenceStrength: 63, corePatterns: 3, sources: 2, updatedAt: "2026-10-05",
    definingBehaviours: ["Reorder from history", "Skip comparison when delivery is fast"],
    needs: ["Fewer steps", "Predictable delivery"],
    painPoints: ["Extra checkout steps", "OTP failures"],
    language: [{ quote: "Bas jaldi aa jaye.", lang: "hinglish", translation: "Just let it arrive quickly.", participantId: "P044" }],
    gaps: ["Smaller sample; keep this profile provisional"],
    jobs: ["Finish the purchase quickly"], triggers: ["Saved payment", "Same-day delivery"], trustBarriers: ["Surprise steps"],
    saidVsDid: [{ said: "Price doesn't matter much.", did: "Still abandoned when fees exceeded ₹80." }],
  },
];

export const ASSESSMENTS: Assessment[] = [
  {
    id: "as-offer-card",
    title: "Offer card checkout flow",
    prototype: { kind: "local_sample" },
    task: "Find a product under ₹1,000 and continue to checkout",
    goal: "Understand whether the offer feels credible before checkout",
    audience: [ref("deal-driven")],
    headline: "The price lands well. The countdown may cost trust.",
    summary: "Evidence suggests Deal-Driven Explorers will notice the saving quickly, but urgency and a large struck-through price may prompt doubt.",
    direction: { label: "positive toward the offer", pct: 64 },
    confidence: conf(72, 16, { sample: 70, agreement: 66, recency: 88, contradictions: 60 }),
    annotations: [
      { id: "an1", element: "price", title: "Price prominence", signal: "strong", summary: "Prediction: the ₹899 price and rupee saving will be noticed first.", participants: 12, evidenceIds: ["e1", "e11"] },
      { id: "an2", element: "countdown", title: "Countdown timer", signal: "mixed", summary: "Prediction: some will feel urgency, others will ignore or distrust the timer.", participants: 7, evidenceIds: ["e8", "e9"] },
      { id: "an3", element: "original_price", title: "Original price", signal: "risk", summary: "Prediction: a large struck-through price may raise doubts about inflated pricing.", participants: 5, evidenceIds: ["e10"] },
    ],
    conflict: { title: "Urgency evidence points both ways.", body: "Some participants said timers made them hurry; in usability sessions others ignored the strip entirely.", evidenceIds: ["e8", "e9"] },
    unknowns: [{ title: "Product image hierarchy", body: "No evidence covers how image size or placement affects this audience." }],
    implications: {
      designer: { keep: "Keep the ₹899 price and rupee saving prominent.", change: "Soften the red countdown strip.", watch: "Reduce the visual prominence of urgency messaging." },
      researcher: { keep: "Price prominence is well supported.", change: "Isolate the timer in the next test.", watch: "Existing evidence on urgency is contradictory. Test it specifically." },
      pm: { keep: "The offer format is low risk.", change: "Gate the countdown behind a test.", watch: "Urgency presents a potential trust risk before rollout." },
      marketing: { keep: "Lead with the ₹600 saving.", change: "Make sure the original price is defensible.", watch: "Timers may read as pressure." },
      cx: { keep: "Pricing should generate few queries.", change: "Prepare a reply on timer expiry.", watch: "Expect 'is the offer real?' questions." },
      other: { keep: "Keep the price prominent.", change: "Soften the timer.", watch: "Watch for trust issues." },
    },
    savedAt: "2026-10-21T15:00:00Z",
  },
];

export const PERSONA_CONVERSATIONS: Record<string, ChatMessage[]> = {
  "trust-conscious": [
    { id: "t1", from: "user", text: "What wording makes a promotion feel trustworthy?" },
    { id: "t2", from: "persona", text: "I want the final price and return policy stated plainly. Knowing when it will arrive reassures me more than being told I need to hurry.", label: "evidence", evidenceIds: ["e13", "e6"] },
    { id: "t3", from: "user", text: "Does 'Limited time' help?" },
    { id: "t4", from: "persona", text: "‘Limited time’ can make me feel pressured. I’d wonder whether the deadline is genuine before trusting it. That’s a possible reaction from a small research sample, not something everyone shares.", label: "inference", evidenceIds: ["e8"] },
    { id: "t5", from: "user", text: "Would a seller badge help?" },
    { id: "t6", from: "persona", text: "I can’t say whether a seller badge would help me—the research behind my persona doesn’t cover that. I’d rather keep it open than invent a preference.", label: "no_evidence", evidenceIds: [], suggestedStudy: "Preference test of two seller-badge treatments with 6 Trust-Conscious Shoppers." },
  ],
};

export const PERSONA_STRENGTH: Record<string, number> = { "deal-driven": 87, "trust-conscious": 81, "convenience-seeker": 63 };

export const SAVED_WORK: SavedWorkItem[] = [
  { id: "s1", title: "Why do Tier 2 users abandon cart?", type: "answer", audience: "Tier 2 users", status: "Answered", updatedAt: "2026-10-22T12:36:00Z", target: { to: "/ask/$id", id: "a-tier2-cart" } },
  { id: "s2", title: "Offer card checkout flow", type: "assessment", audience: "Deal-Driven Explorer", status: "Assessment ready", updatedAt: "2026-10-21T15:00:00Z", target: { to: "/assess/$id", id: "as-offer-card" } },
  { id: "s3", title: "Trust language for promotions", type: "persona_chat", audience: "Trust-Conscious Shopper", status: "6 messages", updatedAt: "2026-10-20T11:00:00Z", target: { to: "/persona-chat", persona: "trust-conscious" } },
  { id: "s4", title: "Checkout interview guide review", type: "script_review", audience: "New users", status: "Answered", updatedAt: "2026-10-17T10:00:00Z", target: { to: "/ask/$id", id: "a-script-review" } },
];

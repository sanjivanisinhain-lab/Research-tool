import type { Role } from "@/types/research";

// Role changes framing only. Evidence objects are identical across roles.
export const ROLE_OPTIONS: { id: Role; label: string; hint: string }[] = [
  { id: "designer", label: "Product Designer", hint: "Flows, layouts and interaction decisions" },
  { id: "researcher", label: "UX Researcher", hint: "Study design and evidence quality" },
  { id: "pm", label: "Product Manager", hint: "Prioritisation and rollout risk" },
  { id: "marketing", label: "Marketing", hint: "Messaging, offers and positioning" },
  { id: "cx", label: "Customer Experience", hint: "Support journeys and feedback" },
  { id: "other", label: "Other", hint: "Any decision about users" },
];

export const ROLE_LENS: Record<Role, { eyebrow: string; title: string }> = {
  designer: { eyebrow: "For your design", title: "Turn the finding into a safer decision" },
  researcher: { eyebrow: "For your research", title: "Decide what to test next" },
  pm: { eyebrow: "For your roadmap", title: "Weigh the rollout risk" },
  marketing: { eyebrow: "For your messaging", title: "Frame the offer with care" },
  cx: { eyebrow: "For your support journeys", title: "Prepare for what customers will raise" },
  other: { eyebrow: "For your decision", title: "Turn the finding into a safer decision" },
};

export function roleLabel(role: Role | undefined) {
  return ROLE_OPTIONS.find((r) => r.id === role)?.label ?? "Guest";
}

// Role-specific starter prompts for the Ask home screen. [label, question]
export const ROLE_STARTERS: Record<Role, readonly [string, string][]> = {
  researcher: [
    ["Script review", "Do you think this new checkout interview question is leading?"],
    ["Evidence gap", "What are our biggest evidence gaps around delivery trust?"],
    ["Consistency", "How consistent are participant responses on price sensitivity across cohorts?"],
    ["Said vs did", "Compare stated preferences vs actual click behaviour in cart."],
  ],
  designer: [
    ["Design feedback", "Would this offer card hierarchy work for Deal-Driven Explorers?"],
    ["Friction", "Where do users experience visual or cognitive friction in checkout?"],
    ["Trust", "What makes reassurance messaging feel genuine before payment?"],
    ["Behaviour", "Why do Tier 2 users abandon their cart at the review step?"],
  ],
  pm: [
    ["Behaviour", "What is the primary driver behind cart abandonment for Tier 2 cohorts?"],
    ["Confidence", "How confident can we be that delivery charges cause drop-offs?"],
    ["Trade-offs", "What trade-offs do Repeat Buyers make between speed and cost?"],
    ["Decision support", "What evidence exists to support removing the countdown timer?"],
  ],
  cx: [
    ["Complaints", "What are the most frequent complaints callers raise about payment failure?"],
    ["In their words", "How do users describe delivery delays in their own words?"],
    ["Repeat tickets", "What post-purchase issues create repeat support tickets?"],
    ["Confusion", "Do Tier 2 callers report confusion with coupon application?"],
  ],
  marketing: [
    ["Positioning", "Which value proposition resonates most with Deal-Driven Explorers?"],
    ["Messaging", "How do shoppers perceive 'Save ₹600' vs flat discount messaging?"],
    ["Trust signals", "What trust signals are necessary before first-time buyers commit?"],
    ["Language", "What language do users use when discussing genuine deals?"],
  ],
  other: [
    ["Behaviour", "Why do Tier 2 users abandon their cart?"],
    ["Design feedback", "Would this offer card work for Deal-Driven Explorers?"],
    ["Trust", "What makes reassurance messaging feel genuine before payment?"],
    ["Evidence gap", "Do new users prefer dark mode?"],
  ],
};

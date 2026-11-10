import { describe, expect, it } from "vitest";
import { confidenceLabel, shouldWithhold } from "@/config/confidence";
import { countUniqueParticipants } from "@/lib/participants";
import { ROLE_OPTIONS, ROLE_STARTERS } from "@/lib/roleLens";

describe("research rules", () => {
  it("labels confidence by threshold", () => {
    expect(confidenceLabel(21)).toBe("very_low");
    expect(confidenceLabel(49)).toBe("low");
    expect(confidenceLabel(74)).toBe("medium");
    expect(confidenceLabel(83)).toBe("high");
  });
  it("withholds predictions below 40", () => {
    expect(shouldWithhold(39)).toBe(true);
    expect(shouldWithhold(40)).toBe(false);
  });
  it("counts participants once across audiences", () => {
    expect(countUniqueParticipants([["P1", "P2"], ["P2", "P3"]])).toBe(3);
  });
  it("gives every role four starter prompts", () => {
    for (const r of ROLE_OPTIONS) expect(ROLE_STARTERS[r.id]).toHaveLength(4);
  });
  it("uses the role-specific starter copy", () => {
    expect(ROLE_STARTERS.researcher.map(([, t]) => t)).toContain("What are our biggest evidence gaps around delivery trust?");
    expect(ROLE_STARTERS.cx.map(([, t]) => t)).toContain("What are the most frequent complaints callers raise about payment failure?");
    expect(ROLE_STARTERS.marketing.map(([, t]) => t)).toContain("How do shoppers perceive 'Save ₹600' vs flat discount messaging?");
  });
});

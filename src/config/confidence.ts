import type { ConfidenceLabel } from "@/types/research";

// PLACEHOLDER thresholds — illustrative until the research team defines the method.
export const CONFIDENCE_THRESHOLDS = {
  veryLow: 25, // score < 25 → very low
  low: 50, // score < 50 → low
  medium: 75, // score < 75 → medium; ≥ 75 → high
  withholdPrediction: 40, // below this, no evidence direction / reaction is shown
} as const;

export function confidenceLabel(score: number | null): ConfidenceLabel {
  if (score === null || score < CONFIDENCE_THRESHOLDS.veryLow) return "very_low";
  if (score < CONFIDENCE_THRESHOLDS.low) return "low";
  if (score < CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "high";
}

export function shouldWithhold(score: number | null): boolean {
  return score === null || score < CONFIDENCE_THRESHOLDS.withholdPrediction;
}

export const CONFIDENCE_LABEL_TEXT: Record<ConfidenceLabel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  very_low: "Very low confidence",
};

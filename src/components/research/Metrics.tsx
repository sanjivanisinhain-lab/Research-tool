import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CONFIDENCE_LABEL_TEXT, CONFIDENCE_THRESHOLDS, shouldWithhold } from "@/config/confidence";
import type { Confidence } from "@/types/research";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function EvidenceDirectionBar({ direction }: { direction: { label: string; pct: number } }) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <p className="eyebrow">Evidence direction</p>
        <Popover open={infoOpen} onOpenChange={setInfoOpen}>
          <PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-7" aria-label="About evidence direction" onMouseEnter={() => setInfoOpen(true)} onFocus={() => setInfoOpen(true)} onClick={(event) => { event.preventDefault(); setInfoOpen(true); }}><Info className="size-3.5 text-muted-foreground" /></Button></PopoverTrigger>
          <PopoverContent className="max-w-64 text-sm">Share of relevant evidence pointing this way. Not a share of all users.</PopoverContent>
        </Popover>
      </div>
      <p className="mt-2 font-display text-4xl font-semibold tabular-nums">
        {direction.pct}% <span className="text-lg font-medium text-muted-foreground">{direction.label}</span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary" role="img" aria-label={`${direction.pct}% of relevant evidence is ${direction.label}`}>
        <div className="h-full rounded-full bg-brand" style={{ width: `${direction.pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Of relevant evidence, not of all users.</p>
    </div>
  );
}

export function WithheldDirection() {
  return (
    <div>
      <p className="eyebrow">Evidence direction</p>
      <p className="mt-2 font-display text-2xl font-semibold">Prediction withheld</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Confidence is below {CONFIDENCE_THRESHOLDS.withholdPrediction}%, so no reaction is shown.
      </p>
    </div>
  );
}

const ringColor = (score: number | null) =>
  score === null || score < CONFIDENCE_THRESHOLDS.low ? "var(--risk)" : score < CONFIDENCE_THRESHOLDS.medium ? "var(--mixed)" : "var(--strong)";

export function ConfidenceRing({ confidence, expandable = true, size = 76 }: { confidence: Confidence; expandable?: boolean; size?: number }) {
  const [open, setOpen] = useState(false);
  const s = confidence.score ?? 0;
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const factors = [
    ["Sample strength", confidence.factors.sample],
    ["Evidence agreement", confidence.factors.agreement],
    ["Recency", confidence.factors.recency],
    ["Contradictions (higher = fewer)", confidence.factors.contradictions],
  ] as const;
  return (
    <div>
      <p className="eyebrow">Response confidence</p>
      <div className="mt-2 flex items-center gap-4">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Confidence ${s}%`} className="-rotate-90 shrink-0">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--secondary)" strokeWidth="6" />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor(confidence.score)} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - s / 100)} />
          <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="rotate-90 fill-foreground font-display text-base font-semibold" style={{ transformOrigin: "center" }}>
            {confidence.score === null ? "—" : `${s}%`}
          </text>
        </svg>
        <div className="min-w-0">
          <p className="font-semibold">{CONFIDENCE_LABEL_TEXT[confidence.label]}</p>
          <p className="text-sm text-muted-foreground">{confidence.participants} relevant participant{confidence.participants === 1 ? "" : "s"}</p>
          {expandable && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand">
              {open ? "Hide" : "Show"} breakdown <ChevronDown className={cn("size-4 transition", open && "rotate-180")} />
            </button>
          )}
        </div>
      </div>
      {expandable && open && (
        <div className="mt-4 space-y-3 rounded-xl bg-muted/70 p-4">
          {factors.map(([name, v]) => (
            <div key={name}>
              <div className="mb-1 flex justify-between text-xs"><span>{name}</span><span className="tabular-nums text-muted-foreground">{v}</span></div>
              <div className="h-1.5 rounded-full bg-background"><div className="h-full rounded-full bg-foreground/70" style={{ width: `${v}%` }} /></div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", confidence.methodStatus === "computed_v1" ? "bg-strong-soft text-strong" : "bg-mixed-soft text-mixed")}>{confidence.methodStatus === "computed_v1" ? "Computed from the evidence (v1)" : "Illustrative until the method is defined"}</span>
            <Popover>
              <PopoverTrigger className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline">
                <Info className="size-3.5" /> How confidence is calculated
              </PopoverTrigger>
              <PopoverContent className="text-sm">
                {confidence.methodStatus === "computed_v1"
                  ? <>Calculated by a fixed formula, not by the AI. Weights: sample 35%, agreement 30%, contradictions 20%, recency 15%. Sample counts distinct participants (not mentions) with diminishing returns; recency halves every 180 days (undated evidence counts as half-fresh). Below {CONFIDENCE_THRESHOLDS.withholdPrediction}% we withhold predictions.</>
                  : <>Scores and factors are supplied simulated values, not a calculated result. A future method will consider unique participant sample strength, agreement, recency and contradictions; weighting is not yet defined. Below {CONFIDENCE_THRESHOLDS.withholdPrediction}% we withhold predictions.</>}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
    </div>
  );
}

export function MetricsCard({ direction, confidence }: { direction?: { label: string; pct: number } | undefined; confidence: Confidence }) {
  const withhold = shouldWithhold(confidence.score);
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-2">
      <div className="bg-card p-6">{!withhold && direction ? <EvidenceDirectionBar direction={direction} /> : <WithheldDirection />}</div>
      <div className="bg-card p-6"><ConfidenceRing confidence={confidence} /></div>
    </div>
  );
}

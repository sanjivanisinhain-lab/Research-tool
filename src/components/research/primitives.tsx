import { IS_MOCK } from "@/config/dataMode";
import { BookOpen, ChevronRight, X, Plus, AlertCircle, RotateCw, Sparkle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { AudienceRef, ClaimLabel, EvidenceItem, Signal, SourceType } from "@/types/research";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export const SOURCE_LABEL: Record<SourceType, string> = {
  interview: "Research interview",
  cx_call: "CX call",
  diary: "Diary study",
  usability: "Usability session",
  ab_test: "A/B result",
};
export const LANG_LABEL = { en: "English", hi: "Hindi", hinglish: "Hinglish" } as const;

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("eyebrow", className)}>{children}</p>;
}

const SIGNAL: Record<Signal, { text: string; cls: string; dot: string }> = {
  strong: { text: "Strong signal", cls: "bg-strong-soft text-strong", dot: "bg-strong" },
  mixed: { text: "Mixed signal", cls: "bg-mixed-soft text-mixed", dot: "bg-mixed" },
  risk: { text: "Potential risk", cls: "bg-risk-soft text-risk", dot: "bg-risk" },
};
export const signalDot = (s: Signal) => SIGNAL[s].dot;

export function SignalPill({ signal, className }: { signal: Signal; className?: string }) {
  const s = SIGNAL[signal];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", s.cls, className)}>
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden />
      {s.text}
    </span>
  );
}

const LABEL: Record<ClaimLabel, { text: string; cls: string }> = {
  evidence: { text: "Evidence", cls: "border-strong/30 text-strong" },
  inference: { text: "Inference", cls: "border-mixed/40 text-mixed" },
  no_evidence: { text: "No evidence", cls: "border-unknown/30 text-unknown bg-unknown-soft" },
};
export function ClaimTag({ label }: { label: ClaimLabel }) {
  const l = LABEL[label];
  return <span className={cn("inline-flex rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider", l.cls)}>{l.text}</span>;
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "strong" | "mixed" | "persona" | "risk" }) {
  const cls = {
    neutral: "bg-secondary text-secondary-foreground",
    strong: "bg-strong-soft text-strong",
    mixed: "bg-mixed-soft text-mixed",
    persona: "bg-persona-soft text-persona",
    risk: "bg-risk-soft text-risk",
  }[tone];
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", cls)}>{children}</span>;
}

export function Logo({ inverted }: { inverted?: boolean }) {
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", inverted ? "bg-brand-foreground text-brand" : "bg-foreground text-background")}>
      <Sparkle className="size-4" />
    </span>
  );
}

export function SimulatedDataBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <span className={cn("size-2 rounded-full", IS_MOCK ? "bg-mixed" : "bg-strong")} aria-hidden />
      {IS_MOCK ? "Simulated research data" : "Real research data"}
    </span>
  );
}

export function CitationChip({ item, onClick }: { item: EvidenceItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-foreground/80 transition hover:border-foreground/30 hover:text-foreground"
    >
      <BookOpen className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="font-semibold tabular-nums">{item.participantId}</span>
      <span className="text-muted-foreground">· {SOURCE_LABEL[item.sourceType]}</span>
      <ChevronRight className="size-3 text-muted-foreground transition group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}

export function AudienceChips({
  audience,
  onRemove,
  onAdd,
  suggested,
  onAcceptSuggested,
}: {
  audience: AudienceRef[];
  onRemove?: (id: string) => void;
  onAdd?: () => void;
  suggested?: AudienceRef | null;
  onAcceptSuggested?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {audience.map((a) => (
        <span
          key={a.id}
          className={cn(
            "inline-flex max-w-full items-center gap-2 rounded-full border py-1.5 pl-3 pr-1.5 text-sm font-medium",
            a.kind === "segment" ? "border-segment/25 bg-segment-soft text-segment" : "border-persona/25 bg-persona-soft text-persona",
            !onRemove && "pr-3",
          )}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", a.kind === "segment" ? "bg-segment" : "bg-persona")} aria-hidden />
          <span>{a.name}</span><span className="border-l border-current/20 pl-2 tabular-nums">{a.participants}</span>
          {onRemove && (
            <Button variant="ghost" size="icon" type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)} className="size-6 rounded-full p-0.5 hover:bg-foreground/10">
              <X className="size-3.5" />
            </Button>
          )}
        </span>
      ))}
      {suggested && onAcceptSuggested && (
        <button type="button" onClick={onAcceptSuggested} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-persona/40 px-3 py-1 text-sm text-persona">
          <span className="rounded bg-persona-soft px-1 text-[10px] font-semibold uppercase">Suggested</span>
          {suggested.name}
          <Plus className="size-3.5" />
        </button>
      )}
      {onAdd && (
        <Button variant="outline" type="button" onClick={onAdd} className="h-9 gap-1.5 rounded-full border-dashed border-foreground/25 px-3 text-sm font-medium text-foreground/80 shadow-none hover:border-foreground/50 hover:text-foreground">
          <Plus className="size-3.5" /> Add or compare
        </Button>
      )}
    </div>
  );
}

export function PageHeader({ eyebrow, title, sub, children }: { eyebrow: string; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-9 flex flex-wrap items-end justify-between gap-6 border-b pb-8">
      <div className="max-w-2xl">
        <Eyebrow className="mb-3 text-brand">{eyebrow}</Eyebrow>
        <h1 className="text-3xl font-semibold leading-[1.12] md:text-5xl">{title}</h1>
        {sub && <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </header>
  );
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-2/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-2xl" />
      ))}
    </div>
  );
}

export function ErrorState({ message = "Something went wrong loading this.", onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border bg-card p-10 text-center">
      <AlertCircle className="mb-3 size-6 text-risk" />
      <p className="font-medium">{message}</p>
      <Button variant="outline" className="mt-4 rounded-full" onClick={onRetry}>
        <RotateCw className="size-4" /> Try again
      </Button>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/50 p-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function relativeTime(iso: string, now = Date.now()) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  return `${d} days ago`;
}

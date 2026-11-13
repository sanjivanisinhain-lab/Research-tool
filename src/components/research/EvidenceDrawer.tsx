import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Table2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { EvidenceItem } from "@/types/research";
import { Button } from "@/components/ui/button";
import { useEvidence } from "@/api/hooks";
import { cn } from "@/lib/utils";
import { LANG_LABEL, SOURCE_LABEL, ErrorState, SimulatedDataBadge } from "./primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { CxAudioPlayer } from "./CxAudioPlayer";

type Ctx = { open: (ids: string[], tab?: "supports" | "contradicts") => void };
const EvidenceCtx = createContext<Ctx>({ open: () => {} });
export const useEvidenceDrawer = () => useContext(EvidenceCtx);

export function EvidenceDrawerProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [tab, setTab] = useState<"supports" | "contradicts">("supports");
  const open = useCallback((next: string[], t?: "supports" | "contradicts") => {
    setIds(next);
    setTab(t ?? "supports");
  }, []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <EvidenceCtx.Provider value={value}>
      {children}
      <EvidenceDrawer ids={ids ?? []} isOpen={!!ids} onClose={() => setIds(null)} tab={tab} setTab={setTab} />
    </EvidenceCtx.Provider>
  );
}

function EvidenceDrawer({ ids, isOpen, onClose, tab, setTab }: { ids: string[]; isOpen: boolean; onClose: () => void; tab: "supports" | "contradicts"; setTab: (t: "supports" | "contradicts") => void }) {
  const q = useEvidence(ids);
  const items = q.data ?? [];
  const shown = items.filter((i) => i.stance === tab);
  const participants = new Set(items.map((i) => i.participantId)).size;
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  return (
    <Sheet open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-background sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b pb-4">
          <SheetTitle className="font-display text-2xl">Supporting evidence</SheetTitle>
          <SheetDescription>
            {participants} participant{participants === 1 ? "" : "s"}, counted once · <SimulatedDataBadge />
          </SheetDescription>
          <div role="tablist" className="mt-3 inline-flex w-fit rounded-full bg-secondary p-1">
            {(["supports", "contradicts"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn("rounded-full px-4 py-1.5 text-sm font-medium", tab === t ? "bg-card shadow-sm" : "text-muted-foreground")}
              >
                {t === "supports" ? "Supporting" : "Contradicting"} ({items.filter((i) => i.stance === t).length})
              </button>
            ))}
          </div>
        </SheetHeader>
        <div className="space-y-4 p-4">
          {q.isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
          {q.isError && <ErrorState onRetry={() => q.refetch()} />}
          {!q.isLoading && !q.isError && shown.length === 0 && (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              No {tab === "supports" ? "supporting" : "contradicting"} evidence for this claim.
            </p>
          )}
          {shown.map((e) => (
            <article key={e.id} className="rounded-2xl border bg-card p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md bg-foreground px-2 py-0.5 font-semibold tabular-nums text-background">{e.participantId}</span>
                <span className="text-muted-foreground">{SOURCE_LABEL[e.sourceType]}</span>
                <span className="text-muted-foreground">· {new Date(e.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                <span className={cn("ml-auto rounded-full px-2 py-0.5 font-semibold uppercase tracking-wider", e.kind === "said" ? "bg-secondary" : "bg-brand-soft text-brand")}>
                  {e.kind === "said" ? "Said" : "Did"}
                </span>
              </div>
              <div className={cn("grid gap-3", e.translation && "sm:grid-cols-2")}>
                <div>
                  <p className="eyebrow mb-1">Original · {LANG_LABEL[e.originalLanguage]}</p>
                  <blockquote className="font-display text-lg leading-snug">“{e.quote}”</blockquote>
                </div>
                {e.translation && (
                  <div className="rounded-xl bg-muted p-3">
                    <p className="eyebrow mb-1">Translation · English</p>
                    <p className="text-sm text-muted-foreground">{e.translation}</p>
                  </div>
                )}
              </div>
              {e.audio && expandedSource !== e.id && <CxAudioPlayer evidence={e} />}
              <div className="mt-4 flex justify-end">
                <Button variant="outline" size="sm" className="rounded-full" aria-expanded={expandedSource === e.id} aria-controls={`source-${e.id}`} onClick={() => setExpandedSource((id) => id === e.id ? null : e.id)}>
                  <ExternalLink className="size-3.5" /> {expandedSource === e.id ? "Close source" : "Open source"}
                </Button>
              </div>
              {expandedSource === e.id && <SourceContext evidence={e} onNavigate={onClose} />}
            </article>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SourceContext({ evidence: e, onNavigate }: { evidence: EvidenceItem; onNavigate: () => void }) {
  const source = e.sourceContext;
  if (!source) return <p className="mt-4 text-sm text-muted-foreground">Source context unavailable.</p>;
  return <section id={`source-${e.id}`} className="mt-4 border-t pt-4" aria-label={source.simulated ? "Simulated source context" : "Source context"}>
    <p className={source.simulated ? "eyebrow text-mixed" : "eyebrow"}>{source.simulated ? "Simulated source context" : "Source context"}</p>
    <h3 className="mt-2 font-semibold">{source.title}</h3>
    <dl className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-muted-foreground">Source reference</dt><dd>{source.reference}</dd></div><div><dt className="text-muted-foreground">Session date</dt><dd>{e.date}</dd></div><div><dt className="text-muted-foreground">Participant</dt><dd>{e.participantId}</dd></div><div><dt className="text-muted-foreground">Recording</dt><dd>{source.recording}</dd></div></dl>
    <p className="mt-4 text-sm text-muted-foreground">{source.context}</p>
    <blockquote className="mt-3 border-l-2 border-brand pl-3 text-sm">{e.quote}</blockquote>
    {e.audio && <CxAudioPlayer evidence={e} />}
    {e.sheet && (
      <p className="mt-3 text-sm">
        <Link to="/sheets/$id" onClick={onNavigate} params={{ id: e.sheet.linkId }} search={{ tab: e.sheet.tab, row: e.sheet.row }} className="inline-flex items-center gap-1.5 font-medium text-brand underline">
          <Table2 className="size-4" />View row {e.sheet.row} in {e.sheet.name}
        </Link>
        {e.sheet.removed && <span className="ml-2 text-xs text-risk">This row was later removed from the sheet.</span>}
      </p>
    )}
    <p className="mt-3 text-xs text-muted-foreground">{source.simulated ? "Demo context only; not an original transcript or real recording. " : "Names, numbers and cities were removed before storage. "}Translations are shown separately from original wording.</p>
  </section>;
}

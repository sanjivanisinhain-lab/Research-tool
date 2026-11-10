import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAssessment, useEvidence, useProfile } from "@/api/hooks";
import { ProductCard } from "@/components/research/ProductCard";
import { MetricsCard } from "@/components/research/Metrics";
import { ConflictCard, DesignImplications, NextActions, Section, UnknownCard } from "@/components/research/AnswerParts";
import { AudienceChips, CitationChip, EmptyState, ErrorState, LoadingBlock, SignalPill } from "@/components/research/primitives";
import { useEvidenceDrawer } from "@/components/research/EvidenceDrawer";
import { cn } from "@/lib/utils";
import { signalDot } from "@/components/research/primitives";
import type { Annotation } from "@/types/research";

const BASE = import.meta.env["VITE_API_BASE_URL"] ?? "";

// An uploaded design with numbered markers placed from each annotation's box (0-1000 scale: [ymin, xmin, ymax, xmax]).
function UploadedDesign({ id, annotations, activeId, onSelect }: { id: string; annotations: Annotation[]; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="relative mx-auto w-fit max-w-full">
      <img src={`${BASE}/api/assessments/${id}/image`} alt="The assessed design" className="block max-h-[640px] max-w-full rounded-xl border bg-card" />
      {annotations.map((a, i) => a.box && (
        <div key={a.id} className="absolute" style={{ top: `${a.box[0] / 10}%`, left: `${a.box[1] / 10}%`, height: `${(a.box[2] - a.box[0]) / 10}%`, width: `${(a.box[3] - a.box[1]) / 10}%` }}>
          <div className={cn("size-full rounded-md border-2 border-dashed transition", activeId === a.id ? "border-foreground" : "border-foreground/30")} />
          <button type="button" onClick={() => onSelect(a.id)} aria-label={`Annotation ${i + 1}: ${a.title}`} className={cn("absolute -left-3 -top-3 z-10 grid size-7 place-items-center rounded-full border-2 border-card text-xs font-bold text-primary-foreground shadow-md", signalDot(a.signal), activeId === a.id && "scale-125 ring-2 ring-foreground")}>{i + 1}</button>
        </div>
      ))}
    </div>
  );
}

export const Route = createFileRoute("/assess/$id")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Assessment — Research Hub" }, { name: "description", content: "Evidence-linked predictions for your prototype." }, { property: "og:title", content: "Assessment — Research Hub" }, { property: "og:description", content: "Prototype assessment." }] }),
  component: AssessmentPage,
});

function AssessmentPage() {
  const { id } = Route.useParams();
  const q = useAssessment(id);
  const profile = useProfile();
  const drawer = useEvidenceDrawer();
  const [active, setActive] = useState<string | null>(null);
  const ids = useMemo(() => q.data?.annotations.flatMap((a) => a.evidenceIds) ?? [], [q.data]);
  const ev = useEvidence(ids);
  const map = new Map((ev.data ?? []).map((e) => [e.id, e]));
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const a = q.data;
  if (!a) return <EmptyState title="Assessment not found" action={<Link to="/assess" className="underline">Start a new one</Link>} />;
  return (
    <div>
      <Link to="/assess" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />New assessment</Link>
      <h1 className="mt-6 text-3xl font-semibold md:text-[2.5rem]">{a.title}</h1>
      <p className="mt-2 text-muted-foreground">{a.task}</p>
      <div className="mt-3"><AudienceChips audience={a.audience} /></div>
      <div className="mt-8"><span className="rounded-full bg-persona-soft px-3 py-1 text-xs font-semibold text-persona">Prediction · not a test result</span></div>
      <h2 className="mt-4 text-3xl font-semibold">{a.headline}</h2>
      <p className="mt-2 max-w-3xl text-lg text-muted-foreground">{a.summary}</p>
      <div className="mt-8"><MetricsCard direction={a.direction} confidence={a.confidence} /></div>
      <Section eyebrow="Element by element" title="Where the prototype may help or hurt">
        <div className={cn("grid gap-8", a.prototype.kind === "upload" ? "lg:grid-cols-[minmax(0,420px)_1fr]" : "lg:grid-cols-[320px_1fr]")}>
          <div className="rounded-3xl bg-secondary p-6 lg:sticky lg:top-6 lg:self-start">{a.prototype.kind === "upload" ? <UploadedDesign id={a.id} annotations={a.annotations} activeId={active} onSelect={setActive} /> : <ProductCard annotations={a.annotations} activeId={active} onSelect={setActive} />}</div>
          <ol className="space-y-3">
            {a.annotations.map((n, i) => (
              <li key={n.id}>
                <div onMouseEnter={() => setActive(n.id)} className={cn("rounded-2xl border bg-card p-5 transition", active === n.id && "border-foreground/40 shadow-sm")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold"><span className="mr-2 tabular-nums text-muted-foreground">{i + 1}</span>{n.title}</p>
                    <div className="flex items-center gap-2"><span className="rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-persona">Prediction</span><SignalPill signal={n.signal} /></div>
                  </div>
                  <p className="mt-1 text-muted-foreground">{n.summary}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{n.participants} participants</p>
                  <div className="mt-3 flex flex-wrap gap-2">{n.evidenceIds.map((e) => map.get(e) && <CitationChip key={e} item={map.get(e)!} onClick={() => drawer.open(n.evidenceIds, map.get(e)!.stance)} />)}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>
      <div className="mt-10 space-y-4">
        {a.conflict && <ConflictCard {...a.conflict} />}
        {a.unknowns.map((u) => <UnknownCard key={u.title} {...u} />)}
      </div>
      <DesignImplications implication={a.implications[profile.data?.role ?? "designer"]} role={profile.data?.role ?? "designer"} />
      <NextActions actions={[{ label: "Ask about this audience", primary: true, to: "/" }, { label: "Plan usability test", to: "/" }]} />
    </div>
  );
}

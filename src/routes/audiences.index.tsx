import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { useAudiences } from "@/api/hooks";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/research/primitives";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/audiences/")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Audiences — Research Hub" }, { name: "description", content: "Understand who your research represents." }, { property: "og:title", content: "Audiences — Research Hub" }, { property: "og:description", content: "Segments and research-derived personas." }] }),
  component: Audiences,
});

function Audiences() {
  const q = useAudiences();
  const [tab, setTab] = useState<"segment" | "persona">("segment");
  const [s, setS] = useState("");
  const list = (q.data ?? []).filter((a) => a.ref.kind === tab && a.ref.name.toLowerCase().includes(s.toLowerCase()));
  return (
    <div>
      <PageHeader eyebrow="Audience library" title="Understand who your research represents." sub="Segments are participant cohorts. Personas are behavioural profiles derived from evidence." />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full bg-secondary p-1">
          {(["segment", "persona"] as const).map((t) => <Button variant="ghost" key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={cn("rounded-full px-5 py-1.5 text-sm font-medium", tab === t ? "bg-card shadow-sm" : "text-muted-foreground")}>{t === "segment" ? "Segments" : "Personas"}</Button>)}
        </div>
        <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input aria-label="Search audiences" value={s} onChange={(e) => setS(e.target.value)} placeholder="Search" className="h-10 w-64 rounded-full border bg-card pl-9 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
      </div>
      {q.isLoading && <LoadingBlock />}
      {q.isError && <ErrorState onRetry={() => q.refetch()} />}
      {q.data && list.length === 0 && <EmptyState title="No audiences match" body="Try a different search." />}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {list.map((a) => {
          const high = a.evidenceStrength >= 75;
          return (
            <Link key={a.ref.id} to="/audiences/$kind/$id" params={{ kind: a.ref.kind, id: a.ref.id }} className="research-card group flex flex-col rounded-lg border bg-card p-6 hover:border-foreground/30">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span className={cn("grid size-12 place-items-center rounded-2xl font-display text-lg font-semibold", a.ref.kind === "segment" ? "bg-segment-soft text-segment" : "bg-persona-soft text-persona")}>{a.initials}</span>
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", high ? "bg-strong-soft text-strong" : "bg-mixed-soft text-mixed")}>{a.evidenceStrength}% evidence · {high ? "High" : "Medium"}</span>
              </div>
              <h2 className="mt-5 text-xl font-semibold">{a.ref.name}</h2>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{a.description}</p>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs">
                <span className="text-muted-foreground"><b className="text-foreground tabular-nums">{a.ref.participants}</b> participants · <b className="text-foreground">{a.corePatterns}</b> patterns</span>
                <span className="inline-flex items-center gap-1 font-medium">Explore <ArrowRight className="size-4 transition group-hover:translate-x-0.5" /></span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useAudience } from "@/api/hooks";
import { EmptyState, ErrorState, Eyebrow, LANG_LABEL, LoadingBlock } from "@/components/research/primitives";
import { Button } from "@/components/ui/button";
import type { AudienceKind } from "@/types/research";

export const Route = createFileRoute("/audiences/$kind/$id")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Audience profile — Research Hub" }, { name: "description", content: "What the research says about this audience." }, { property: "og:title", content: "Audience profile — Research Hub" }, { property: "og:description", content: "Research-derived audience profile." }] }),
  component: Detail,
});

function Card({ title, items, tone }: { title: string; items?: string[] | undefined; tone?: string }) {
  if (!items?.length) return null;
  return (
    <div className={`rounded-2xl border p-5 ${tone ?? "bg-card"}`}>
      <Eyebrow>{title}</Eyebrow>
      <ul className="mt-3 space-y-2">{items.map((i) => <li key={i} className="flex gap-2 text-sm leading-snug"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40" />{i}</li>)}</ul>
    </div>
  );
}

function Detail() {
  const { kind, id } = Route.useParams();
  const q = useAudience(kind as AudienceKind, id);
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const a = q.data;
  if (!a) return <EmptyState title="Audience not found" action={<Link to="/audiences" className="underline">All audiences</Link>} />;
  return (
    <div>
      <Link to="/audiences" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />All audiences</Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <Eyebrow className="text-brand">{a.ref.kind === "segment" ? "Segment" : "Persona · research-derived composite"}</Eyebrow>
          <h1 className="mt-3 text-5xl font-semibold">{a.ref.name}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{a.description}</p>
        </div>
        <Button asChild className="rounded-full px-5"><Link to="/" search={{ audience: a.ref.id }}>Ask about this audience</Link></Button>
      </div>
      <div className="mt-10 grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl bg-foreground p-6 text-background lg:row-span-2">
          <dl className="space-y-6">
            {[["Represented participants", a.ref.participants], ["Evidence strength", `${a.evidenceStrength}%`], ["Research sources", a.sources]].map(([k, v]) => (
              <div key={k as string}><dt className="text-xs uppercase tracking-wider text-background/60">{k}</dt><dd className="font-display text-4xl font-semibold tabular-nums">{v}</dd></div>
            ))}
          </dl>
          <p className="mt-8 text-xs text-background/60">Updated {new Date(a.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · Simulated research data</p>
        </div>
        <Card title="Defining behaviours" items={a.definingBehaviours} />
        <Card title="Needs and motivations" items={a.needs} />
        <Card title="Pain points" items={a.painPoints} />
        <div className="rounded-2xl border bg-card p-5">
          <Eyebrow>Language in context</Eyebrow>
          <div className="mt-3 space-y-3">{a.language.map((l) => (
            <div key={l.quote}><p className="font-display text-lg">“{l.quote}”</p><p className="text-xs text-muted-foreground">{l.participantId} · {LANG_LABEL[l.lang]}{l.translation ? ` · Translation: ${l.translation}` : ""}</p></div>
          ))}</div>
        </div>
        <Card title="Jobs to be done" items={a.jobs} />
        <Card title="Purchase triggers" items={a.triggers} />
        <Card title="Trust barriers" items={a.trustBarriers} />
        {a.saidVsDid?.length ? (
          <div className="rounded-2xl border bg-card p-5 lg:col-span-2">
            <Eyebrow>Said vs did</Eyebrow>
            {a.saidVsDid.map((s) => <div key={s.said} className="mt-3 grid gap-3 sm:grid-cols-2"><p className="rounded-xl bg-secondary p-3 text-sm"><b>Said: </b>{s.said}</p><p className="rounded-xl bg-brand-soft/60 p-3 text-sm"><b>Did: </b>{s.did}</p></div>)}
          </div>
        ) : null}
        <div className="rounded-2xl bg-unknown-soft p-5 lg:col-span-3">
          <Eyebrow>Contradictions and gaps</Eyebrow>
          <p className="mt-2 font-semibold">Keep this profile provisional</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">{a.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, BookOpen, ShieldCheck, Lightbulb } from "lucide-react";
import { api } from "@/api";
import { useAudiences, usePersonaConversation } from "@/api/hooks";
import { PersonaChips } from "@/components/research/PersonaChips";
import { ClaimTag, ErrorState, Eyebrow, PageHeader } from "@/components/research/primitives";
import { useEvidenceDrawer } from "@/components/research/EvidenceDrawer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/persona-chat")({
  validateSearch: (s: Record<string, unknown>): { persona?: string } => typeof s['persona'] === "string" ? { persona: s['persona'] } : {},
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Persona chat — Research Hub" }, { name: "description", content: "Explore a research-derived perspective, without pretending it's a person." }, { property: "og:title", content: "Persona chat — Research Hub" }, { property: "og:description", content: "Research simulation of behavioural profiles." }] }),
  component: PersonaChat,
});

const SUGGESTED = ["What makes an offer feel genuine?", "How do you react to countdown timers?", "Would you prefer dark mode?"];
const INTRO = "Ask me what catches my attention or makes me hesitate. I’ll speak from the habits in this persona’s research, without making up personal experiences.";

function PersonaChat() {
  const { persona } = Route.useSearch();
  const audiences = useAudiences();
  const personas = audiences.data?.filter((a) => a.ref.kind === "persona") ?? [];
  const [chosen, setPid] = useState(persona ?? "deal-driven");
  // fall back to the first persona when the chosen one doesn't exist (e.g. after audiences were rebuilt)
  const pid = personas.some((p) => p.ref.id === chosen) ? chosen : (personas[0]?.ref.id ?? chosen);
  const current = personas.find((p) => p.ref.id === pid)?.ref;
  const q = usePersonaConversation(pid);
  const qc = useQueryClient();
  const drawer = useEvidenceDrawer();
  const [text, setText] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (t: string) => api.sendPersonaMessage(pid, t),
    onMutate: (t) => setPendingText(t),
    onSettled: () => { setPendingText(null); qc.invalidateQueries({ queryKey: ["persona-chat", pid] }); },
  });
  const go = (t: string) => { if (!t.trim() || send.isPending) return; send.mutate(t.trim()); setText(""); };
  if (audiences.isError) return <ErrorState onRetry={() => audiences.refetch()} />;
  if (!current) return <Skeleton className="h-64 w-full" />;

  return (
    <div>
      <PageHeader eyebrow="Persona conversation" title="Explore a perspective, without pretending it's a person." sub="Responses simulate a behavioural profile grounded in research. Inspect evidence when available." />
      <div className="mb-6"><PersonaChips selected={[pid]} onSelect={(p) => { if (!send.isPending) setPid(p.id); }} /></div>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div>
          <Eyebrow className="mb-3">Choose one persona</Eyebrow>
          <div className="space-y-2">
            {personas.map((p) => <div key={p.ref.id} className="border-b py-3"><p className="font-semibold">{p.ref.name}</p><p className="text-xs text-muted-foreground">{p.ref.participants} participants · {p.evidenceStrength}% strength</p></div>)}
          </div>
          <div className="mt-4 flex gap-3 rounded-2xl bg-unknown-soft p-4 text-sm"><ShieldCheck className="size-4 shrink-0 text-unknown" /><div><p className="font-semibold">Simulation boundary</p><p className="text-muted-foreground">No invented memories or preferences beyond research.</p></div></div>
        </div>
        <div className="flex min-h-[560px] flex-col rounded-3xl border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-full bg-persona-soft font-display font-semibold text-persona">{current.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}</span><div><p className="font-semibold">{current.name}</p><p className="text-xs text-muted-foreground">Research-derived composite · Evidence mode</p></div></div>
            <span className="rounded-full bg-persona-soft px-3 py-1 text-xs font-semibold text-persona">Research simulation</span>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            <Bubble from="persona" text={INTRO} />
            {q.isLoading && <Skeleton className="h-16 w-2/3 rounded-2xl" />}
            {q.isError && <ErrorState onRetry={() => q.refetch()} />}
            {q.data?.map((m) => (
              <Bubble key={m.id} from={m.from} text={m.text} label={m.label} study={m.suggestedStudy} onEvidence={m.evidenceIds?.length ? () => drawer.open(m.evidenceIds ?? []) : undefined} />
            ))}
            {pendingText && (<><Bubble from="user" text={pendingText} /><div className="flex gap-1 px-2" aria-label="Persona is responding">{[0, 1, 2].map((i) => <span key={i} className="size-2 animate-pulse rounded-full bg-persona/50" style={{ animationDelay: `${i * 150}ms` }} />)}</div></>)}
          </div>
          <div className="border-t p-4">
            <div className="mb-3 flex flex-wrap gap-2">{SUGGESTED.map((s) => <button key={s} onClick={() => go(s)} className="rounded-full border px-3 py-1.5 text-sm hover:border-foreground/40">{s}</button>)}</div>
            <div className="flex items-end gap-2 rounded-2xl border bg-background p-2 pl-4">
              <label htmlFor="pmsg" className="sr-only">Message</label>
              <textarea id="pmsg" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(text); } }} placeholder={`Ask ${current.name}…`} className="min-h-10 flex-1 resize-none bg-transparent py-2 outline-none" />
              <Button size="icon" className="rounded-xl" disabled={!text.trim() || send.isPending} onClick={() => go(text)} aria-label="Send"><ArrowUp className="size-4" /></Button>
            </div>
            {send.isError && <p role="alert" className="mt-2 text-sm text-risk">{(send.error as Error).message}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ from, text, label, study, onEvidence }: { from: "user" | "persona"; text: string; label?: "evidence" | "inference" | "no_evidence" | undefined; study?: string | undefined; onEvidence?: (() => void) | undefined }) {
  if (from === "user") return <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground">{text}</div>;
  return (
    <div className="max-w-[85%]">
      <div className="rounded-2xl rounded-bl-md border border-persona/15 bg-persona-soft/40 px-4 py-3">
        {label && <div className="mb-1.5"><ClaimTag label={label} /></div>}
        <p className="leading-relaxed">{text}</p>
        {study && <p className="mt-3 flex gap-2 rounded-xl bg-card p-3 text-sm"><Lightbulb className="size-4 shrink-0 text-mixed" /><span><span className="font-semibold">Suggested study: </span>{study}</span></p>}
      </div>
      {onEvidence && <button onClick={onEvidence} className="mt-1.5 inline-flex items-center gap-1.5 px-1 text-xs font-medium text-persona hover:underline"><BookOpen className="size-3.5" />Evidence behind this response</button>}
    </div>
  );
}

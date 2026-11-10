import { useState, type ReactNode } from "react";
import { ArrowRight, ArrowUp, HelpCircle, Paperclip, ShieldAlert, Check, RefreshCw, Eye } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Answer, EvidenceItem, Implication, Pattern, Role } from "@/types/research";
import { ROLE_LENS } from "@/lib/roleLens";
import { cn } from "@/lib/utils";
import { CitationChip, ClaimTag, Eyebrow, SignalPill, signalDot } from "./primitives";
import { useEvidenceDrawer } from "./EvidenceDrawer";
import { Button } from "@/components/ui/button";

export function Section({ eyebrow, title, right, children }: { eyebrow: string; title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-14">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2 border-b pb-4">
        <div>
          <Eyebrow className="text-brand">{eyebrow}</Eyebrow>
          {title && <h2 className="mt-2 text-2xl font-semibold md:text-[1.75rem]">{title}</h2>}
        </div>
        {right && <p className="text-sm text-muted-foreground">{right}</p>}
      </div>
      {children}
    </section>
  );
}

const VARIANT_BADGE: Record<Answer["variant"], string> = {
  standard: "Evidence-backed answer",
  study_plan: "Study plan · Based on current evidence gaps",
  insufficient: "Insufficient evidence",
  script_review: "Script review",
  comparison: "Audience comparison",
};

export function AnswerHero({ answer }: { answer: Answer }) {
  const forWho = answer.audience.map((a) => a.name).join(" + ");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", answer.variant === "insufficient" ? "bg-unknown-soft text-unknown" : answer.variant === "study_plan" ? "bg-persona-soft text-persona" : "bg-brand text-brand-foreground")}>
          {VARIANT_BADGE[answer.variant]}
        </span>
        {forWho && <span className="text-sm text-muted-foreground">For {forWho}</span>}
      </div>
      <h2 className="text-3xl font-semibold leading-tight md:text-4xl">{answer.headline}</h2>
      <p className="mt-3 max-w-3xl text-lg leading-relaxed text-muted-foreground">{answer.summary}</p>
    </div>
  );
}

export function SignalPattern({ pattern, evidence }: { pattern: Pattern; evidence: Map<string, EvidenceItem> }) {
  const drawer = useEvidenceDrawer();
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 border-b py-6 last:border-0">
      <span className={cn("mt-2.5 size-2.5 rounded-full", signalDot(pattern.signal))} aria-hidden />
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">{pattern.title}</h3>
          <div className="flex items-center gap-2"><ClaimTag label={pattern.label} /><SignalPill signal={pattern.signal} /></div>
        </div>
        <p className="mt-1 text-muted-foreground">{pattern.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {pattern.evidenceIds.map((id) => {
            const e = evidence.get(id);
            return e ? <CitationChip key={id} item={e} onClick={() => drawer.open(pattern.evidenceIds, e.stance)} /> : null;
          })}
        </div>
      </div>
    </div>
  );
}

export function ConflictCard({ title, body, evidenceIds }: { title: string; body: string; evidenceIds: string[] }) {
  const drawer = useEvidenceDrawer();
  return (
    <div className="rounded-2xl border border-mixed/30 bg-mixed-soft/60 p-6">
      <div className="flex items-center gap-2 text-mixed"><ShieldAlert className="size-4" /><span className="text-xs font-semibold uppercase tracking-wider">Conflicting evidence</span></div>
      <h3 className="mt-3 text-xl font-semibold">{title}</h3>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-muted-foreground">{body}</p>
        <button type="button" onClick={() => drawer.open(evidenceIds, "contradicts")} className="inline-flex items-center gap-1 text-sm font-semibold text-foreground hover:underline">
          Inspect source <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function UnknownCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-4 rounded-2xl bg-unknown-soft p-6">
      <HelpCircle className="mt-0.5 size-5 shrink-0 text-unknown" />
      <div>
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{title}</h3><ClaimTag label="no_evidence" /></div>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function DesignImplications({ implication, role }: { implication: Implication; role: Role }) {
  const lens = ROLE_LENS[role];
  const cards = [
    { k: "Keep", v: implication.keep, icon: Check, cls: "text-strong" },
    { k: "Change", v: implication.change, icon: RefreshCw, cls: "text-mixed" },
    { k: "Watch", v: implication.watch, icon: Eye, cls: "text-risk" },
  ];
  return (
    <Section eyebrow={lens.eyebrow} title={lens.title}>
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((c) => (
          <div key={c.k} className="rounded-2xl border bg-card p-5">
            <div className={cn("flex items-center gap-2 text-xs font-semibold uppercase tracking-wider", c.cls)}><c.icon className="size-4" />{c.k}</div>
            <p className="mt-3 leading-snug">{c.v}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Framing reflects your role. The evidence is identical for every role.</p>
    </Section>
  );
}

export function NextActions({ actions }: { actions: { label: string; onClick?: () => void; to?: string; primary?: boolean }[] }) {
  return (
    <div className="mt-10 flex flex-wrap gap-3">
      {actions.map((a) =>
        a.to ? (
          <Button key={a.label} asChild variant={a.primary ? "default" : "outline"} className="rounded-full px-5">
            <Link to={a.to}>{a.label}</Link>
          </Button>
        ) : (
          <Button key={a.label} variant={a.primary ? "default" : "outline"} className="rounded-full px-5" onClick={a.onClick}>{a.label}</Button>
        ),
      )}
    </div>
  );
}

export function FollowUpComposer({ onSend, pending, inputId = "follow-up" }: { onSend: (t: string) => void; pending?: boolean; inputId?: string }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim() || pending) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="sticky bottom-0 z-10 -mx-2 mt-10 bg-gradient-to-t from-background via-background to-transparent px-2 pb-5 pt-8">
      <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 pl-4 shadow-[0_8px_30px_-12px_color-mix(in_oklab,var(--foreground)_25%,transparent)]">
        <button type="button" aria-label="Attach material" className="mb-2 rounded-md p-1 text-muted-foreground hover:text-foreground"><Paperclip className="size-4" /></button>
        <label htmlFor={inputId} className="sr-only">Ask a follow-up</label>
        <textarea
          id={inputId}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask a follow-up…"
          className="max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2 text-base outline-none placeholder:text-muted-foreground"
        />
        <Button size="icon" className="rounded-xl" onClick={send} disabled={!text.trim() || pending} aria-label="Send follow-up"><ArrowUp className="size-4" /></Button>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">Follow-ups keep this question, audience, and evidence in context.</p>
    </div>
  );
}

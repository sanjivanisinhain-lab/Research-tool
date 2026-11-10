import { useMemo } from "react";
import { Copy, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { Answer, EvidenceItem, Role } from "@/types/research";
import { useEvidence } from "@/api/hooks";
import { shouldWithhold } from "@/config/confidence";
import { cn } from "@/lib/utils";
import { AnswerHero, ConflictCard, DesignImplications, NextActions, Section, SignalPattern, UnknownCard } from "./AnswerParts";
import { ConfidenceRing, EvidenceDirectionBar, MetricsCard } from "./Metrics";
import { ClaimTag, SignalPill, Eyebrow, CitationChip } from "./primitives";
import { useEvidenceDrawer } from "./EvidenceDrawer";
import { Button } from "@/components/ui/button";

export function allEvidenceIds(a: Answer) {
  return [
    ...a.patterns.flatMap((p) => p.evidenceIds),
    ...(a.conflict?.evidenceIds ?? []),
    ...(a.scriptReview?.overlap.evidenceIds ?? []),
    ...(a.followUps ?? []).flatMap((f) => f.evidenceIds),
  ];
}

export function AnswerView({ answer, role, onFollowUp, onCompare, onPlanTest }: { answer: Answer; role: Role; onFollowUp: () => void; onCompare: () => void; onPlanTest: () => void }) {
  const ids = useMemo(() => allEvidenceIds(answer), [answer]);
  const ev = useEvidence(ids);
  const map = useMemo(() => new Map<string, EvidenceItem>((ev.data ?? []).map((e) => [e.id, e])), [ev.data]);
  const participants = answer.confidence.participants;

  return (
    <div>
      <AnswerHero answer={answer} />

      {answer.variant === "standard" && (
        <>
          <div className="mt-8"><MetricsCard direction={answer.direction} confidence={answer.confidence} /></div>
          <Section eyebrow="What the evidence says" title={`${["No", "One", "Two", "Three", "Four", "Five"][answer.patterns.length] ?? answer.patterns.length} patterns explain the finding`} right={`${answer.sources} sources · ${participants} participants`}>
            <div>{answer.patterns.map((p) => <SignalPattern key={p.id} pattern={p} evidence={map} />)}</div>
            <SaidDid answer={answer} map={map} />
          </Section>
          <div className="mt-10 space-y-4">
            {answer.conflict && <ConflictCard {...answer.conflict} />}
            {answer.unknowns.map((u) => <UnknownCard key={u.title} {...u} />)}
          </div>
        </>
      )}

      {answer.variant === "study_plan" && answer.studyPlan && <StudyPlanBody answer={answer} />}
      {answer.variant === "insufficient" && <InsufficientBody answer={answer} onPlanTest={onPlanTest} />}
      {answer.variant === "script_review" && answer.scriptReview && <ScriptReviewBody answer={answer} map={map} />}
      {answer.variant === "comparison" && answer.comparison && <ComparisonBody answer={answer} />}

      {answer.variant !== "insufficient" && <DesignImplications implication={answer.implications[role]} role={role} />}

      <NextActions
        actions={
          answer.variant === "insufficient"
            ? [{ label: "Build test plan", primary: true, onClick: onPlanTest }, { label: "Ask follow-up", onClick: onFollowUp }]
            : answer.variant === "comparison"
              ? [{ label: "Ask follow-up", primary: true, onClick: onFollowUp }, { label: "Plan usability test", onClick: onPlanTest }]
              : [{ label: "Ask follow-up", primary: true, onClick: onFollowUp }, { label: "Compare audience", onClick: onCompare }, { label: "Plan usability test", onClick: onPlanTest }]
        }
      />
    </div>
  );
}

function SaidDid({ answer, map }: { answer: Answer; map: Map<string, EvidenceItem> }) {
  const items = answer.patterns.flatMap((p) => p.evidenceIds).map((id) => map.get(id)).filter(Boolean) as EvidenceItem[];
  if (!items.length) return null;
  const said = new Set(items.filter((i) => i.kind === "said").map((i) => i.participantId)).size;
  const did = new Set(items.filter((i) => i.kind === "did").map((i) => i.participantId)).size;
  return (
    <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border text-sm">
      <div className="bg-card p-4"><p className="eyebrow">What people said</p><p className="mt-1"><span className="font-display text-2xl font-semibold tabular-nums">{said}</span> participants in cited evidence</p></div>
      <div className="bg-card p-4"><p className="eyebrow">What people did</p><p className="mt-1"><span className="font-display text-2xl font-semibold tabular-nums">{did}</span> participants observed</p></div>
    </div>
  );
}

function StudyPlanBody({ answer }: { answer: Answer }) {
  const p = answer.studyPlan!;
  const text = `Objective: ${p.objective}\nAudience: ${p.audience}\nTask: ${p.task}\nWatch for: ${p.watchFor}\n\nQuestions:\n${p.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
  return (
    <>
      <div className="mt-8 rounded-2xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <div><Eyebrow>Suggested next step</Eyebrow><p className="mt-1 font-display text-xl font-semibold">A focused moderated study</p></div>
          <Button variant="outline" className="rounded-full" onClick={() => { navigator.clipboard?.writeText(text); toast.success("Plan copied"); }}><Copy className="size-4" /> Copy plan</Button>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          {([["Objective", p.objective], ["Audience", p.audience], ["Task", p.task], ["Watch for", p.watchFor]] as const).map(([k, v]) => (
            <div key={k} className="bg-card p-5"><p className="eyebrow">{k}</p><p className="mt-2 leading-snug">{v}</p></div>
          ))}
        </div>
      </div>
      <Section eyebrow="Questions to ask">
        <ol className="space-y-2">
          {p.questions.map((q, i) => (
            <li key={q} className="flex gap-4 rounded-xl border bg-card p-4"><span className="font-display font-semibold tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>{q}</li>
          ))}
        </ol>
      </Section>
      <div className="mt-8 space-y-4">{answer.unknowns.map((u) => <UnknownCard key={u.title} {...u} />)}</div>
    </>
  );
}

function InsufficientBody({ answer, onPlanTest }: { answer: Answer; onPlanTest: () => void }) {
  return (
    <>
      <div className="mt-8 grid gap-6 rounded-2xl border bg-card p-6 md:grid-cols-[auto_1fr] md:items-center">
        <ConfidenceRing confidence={answer.confidence} />
        <p className="text-muted-foreground md:border-l md:pl-6">No reaction percentage is shown. The research doesn't contain enough relevant evidence to make a prediction. This is an honest gap, not an error.</p>
      </div>
      <Section eyebrow="What we do know">
        {answer.known?.map((k) => (
          <div key={k.title} className="rounded-2xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{k.title}</h3><span className="rounded-full bg-mixed-soft px-2 py-0.5 text-xs font-semibold text-mixed">Some evidence</span></div>
            <p className="mt-1 text-sm text-muted-foreground">{k.body}</p>
          </div>
        ))}
      </Section>
      <Section eyebrow="What we don't know">
        <div className="space-y-3">{answer.unknowns.map((u) => <UnknownCard key={u.title} {...u} />)}</div>
      </Section>
      <div className="mt-10 rounded-2xl bg-foreground p-6 text-background">
        <Eyebrow className="text-background/60">Recommendation</Eyebrow>
        <p className="mt-2 font-display text-2xl font-semibold">Don't make a decision from this prediction.</p>
        <p className="mt-1 text-background/70">Run a small study first. We can draft one from the gaps above.</p>
        <Button variant="secondary" className="mt-4 rounded-full" onClick={onPlanTest}>Build test plan</Button>
      </div>
    </>
  );
}

const STATUS = {
  good: { icon: CheckCircle2, cls: "text-strong", text: "Good" },
  improve: { icon: AlertTriangle, cls: "text-mixed", text: "Could improve" },
  leading: { icon: XCircle, cls: "text-risk", text: "Potentially leading" },
};

function ScriptReviewBody({ answer, map }: { answer: Answer; map: Map<string, EvidenceItem> }) {
  const r = answer.scriptReview!;
  const drawer = useEvidenceDrawer();
  return (
    <>
      <div className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border bg-border">
        {([["good", r.counts.good], ["improve", r.counts.improve], ["leading", r.counts.leading]] as const).map(([k, n]) => {
          const S = STATUS[k];
          return (
            <div key={k} className="bg-card p-5">
              <S.icon className={cn("size-5", S.cls)} />
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums">{n}</p>
              <p className="text-sm text-muted-foreground">{S.text}</p>
            </div>
          );
        })}
      </div>
      <Section eyebrow="Question by question" title="Where the script could bias answers">
        <div className="space-y-3">
          {r.questions.map((q) => {
            const S = STATUS[q.status];
            return (
              <div key={q.id} className="rounded-2xl border bg-card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <S.icon className={cn("size-4", S.cls)} /><span className={cn("text-xs font-semibold", S.cls)}>{S.text}</span>
                  {q.issue && <span className="rounded-full border px-2 py-0.5 text-xs font-medium">{q.issue}</span>}
                </div>
                <p className="mt-2 font-display text-lg">“{q.original}”</p>
                {q.note && <p className="mt-1 text-sm text-muted-foreground">{q.note}</p>}
                {q.rewrite && (
                  <div className="mt-3 rounded-xl bg-strong-soft/60 p-3 text-sm"><span className="eyebrow mr-2 text-strong">Suggested rewrite</span>{q.rewrite}</div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      <div className="mt-8 rounded-2xl border bg-card p-6">
        <div className="flex items-center gap-2"><Eyebrow>Existing evidence overlap</Eyebrow><ClaimTag label="evidence" /></div>
        <h3 className="mt-2 text-lg font-semibold">{r.overlap.title}</h3>
        <p className="mt-1 text-muted-foreground">{r.overlap.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {r.overlap.evidenceIds.map((id) => map.get(id) && <CitationChip key={id} item={map.get(id)!} onClick={() => drawer.open(r.overlap.evidenceIds)} />)}
        </div>
      </div>
    </>
  );
}

function ComparisonBody({ answer }: { answer: Answer }) {
  const c = answer.comparison!;
  const inconclusive = c.columns.some((col) => shouldWithhold(col.confidence.score));
  return (
    <>
      {inconclusive && (
        <div className="mt-8 rounded-2xl border border-mixed/30 bg-mixed-soft/60 p-5">
          <p className="font-display text-xl font-semibold">Comparison inconclusive</p>
          <p className="mt-1 text-sm text-muted-foreground">At least one audience has too little evidence. We won't rank these audiences until confidence improves.</p>
        </div>
      )}
      <div className={cn("mt-8 grid gap-4", c.columns.length === 3 ? "lg:grid-cols-3" : "md:grid-cols-2")}>
        {c.columns.map((col) => {
          const withhold = shouldWithhold(col.confidence.score);
          return (
            <div key={col.audience.id} className="rounded-2xl border bg-card p-5">
              <span className={cn("inline-flex rounded-full px-3 py-1 text-sm font-medium", col.audience.kind === "segment" ? "bg-segment-soft text-segment" : "bg-persona-soft text-persona")}>{col.audience.name}</span>
              <div className="mt-5 border-b pb-5">
                {!withhold && col.direction ? <EvidenceDirectionBar direction={col.direction} /> : <div><p className="eyebrow">Evidence direction</p><p className="mt-2 font-display text-xl font-semibold">Prediction withheld</p></div>}
              </div>
              <div className="border-b py-5"><ConfidenceRing confidence={col.confidence} size={64} /></div>
              <ul className="space-y-3 pt-5">
                {col.dimensions.map((d) => (
                  <li key={d.name}>
                    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{d.name}</span><SignalPill signal={d.signal} /></div>
                    <p className="text-xs text-muted-foreground">{d.summary}</p>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {!inconclusive && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl bg-foreground p-6 text-background"><Eyebrow className="text-background/60">Biggest difference</Eyebrow><p className="mt-2 text-lg leading-snug">{c.biggestDifference}</p></div>
          <div className="rounded-2xl border bg-card p-6"><Eyebrow>Design implication</Eyebrow><p className="mt-2 text-lg leading-snug">{c.designImplication}</p></div>
        </div>
      )}
      <div className="mt-6 space-y-3">{answer.unknowns.map((u) => <UnknownCard key={u.title} {...u} />)}</div>
    </>
  );
}

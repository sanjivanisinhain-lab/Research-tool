import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { useAnswer, useProfile } from "@/api/hooks";
import { AnswerView } from "@/components/research/AnswerView";
import { FollowUpComposer, FollowUpThread } from "@/components/research/AnswerParts";
import { AudiencePickerDialog } from "@/components/research/AudiencePickerDialog";
import { ClaimTag, EmptyState, ErrorState, Eyebrow, LoadingBlock, relativeTime } from "@/components/research/primitives";
import { Button } from "@/components/ui/button";
import { PersonaChips } from "@/components/research/PersonaChips";
import { roleLabel } from "@/lib/roleLens";

export const Route = createFileRoute("/ask/$id")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Answer — Research Hub" }, { name: "description", content: "An evidence-backed answer with confidence and sources." }, { property: "og:title", content: "Answer — Research Hub" }, { property: "og:description", content: "Evidence-backed answer." }] }),
  component: AnswerPage,
});

function AnswerPage() {
  const { id } = Route.useParams();
  const q = useAnswer(id);
  const profile = useProfile();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [picker, setPicker] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const follow = useMutation({
    mutationFn: (t: string) => api.followUp(id, t),
    onMutate: (t) => setPendingText(t), // show your message at once, with a typing indicator, until the reply arrives
    onSettled: async () => { await qc.invalidateQueries({ queryKey: ["answer", id] }); setPendingText(null); },
  });
  const reask = useMutation({ mutationFn: (v: Parameters<typeof api.ask>[0]) => api.ask(v), onSuccess: (r) => navigate({ to: "/ask/$id", params: { id: r.id } }) });

  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const a = q.data;
  if (!a) return <EmptyState title="This answer isn't available" body="Answers created in this session aren't kept after a reload in the demo." action={<Button asChild className="rounded-full"><Link to="/">Ask a new question</Link></Button>} />;

  const focus = () => document.getElementById("follow-up")?.focus();
  return (
    <div className="pb-4">
      <div className="flex items-start justify-between gap-4">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />New question</Link>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand">Framed for {roleLabel(profile.data?.role)}</span>
          <Button variant="outline" className="rounded-full" onClick={() => setPicker(true)}>Change audience</Button>
        </div>
      </div>
      <h1 className="mt-6 text-3xl font-semibold md:text-[2.5rem] md:leading-tight">{a.question}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{a.audience.map((x) => x.name).join(" · ")} · saved {relativeTime(a.savedAt)}</p>
      {a.autoAudience && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/30 bg-brand-soft/50 px-4 py-2.5 text-sm">
          <span><strong>Audience chosen for you:</strong> {a.audience.length ? a.audience.map((x) => x.name).join(" + ") : "all users (the question didn't point to one group)"}</span>
          {a.audience.length > 0 && <Button variant="link" className="h-auto p-0" disabled={reask.isPending} onClick={() => reask.mutate({ question: a.question, audience: [], mode: "combine", attachments: a.attachments ?? [] })}>Use all users instead</Button>}
          <Button variant="link" className="h-auto p-0" onClick={() => setPicker(true)}>Choose another</Button>
        </p>
      )}
      <div className="mt-4"><PersonaChips selected={a.audience.map((x) => x.id)} onSelect={(p) => reask.mutate({ question: a.question, audience: [p], mode: "combine", attachments: a.attachments ?? [] })} /></div>
      <div className="mt-6 rounded-2xl border bg-card/60 p-5">
        <Eyebrow>You asked</Eyebrow><p className="mt-1.5">{a.question}</p>
        {a.attachments?.length ? <p className="mt-2 text-xs text-muted-foreground">Your material: {a.attachments.map((x) => x.name).join(", ")}</p> : null}
      </div>
      <div className="mt-10"><AnswerView answer={a} role={profile.data?.role ?? "designer"} onFollowUp={focus} onCompare={() => setPicker(true)} onPlanTest={() => reask.mutate({ question: "How should I test this?", audience: a.audience, mode: "combine", attachments: [], contextAnswerId: a.id })}
          {...(a.variant === "study_plan" && a.studyPlan ? { onReviewQuestions: () => reask.mutate({ question: "Check these questions for bias", audience: a.audience, mode: "combine", attachments: [{ name: "Study plan questions", kind: "transcript", text: a.studyPlan!.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") }] }) } : {})} /></div>
      <FollowUpThread followUps={a.followUps ?? []} pendingText={pendingText} error={follow.isError ? (follow.error as Error).message : null} />
      <FollowUpComposer onSend={(t) => follow.mutate(t)} pending={follow.isPending} />
      <AudiencePickerDialog open={picker} onOpenChange={setPicker} value={a.audience} mode="combine" onApply={(v, m) => reask.mutate({ question: a.question, audience: v, mode: m, attachments: a.attachments ?? [] })} />
    </div>
  );
}

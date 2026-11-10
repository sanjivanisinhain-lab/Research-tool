import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api";
import { AudienceChips, PageHeader } from "@/components/research/primitives";
import { AudiencePickerDialog } from "@/components/research/AudiencePickerDialog";
import { ProductCard } from "@/components/research/ProductCard";
import { useAudiences } from "@/api/hooks";
import type { AudienceRef } from "@/types/research";
import { PersonaChips } from "@/components/research/PersonaChips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/assess/")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Assess prototype — Research Hub" }, { name: "description", content: "Spot likely friction before a usability test." }, { property: "og:title", content: "Assess prototype — Research Hub" }, { property: "og:description", content: "Predict risks from existing research." }] }),
  component: AssessPage,
});

function AssessPage() {
  const [kind, setKind] = useState<"local" | "figma">("local");
  const [url, setUrl] = useState("");
  const [task, setTask] = useState("Find a product under ₹1,000 and continue to checkout");
  const [goal, setGoal] = useState("Understand whether the offer feels credible before checkout");
  const [audience, setAudience] = useState<AudienceRef[]>([]);
  const audiences = useAudiences();
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !audiences.data) return;
    const p = audiences.data.find((a) => a.ref.id === "deal-driven");
    if (p) setAudience([p.ref]);
    initialized.current = true;
  }, [audiences.data]);
  const [picker, setPicker] = useState(false);
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: () => api.createAssessment({ prototype: kind === "local" ? { kind: "local_sample" } : { kind: "figma_link", url }, task, ...(goal ? { goal } : {}), audience }),
    onSuccess: (r) => navigate({ to: "/assess/$id", params: { id: r.id } }),
  });
  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <section className="rounded-2xl border bg-card p-6"><p className="eyebrow">Step {n}</p><h2 className="mt-1 text-xl font-semibold">{title}</h2><div className="mt-4">{children}</div></section>
  );
  return (
    <div>
      <PageHeader eyebrow="Prototype assessment" title="Spot likely friction before a usability test." sub="Use existing research to predict risks. This does not claim that participants tested your prototype." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Step n={1} title="Choose a prototype">
            <div className="inline-flex rounded-full bg-secondary p-1">
              {(["local", "figma"] as const).map((k) => <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} className={cn("rounded-full px-4 py-1.5 text-sm font-medium", kind === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{k === "local" ? "Local sample" : "Figma link"}</button>)}
            </div>
            {kind === "figma" && <div className="mt-4 space-y-1.5"><Input placeholder="https://figma.com/file/…" value={url} onChange={(e) => setUrl(e.target.value)} /><p className="text-xs text-muted-foreground">Stored as a reference only. The file isn't fetched.</p></div>}
          </Step>
          <Step n={2} title="Define the assessment">
            <div className="space-y-4">
              <div className="space-y-1.5"><Label htmlFor="task">Task or flow</Label><Input id="task" value={task} onChange={(e) => setTask(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="goal">Learning goal <span className="text-muted-foreground">(optional)</span></Label><Input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} /></div>
            </div>
          </Step>
          <Step n={3} title="Choose the audience"><AudienceChips audience={audience} onRemove={(id) => setAudience((a) => a.filter((x) => x.id !== id))} onAdd={() => setPicker(true)} /><div className="mt-3"><PersonaChips selected={audience.map((a) => a.id)} onSelect={(p) => setAudience((a) => a.some((x) => x.id === p.id) ? a.filter((x) => x.id !== p.id) : [...a, p])} /></div></Step>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-sm text-muted-foreground">Predictions are labelled and linked to evidence.</p>
            <Button className="rounded-full px-6" disabled={!task.trim() || !audience.length || (kind === "figma" && !url.trim()) || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Assessing…" : "Begin assessment"}</Button>
          </div>
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-3xl bg-secondary p-8">{kind === "local" ? <ProductCard /> : <p className="py-20 text-center text-sm text-muted-foreground">Figma preview isn't available. Your link is kept with the assessment.</p>}</div>
        </div>
      </div>
      <AudiencePickerDialog open={picker} onOpenChange={setPicker} value={audience} mode="combine" onApply={(v) => setAudience(v)} />
    </div>
  );
}

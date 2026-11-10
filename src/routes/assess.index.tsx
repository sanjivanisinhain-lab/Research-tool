import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type AssessmentInput } from "@/api";
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
import { IS_MOCK } from "@/config/dataMode";

export const Route = createFileRoute("/assess/")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Assess prototype — Research Hub" }, { name: "description", content: "Spot likely friction before a usability test." }, { property: "og:title", content: "Assess prototype — Research Hub" }, { property: "og:description", content: "Predict risks from existing research." }] }),
  component: AssessPage,
});

function AssessPage() {
  const [kind, setKind] = useState<"local" | "upload" | "figma">(IS_MOCK ? "local" : "upload");
  const [file, setFile] = useState<File | null>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const [url, setUrl] = useState("");
  const [task, setTask] = useState("Find a product under ₹1,000 and continue to checkout");
  const [goal, setGoal] = useState("Understand whether the offer feels credible before checkout");
  const [audience, setAudience] = useState<AudienceRef[]>([]);
  const audiences = useAudiences();
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !audiences.data) return;
    const p = audiences.data.find((a) => a.ref.id === "deal-driven") ?? audiences.data.find((a) => a.ref.kind === "persona");
    if (p) setAudience([p.ref]);
    initialized.current = true;
  }, [audiences.data]);
  const [picker, setPicker] = useState(false);
  const navigate = useNavigate();
  const m = useMutation({
    mutationFn: async () => {
      let prototype: AssessmentInput["prototype"];
      if (kind === "local") prototype = { kind: "local_sample" };
      else if (kind === "figma") prototype = { kind: "figma_link", url };
      else {
        const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(file!); });
        prototype = { kind: "upload", name: file!.name, mimeType: file!.type, data };
      }
      return api.createAssessment({ prototype, task, ...(goal ? { goal } : {}), audience });
    },
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
              {((IS_MOCK ? ["local", "figma"] : ["upload", "figma"]) as ("local" | "upload" | "figma")[]).map((k) => <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} className={cn("rounded-full px-4 py-1.5 text-sm font-medium", kind === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{k === "local" ? "Local sample" : k === "upload" ? "Upload image" : "Figma link"}</button>)}
            </div>
            {kind === "upload" && (
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="design">Design image</Label>
                <Input id="design" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <p className="text-xs text-muted-foreground">A PNG, JPG or WebP of the screen, card or flow step (up to 10 MB). Export a frame from Figma if that's where it lives.</p>
              </div>
            )}
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
            <p className="text-sm text-muted-foreground">{m.isError ? <span className="text-risk">{(m.error as Error).message}</span> : "Predictions are labelled and linked to evidence."}</p>
            <Button className="rounded-full px-6" disabled={!task.trim() || !audience.length || (kind === "upload" && !file) || (kind === "figma" && !url.trim()) || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Assessing…" : "Begin assessment"}</Button>
          </div>
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-3xl bg-secondary p-8">{kind === "local" ? <ProductCard /> : kind === "upload" ? (preview ? <img src={preview} alt="Your design" className="mx-auto max-h-[560px] rounded-xl border bg-card" /> : <p className="py-20 text-center text-sm text-muted-foreground">Choose an image to see it here.</p>) : <p className="py-20 text-center text-sm text-muted-foreground">Figma preview isn't available. Your link is kept with the assessment.</p>}</div>
        </div>
      </div>
      <AudiencePickerDialog open={picker} onOpenChange={setPicker} value={audience} mode="combine" onApply={(v) => setAudience(v)} />
    </div>
  );
}

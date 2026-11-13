import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
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

const MAX_SCREENS = 6;

export const Route = createFileRoute("/assess/")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Assess prototype — Research Hub" }, { name: "description", content: "Spot likely friction before a usability test." }, { property: "og:title", content: "Assess prototype — Research Hub" }, { property: "og:description", content: "Predict risks from existing research." }] }),
  component: AssessPage,
});

function AssessPage() {
  const [kind, setKind] = useState<"local" | "figma">("local"); // demo mode only; the real tool takes images and/or a Figma link together
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const [url, setUrl] = useState("");
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) if (!next.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) next.push(f);
    if (next.length > MAX_SCREENS) { setFileError(`Up to ${MAX_SCREENS} screens at a time.`); return; }
    if (next.some((f) => f.size > 10 * 1024 * 1024)) { setFileError("Each image must be under 10 MB."); return; }
    if (next.reduce((n, f) => n + f.size, 0) > 18 * 1024 * 1024) { setFileError("The images together must be under 18 MB."); return; }
    setFileError(null); setFiles(next);
  };
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
      if (IS_MOCK) return api.createAssessment({ prototype: kind === "figma" ? { kind: "figma_link", url } : { kind: "local_sample" }, task, ...(goal ? { goal } : {}), audience });
      const screens = await Promise.all(files.map(async (f) => ({ name: f.name, mimeType: f.type, data: await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(f); }) })));
      const link = url.trim();
      const prototype: AssessmentInput["prototype"] = files.length ? { kind: "upload", name: files[0]!.name, mimeType: files[0]!.type } : { kind: "figma_link", url: link };
      return api.createAssessment({ prototype, ...(screens.length ? { screens } : {}), ...(link ? { figmaUrl: link } : {}), task, ...(goal ? { goal } : {}), audience });
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
          <Step n={1} title={IS_MOCK ? "Choose a prototype" : "Add your prototype"}>
            {IS_MOCK ? (<>
              <div className="inline-flex rounded-full bg-secondary p-1">
                {(["local", "figma"] as const).map((k) => <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} className={cn("rounded-full px-4 py-1.5 text-sm font-medium", kind === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{k === "local" ? "Local sample" : "Figma link"}</button>)}
              </div>
              {kind === "figma" && <div className="mt-4 space-y-1.5"><Input placeholder="https://figma.com/file/…" value={url} onChange={(e) => setUrl(e.target.value)} /><p className="text-xs text-muted-foreground">Stored as a reference only. The file isn't fetched.</p></div>}
            </>) : (
              <div className="space-y-6">
                <div className="space-y-1.5">
                  <Label htmlFor="design">Design images <span className="text-muted-foreground">(up to {MAX_SCREENS}, one per screen)</span></Label>
                  <Input id="design" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                  <p className="text-xs text-muted-foreground">PNG, JPG or WebP, each under 10 MB. Add the screens in the order a person would see them.</p>
                  {fileError && <p role="alert" className="text-xs text-risk">{fileError}</p>}
                  {files.length > 0 && (
                    <ol className="mt-2 flex flex-wrap gap-3">
                      {files.map((f, i) => (
                        <li key={`${f.name}-${f.size}-${i}`} className="relative w-28">
                          <img src={previews[i]} alt={`Screen ${i + 1}: ${f.name}`} className="h-24 w-28 rounded-lg border bg-card object-cover object-top" />
                          <p className="mt-1 truncate text-xs text-muted-foreground"><span className="tabular-nums">{i + 1}</span> · {f.name}</p>
                          <Button type="button" variant="secondary" size="icon" aria-label={`Remove ${f.name}`} className="absolute -right-2 -top-2 size-6 rounded-full" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}><X className="size-3" /></Button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="figma">Figma link <span className="text-muted-foreground">(optional, can be used with images)</span></Label>
                  <Input id="figma" inputMode="url" placeholder="https://www.figma.com/proto/… or /design/…?node-id=…" value={url} onChange={(e) => setUrl(e.target.value)} />
                  <p className="text-xs text-muted-foreground">We fetch the picture of the linked frame (a prototype link opens at its starting screen). For a specific frame, right-click it in Figma and choose Copy link to selection. A link to a whole file uses the first frames on its first page. Needs a Figma access token set on the server, and the file must be shared with that token's account.</p>
                </div>
              </div>
            )}
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
            <Button className="rounded-full px-6" disabled={!task.trim() || !audience.length || (IS_MOCK ? kind === "figma" && !url.trim() : !files.length && !url.trim()) || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Assessing…" : "Begin assessment"}</Button>
          </div>
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-3xl bg-secondary p-8">{IS_MOCK ? (kind === "local" ? <ProductCard /> : <p className="py-20 text-center text-sm text-muted-foreground">Figma preview isn't available. Your link is kept with the assessment.</p>) : files.length ? <div className={cn("grid gap-3", files.length > 1 && "grid-cols-2")}>{files.map((f, i) => <img key={`${f.name}-${i}`} src={previews[i]} alt={`Screen ${i + 1}`} className="w-full rounded-xl border bg-card" />)}</div> : <p className="py-20 text-center text-sm text-muted-foreground">{url.trim() ? "Your Figma frame is fetched when you begin the assessment." : "Add images or a Figma link to see them here."}</p>}</div>
        </div>
      </div>
      <AudiencePickerDialog open={picker} onOpenChange={setPicker} value={audience} mode="combine" onApply={(v) => setAudience(v)} />
    </div>
  );
}

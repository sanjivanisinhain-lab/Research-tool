import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useAudiences, useParticipantCount } from "@/api/hooks";
import type { AudienceRef } from "@/types/research";
import { cn } from "@/lib/utils";
import { ErrorState, Eyebrow } from "./primitives";
import { Skeleton } from "@/components/ui/skeleton";

export type AudienceMode = "combine" | "compare";

export function AudiencePickerDialog({
  open,
  onOpenChange,
  value,
  mode,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  value: AudienceRef[];
  mode: AudienceMode;
  onApply: (v: AudienceRef[], mode: AudienceMode) => void;
}) {
  const q = useAudiences();
  const [sel, setSel] = useState<AudienceRef[]>(value);
  const [m, setM] = useState<AudienceMode>(mode);
  const [search, setSearch] = useState("");
  useEffect(() => { if (open) { setSel(value); setM(mode); setSearch(""); } }, [open, value, mode]);
  const count = useParticipantCount(sel);
  const list = useMemo(
    () => (q.data ?? []).filter((a) => (a.ref.name + a.description).toLowerCase().includes(search.toLowerCase())),
    [q.data, search],
  );
  const toggle = (r: AudienceRef) => setSel((s) => (s.some((x) => x.id === r.id) ? s.filter((x) => x.id !== r.id) : [...s, r]));
  const summary = sel.length === 0 ? "No audience selected" : sel.length === 1 ? sel[0]?.name : m === "compare" ? `Comparing ${sel.length} audiences` : `${sel.length} audiences combined`;

  const group = (kind: "segment" | "persona", title: string, right: string) => {
    const items = list.filter((a) => a.ref.kind === kind);
    return (
      <div className="mt-6">
        <div className="mb-2 flex justify-between"><Eyebrow>{title}</Eyebrow><span className="text-xs text-muted-foreground">{right}</span></div>
        {items.length === 0 && <p className="py-3 text-sm text-muted-foreground">No matches.</p>}
        <ul className="space-y-1.5">
          {items.map((a) => {
            const checked = sel.some((x) => x.id === a.ref.id);
            return (
              <li key={a.ref.id}>
                <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition", checked ? "border-foreground/20 bg-card" : "border-transparent hover:bg-card/70")}>
                  <Checkbox checked={checked} onCheckedChange={() => toggle(a.ref)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium", kind === "segment" ? "border-segment/20 bg-segment-soft/50 text-segment" : "border-persona/20 bg-persona-soft/50 text-persona", checked && (kind === "segment" ? "border-segment/60 bg-segment-soft" : "border-persona/60 bg-persona-soft"))}>
                      <span className={cn("size-2 rounded-full", kind === "segment" ? "bg-segment" : "bg-persona")} aria-hidden />
                      {a.ref.name} <span className="border-l border-current/20 pl-2 font-normal tabular-nums">{a.ref.participants}</span>
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">{a.description}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden bg-background p-0 sm:max-w-xl">
        <div className="overflow-y-auto p-6">
          <Eyebrow className="text-brand">Audience</Eyebrow>
          <DialogTitle className="mt-2 font-display text-2xl">Who do you want to understand?</DialogTitle>
          <DialogDescription className="sr-only">Choose segments and personas to combine or compare.</DialogDescription>
          <div role="radiogroup" aria-label="Mode" className="mt-5 grid grid-cols-2 gap-1 rounded-full border bg-secondary p-1">
            {([["combine", "Combine", "One shared audience"], ["compare", "Compare", "Separate results"]] as const).map(([id, t, s]) => (
              <Button variant="ghost" key={id} role="radio" aria-checked={m === id} onClick={() => setM(id)} className={cn("flex h-auto flex-col gap-0 rounded-full px-3 py-2", m === id ? "bg-card shadow-sm" : "text-muted-foreground")}>
                <span className="block text-sm font-semibold">{t}</span><span className="block text-xs">{s}</span>
              </Button>
            ))}
          </div>
          <div className="relative mt-4">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search segments and personas" aria-label="Search segments and personas" className="h-11 w-full rounded-xl border bg-card pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          {q.isLoading && <div className="mt-6 space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>}
          {q.isError && <div className="mt-6"><ErrorState onRetry={() => q.refetch()} /></div>}
          {q.data && (<>{group("segment", "Participant segments", "Cohorts")}{group("persona", "Research-backed personas", "Behavioural profiles")}</>)}
          {m === "compare" && sel.length === 1 && <p className="mt-4 text-sm text-mixed">Pick at least two audiences to compare.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-6 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{summary}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{count.data ?? 0} matching participants, counted once</p>
          </div>
          <Button className="rounded-full px-5" disabled={sel.length === 0 || (m === "compare" && sel.length < 2)} onClick={() => { onApply(sel, m); onOpenChange(false); }}>
            Use this audience
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

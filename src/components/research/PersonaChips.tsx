import { useAudiences } from "@/api/hooks";
import type { AudienceRef } from "@/types/research";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PersonaChips({ selected, onSelect }: { selected: string[]; onSelect: (persona: AudienceRef) => void }) {
  const q = useAudiences();
  return <div className="flex flex-wrap gap-2" role="group" aria-label="Choose persona">
    {q.data?.filter((a) => a.ref.kind === "persona").map((a) => <Button key={a.ref.id} variant="outline" size="sm" aria-pressed={selected.includes(a.ref.id)} onClick={() => onSelect(a.ref)} className={cn("h-auto min-h-9 whitespace-normal rounded-full border-persona/20 bg-persona-soft/40 text-persona shadow-none", selected.includes(a.ref.id) && "border-persona/60 bg-persona-soft")}><span>{a.ref.name}</span><span className="border-l border-persona/20 pl-2 tabular-nums">{a.ref.participants}</span></Button>)}
  </div>;
}
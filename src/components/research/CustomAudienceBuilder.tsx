import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { filtersApi, type AudienceFilter } from "@/api/filters";
import { Button } from "@/components/ui/button";
import type { AudienceRef } from "@/types/research";
import { cn } from "@/lib/utils";

const LABEL: Record<string, string> = { cod: "Cash on delivery", prepaid: "Prepaid", male: "Men", female: "Women", new: "New customers", repeat: "Repeat customers", other: "Other" };
const field = "h-10 w-24 rounded-lg border bg-card px-3 text-sm outline-none focus:border-foreground/40";

function Chips({ label, options, picked, onToggle, hint }: { label: string; options: { value: string; n?: number }[]; picked: string[]; onToggle: (v: string) => void; hint?: string }) {
  return (
    <fieldset className="mt-5">
      <legend className="text-sm font-medium">{label}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => {
          const on = picked.includes(o.value);
          return <button key={o.value} type="button" aria-pressed={on} onClick={() => onToggle(o.value)} className={cn("rounded-full border px-3 py-1.5 text-sm transition", on ? "border-foreground bg-secondary font-medium" : "text-muted-foreground hover:border-foreground/40 hover:text-foreground")}>{LABEL[o.value] ?? o.value}{o.n !== undefined && <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{o.n}</span>}</button>;
        })}
      </div>
    </fieldset>
  );
}

/** Pick an audience by details such as age, city tier, state and how people pay. The count is live; unknown details are never guessed. */
export function CustomAudienceBuilder({ onUse }: { onUse: (ref: AudienceRef) => void }) {
  const qc = useQueryClient();
  const facets = useQuery({ queryKey: ["facets"], queryFn: filtersApi.facets, staleTime: 60_000 });
  const [ageMin, setAgeMin] = useState(""); const [ageMax, setAgeMax] = useState("");
  const [tiers, setTiers] = useState<string[]>([]); const [states, setStates] = useState<string[]>([]); const [payments, setPayments] = useState<string[]>([]);
  const [genders, setGenders] = useState<string[]>([]); const [customers, setCustomers] = useState<string[]>([]);
  const [stateSearch, setStateSearch] = useState(""); const [name, setName] = useState("");
  const toggle = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) => set((l) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]));
  const filter: AudienceFilter = useMemo(() => ({
    ...(ageMin ? { ageMin: Number(ageMin) } : {}), ...(ageMax ? { ageMax: Number(ageMax) } : {}),
    ...(tiers.length ? { tiers } : {}), ...(states.length ? { states } : {}), ...(payments.length ? { payments } : {}), ...(genders.length ? { genders } : {}), ...(customers.length ? { customers } : {}),
  }), [ageMin, ageMax, tiers, states, payments, genders, customers]);
  const key = JSON.stringify(filter);
  const [settled, setSettled] = useState(key);
  useEffect(() => { const t = setTimeout(() => setSettled(key), 300); return () => clearTimeout(t); }, [key]);
  const preview = useQuery({ queryKey: ["filter-preview", settled], queryFn: () => filtersApi.preview(JSON.parse(settled) as AudienceFilter), placeholderData: (p) => p });
  const save = useMutation({ mutationFn: () => filtersApi.save(filter, name), onSuccess: (ref) => { void qc.invalidateQueries({ queryKey: ["audiences"] }); onUse(ref); } });

  if (facets.isLoading) return <p className="py-6 text-sm text-muted-foreground">Loading…</p>;
  const f = facets.data;
  if (!f || f.known.tier + f.known.state + f.known.age + f.known.payment + f.known.gender + f.known.customer === 0)
    return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No personal details are on record yet. They come from your sheet's Age, Tier, State, Gender, Payment type and Customer type columns, from the City column, and from details the researchers wrote in the notes. Import the sheet and give it a few minutes.</p>;
  const states_ = f.states.filter((s) => s.value.toLowerCase().includes(stateSearch.toLowerCase()));
  const p = preview.data; const empty = Object.keys(filter).length === 0;

  return (
    <div>
      <p className="text-xs text-muted-foreground">Known for: age {f.known.age}, tier {f.known.tier}, state {f.known.state}, payment {f.known.payment}, gender {f.known.gender}, customer type {f.known.customer} of {f.total} people. People whose detail is not known are left out of a filter on that detail, never guessed in.</p>
      <fieldset className="mt-5">
        <legend className="text-sm font-medium">Age</legend>
        <div className="mt-2 flex items-center gap-2 text-sm"><label className="sr-only" htmlFor="age-from">Age from</label><input id="age-from" inputMode="numeric" className={field} placeholder={f.age ? String(f.age.min) : "from"} value={ageMin} onChange={(e) => setAgeMin(e.target.value.replace(/\D/g, "").slice(0, 2))} /> to <label className="sr-only" htmlFor="age-to">Age to</label><input id="age-to" inputMode="numeric" className={field} placeholder={f.age ? String(f.age.max) : "to"} value={ageMax} onChange={(e) => setAgeMax(e.target.value.replace(/\D/g, "").slice(0, 2))} /><span className="text-xs text-muted-foreground">years</span></div>
      </fieldset>
      <Chips label="City tier" options={f.tiers} picked={tiers} onToggle={toggle(setTiers)} />
      <fieldset className="mt-5">
        <legend className="text-sm font-medium">State</legend>
        {f.states.length > 8 && <><label className="sr-only" htmlFor="state-search">Search states</label><input id="state-search" className={cn(field, "mt-2 w-48")} placeholder="Search states" value={stateSearch} onChange={(e) => setStateSearch(e.target.value)} /></>}
        <div className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-auto">
          {states_.map((o) => { const on = states.includes(o.value); return <button key={o.value} type="button" aria-pressed={on} onClick={() => toggle(setStates)(o.value)} className={cn("rounded-full border px-3 py-1.5 text-sm transition", on ? "border-foreground bg-secondary font-medium" : "text-muted-foreground hover:border-foreground/40 hover:text-foreground")}>{o.value}<span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{o.n}</span></button>; })}
          {states_.length === 0 && <span className="text-sm text-muted-foreground">No states match.</span>}
        </div>
      </fieldset>
      <Chips label="How they pay" hint="People who use both count in each." options={f.payments.filter((o) => o.value !== "both").length || f.payments.length ? [{ value: "cod", n: f.payments.filter((o) => o.value === "cod" || o.value === "both").reduce((n, o) => n + o.n, 0) }, { value: "prepaid", n: f.payments.filter((o) => o.value === "prepaid" || o.value === "both").reduce((n, o) => n + o.n, 0) }] : []} picked={payments} onToggle={toggle(setPayments)} />
      <Chips label="Gender" options={f.genders} picked={genders} onToggle={toggle(setGenders)} />
      <Chips label="New or repeat customer" options={f.customers} picked={customers} onToggle={toggle(setCustomers)} />

      <div role="status" className="mt-6 rounded-xl bg-secondary p-4 text-sm">
        {empty ? "Choose one or more details above." : p ? (
          <>
            <p><strong className="text-lg tabular-nums">{p.matching}</strong> {p.matching === 1 ? "person matches" : "people match"}{p.undetermined > 0 && <> · <span className="tabular-nums">{p.undetermined}</span> more could match, but their details are not known</>}</p>
            {p.matching < 5 && <p className="mt-1 text-mixed">Fewer than 5 people match. Answers for this audience will say there isn't enough evidence to predict anything.</p>}
          </>
        ) : <Loader2 className="size-4 animate-spin" />}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div><label htmlFor="aud-name" className="text-xs text-muted-foreground">Name (optional)</label><input id="aud-name" className={cn(field, "mt-1 block w-64")} placeholder={p?.name && !empty ? p.name : "e.g. UP women on COD"} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <Button className="rounded-full" disabled={empty || save.isPending || (p?.matching ?? 0) === 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Use this audience"}</Button>
      </div>
      {save.isError && <p role="alert" className="mt-2 text-sm text-risk">{(save.error as Error).message}</p>}
    </div>
  );
}

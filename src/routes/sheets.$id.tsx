import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { adminApi } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingBlock, relativeTime } from "@/components/research/primitives";
import { cn } from "@/lib/utils";

const PAGE = 40;

export const Route = createFileRoute("/sheets/$id")({
  validateSearch: (s: Record<string, unknown>): { tab?: string; row?: number } => ({
    ...(typeof s["tab"] === "string" ? { tab: s["tab"] } : {}),
    ...(Number.isInteger(Number(s["row"])) && Number(s["row"]) > 0 ? { row: Number(s["row"]) } : {}),
  }),
  head: () => ({ meta: [{ title: "Source sheet — Research Hub" }, { name: "description", content: "Where an insight came from, in the research sheet." }] }),
  component: SheetPage,
});

function SheetPage() {
  const { id } = Route.useParams();
  const { tab, row } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [from, setFrom] = useState(() => (row ? Math.max(1, row - 8) : 1));
  const q = useQuery({ queryKey: ["sheet", id, tab ?? "", from], queryFn: () => adminApi.sheetView(id, { ...(tab ? { tab } : {}), from, limit: PAGE }), retry: false, placeholderData: (p) => p });
  const focusRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => { focusRef.current?.scrollIntoView({ block: "center" }); }, [q.data?.from, q.data?.tab, row]);
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const v = q.data;
  if (!v) return <EmptyState title="This sheet isn't available" body="It may not be linked any more, or hasn't been read yet." action={<Link to="/" className="underline">Back to Ask</Link>} />;
  const gridLink = `https://docs.google.com/spreadsheets/d/${v.spreadsheetId}/edit${v.gid ? `#gid=${v.gid}` : ""}`;
  const last = v.rows.at(-1)?.row ?? from;
  return (
    <div>
      <button type="button" onClick={() => history.back()} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Back</button>
      <h1 className="mt-4 text-3xl font-semibold">{v.name}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" />Redacted copy. Names, numbers and cities are hidden here.</span>
        {v.lastSyncedAt && <span>Last read {relativeTime(v.lastSyncedAt)}</span>}
        <a href={gridLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Open the original in Google Sheets <ExternalLink className="size-3.5" /></a>
      </p>
      {v.tabs.length > 1 && (
        <div role="tablist" aria-label="Sheet tabs" className="mt-5 flex flex-wrap gap-2">
          {v.tabs.map((t) => <button key={t.title} role="tab" aria-selected={t.title === v.tab} onClick={() => { setFrom(1); navigate({ search: { tab: t.title } }); }} className={cn("rounded-full px-3 py-1 text-sm", t.title === v.tab ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}>{t.title}</button>)}
        </div>
      )}
      <div className="mt-5 flex items-center justify-between gap-3">
        <Button variant="outline" className="rounded-full" disabled={!v.hasPrev} onClick={() => setFrom(Math.max(1, v.from - PAGE))}>Earlier rows</Button>
        <p className="text-sm tabular-nums text-muted-foreground">Rows {v.rows[0]?.row ?? "–"} to {last}</p>
        <Button variant="outline" className="rounded-full" disabled={!v.hasNext} onClick={() => setFrom(last + 1)}>Later rows</Button>
      </div>
      <div className="mt-3 overflow-auto rounded-2xl border bg-card" style={{ maxHeight: "70vh" }}>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-secondary text-left">
            <tr><th scope="col" className="w-14 px-3 py-2 text-right text-xs font-medium text-muted-foreground">Row</th><th scope="col" className="w-24 px-3 py-2 text-xs font-medium text-muted-foreground">Participant</th>{v.header.map((h, i) => <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 text-xs font-medium">{h || " "}</th>)}</tr>
          </thead>
          <tbody>
            {v.rows.map((r) => {
              const focus = r.row === row && v.tab === (tab ?? v.tab);
              return (
                <tr key={r.row} ref={focus ? focusRef : undefined} aria-current={focus ? "true" : undefined} className={cn("border-t align-top", focus && "bg-brand-soft ring-2 ring-inset ring-brand", r.removed && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  <th scope="row" className="px-3 py-2 text-right text-xs font-normal tabular-nums text-muted-foreground">{r.row}</th>
                  <td className="px-3 py-2 text-xs tabular-nums">{r.participantId ?? "–"}{r.removed && <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wide no-underline">Removed from sheet</span>}</td>
                  {v.header.map((_, i) => <td key={i} className={cn("px-3 py-2", (r.cells[i]?.length ?? 0) > 60 ? "min-w-[320px] max-w-[520px]" : "whitespace-nowrap")}>{r.cells[i] ?? ""}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
        {v.rows.length === 0 && <p className="p-6 text-sm text-muted-foreground">No rows in this range.</p>}
      </div>
    </div>
  );
}

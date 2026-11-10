import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { useSavedWork } from "@/api/hooks";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatusBadge, relativeTime } from "@/components/research/primitives";
import { WORK_ICON, WorkLink } from "@/components/research/AppShell";
import type { SavedWorkType } from "@/types/research";

export const Route = createFileRoute("/saved")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Saved work — Research Hub" }, { name: "description", content: "Return to a decision with its context intact." }, { property: "og:title", content: "Saved work — Research Hub" }, { property: "og:description", content: "Saved questions, assessments and conversations." }] }),
  component: Saved,
});

const TYPE_LABEL: Record<SavedWorkType, string> = { answer: "Research answer", assessment: "Prototype assessment", persona_chat: "Persona conversation", script_review: "Script review" };

function Saved() {
  const q = useSavedWork();
  const [s, setS] = useState("");
  const [type, setType] = useState<"all" | SavedWorkType>("all");
  const rows = (q.data ?? []).filter((r) => (type === "all" || r.type === type) && r.title.toLowerCase().includes(s.toLowerCase()));
  return (
    <div>
      <PageHeader eyebrow="Saved work" title="Return to a decision with its context intact." sub="Questions, materials, audiences, and answers are preserved together." />
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input aria-label="Search saved work" value={s} onChange={(e) => setS(e.target.value)} placeholder="Search saved work" className="h-10 w-full rounded-full border bg-card pl-9 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
        <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value as typeof type)} className="h-10 rounded-full border bg-card px-4 text-sm">
          <option value="all">All work</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {q.isLoading && <LoadingBlock />}
      {q.isError && <ErrorState onRetry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState title="Nothing saved matches" body="Try a different search or filter." />}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="hidden grid-cols-[minmax(0,1fr)_140px_125px_100px_16px] gap-3 border-b bg-muted/40 px-5 py-4 xl:grid">
            {["Title", "Audience", "Status", "Updated", ""].map((h) => <span key={h} className="eyebrow">{h}</span>)}
          </div>
          {rows.map((r) => {
            const Icon = WORK_ICON[r.type];
            return (
              <WorkLink key={r.id} item={r} className="grid grid-cols-[minmax(0,1fr)_16px] items-center gap-3 border-b px-5 py-5 transition-colors last:border-0 hover:bg-secondary/50 xl:grid-cols-[minmax(0,1fr)_140px_125px_100px_16px]">
                <span className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary"><Icon className="size-4" /></span><span className="min-w-0"><span className="block truncate font-medium">{r.title}</span><span className="text-xs text-muted-foreground">{TYPE_LABEL[r.type]}</span></span></span>
                <span className="hidden text-xs xl:block">{r.audience}</span>
                <span className="hidden xl:block"><StatusBadge tone={r.status === "Answered" ? "strong" : r.type === "persona_chat" ? "persona" : "mixed"}>{r.status}</StatusBadge></span>
                <span className="hidden text-xs text-muted-foreground xl:block">{relativeTime(r.updatedAt)}</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </WorkLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

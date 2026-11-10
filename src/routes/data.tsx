import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileUp, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminApi, adminToken, AdminAuthError, type AdminSource, type Redaction, type StudyRequestItem, type UploadResult } from "@/api/admin";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatusBadge, relativeTime } from "@/components/research/primitives";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/data")({
  head: () => ({ meta: [{ title: "Research data — Research Hub" }, { name: "description", content: "Upload research, review what the AI extracted, and rebuild audiences." }] }),
  component: DataPage,
});

const isRecording = (name: string) => /\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4|mov|mkv|webm|avi|3gp)$/i.test(name);
const redactionText = (r: Redaction) => {
  const parts = [r.names && `${r.names} name${r.names === 1 ? "" : "s"}`, r.phones && `${r.phones} number${r.phones === 1 ? "" : "s"}`, r.emails && `${r.emails} email${r.emails === 1 ? "" : "s"}`, r.places && `${r.places} cit${r.places === 1 ? "y" : "ies"}`].filter(Boolean);
  return parts.length ? `Removed ${parts.join(", ")} from the text` : "No names or numbers found in the text";
};
const field = "h-10 w-full rounded-lg border bg-card px-3 text-sm outline-none focus:border-foreground/40";

function DataPage() {
  const [, force] = useState(0);
  const jobs = useQuery({ queryKey: ["admin", "jobs"], queryFn: adminApi.jobs, refetchInterval: 4000, retry: false });
  if (jobs.error instanceof AdminAuthError) return <PasscodeGate onDone={() => { force((n) => n + 1); jobs.refetch(); }} />;
  return (
    <div>
      <PageHeader eyebrow="Research data" title="Add research, check what the AI found, keep audiences current." sub="Files you upload here are trusted research. Input from anyone else waits in the review queue." />
      <StatusStrip />
      <Tabs defaultValue="upload" className="mt-6">
        <TabsList className="rounded-full">
          <TabsTrigger value="upload" className="rounded-full">Upload</TabsTrigger>
          <TabsTrigger value="sources" className="rounded-full">Sources</TabsTrigger>
          <TabsTrigger value="review" className="rounded-full">Review queue</TabsTrigger>
          <RequestsTrigger />
          <TabsTrigger value="note" className="rounded-full">Add a note</TabsTrigger>
        </TabsList>
        <TabsContent value="upload"><UploadTab /></TabsContent>
        <TabsContent value="sources"><SourcesTab /></TabsContent>
        <TabsContent value="review"><ReviewTab /></TabsContent>
        <TabsContent value="requests"><RequestsTab /></TabsContent>
        <TabsContent value="note"><NoteTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function PasscodeGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border bg-card p-8">
      <ShieldCheck className="size-6" />
      <h1 className="mt-3 font-display text-2xl font-semibold">Research team only</h1>
      <p className="mt-1 text-sm text-muted-foreground">Enter the team passcode to manage research data.</p>
      <form className="mt-5 flex gap-2" onSubmit={(e) => { e.preventDefault(); adminToken.set(v); onDone(); }}>
        <input type="password" aria-label="Team passcode" value={v} onChange={(e) => setV(e.target.value)} className={field} autoFocus />
        <Button type="submit" className="rounded-full">Continue</Button>
      </form>
    </div>
  );
}

function StatusStrip() {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["admin", "jobs"], queryFn: adminApi.jobs, refetchInterval: 4000 });
  const rebuild = useMutation({ mutationFn: adminApi.rebuildAudiences, onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }) });
  const retry = useMutation({ mutationFn: adminApi.retryJob, onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }) });
  const n = (s: string) => jobs.data?.counts.find((c) => c.status === s)?.n ?? 0;
  const busy = n("queued") + n("running");
  return (
    <div className="mt-2 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2">{busy > 0 ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4 text-strong" />}{busy > 0 ? `Working on ${busy} task${busy === 1 ? "" : "s"} (transcribing and reading)` : "AI is idle"}</span>
        <span className="text-muted-foreground">{n("done")} done{n("failed") > 0 && <> · <span className="font-medium text-risk">{n("failed")} failed</span></>}</span>
        {jobs.data && !jobs.data.aiConfigured && <span className="font-medium text-risk">AI key not set: reading is paused</span>}
        <Button variant="outline" size="sm" className="ml-auto rounded-full" disabled={rebuild.isPending || busy > 0} onClick={() => rebuild.mutate()}>
          <RefreshCw className="mr-1.5 size-3.5" />Rebuild audiences
        </Button>
      </div>
      {rebuild.isError && <p className="mt-2 text-xs text-risk">{(rebuild.error as Error).message}</p>}
      {rebuild.isSuccess && <p className="mt-2 text-xs text-muted-foreground">Rebuilding segments and personas from approved evidence. This takes a few minutes.</p>}
      {jobs.data?.recentFailures.slice(0, 3).map((f) => (
        <div key={f.id} className="mt-2 flex items-center gap-3 text-xs"><span className="text-risk">{f.kind === "extract" ? "Reading a source" : "Rebuilding audiences"} failed: {f.error}</span><button className="font-medium underline" onClick={() => retry.mutate(f.id)}>Retry</button></div>
      ))}
    </div>
  );
}

type Row = { name: string; state: "waiting" | "uploading" | "done"; result?: UploadResult; error?: string };

function UploadTab() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["admin", "sources"], queryFn: adminApi.sources });
  const studies = [...new Set((sources.data ?? []).map((s) => s.study))];
  const [meta, setMeta] = useState({ study: "", product: "", kind: "cx_call" as "cx_call" | "interview", date: "", names: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const [ack, setAck] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof meta) => (e: { target: { value: string } }) => setMeta((m) => ({ ...m, [k]: e.target.value }));

  async function run(files: File[]) {
    if (!meta.study.trim()) { setRows((r) => [...r, { name: "", state: "done", error: "Enter a study name first, so these files are grouped correctly." }]); return; }
    const offset = rows.length; // keep earlier results visible; new uploads are added below them
    setRows((r) => [...r, ...files.map((f): Row => ({ name: f.name, state: "waiting" }))]);
    const patch = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === offset + i ? { ...x, ...p } : x)));
    for (const [i, f] of files.entries()) {
      if (isRecording(f.name) && !ack) { patch(i, { state: "done", error: "Tick the box about recordings (left) first, then upload this file again." }); continue; }
      patch(i, { state: "uploading" });
      try { patch(i, { state: "done", result: await adminApi.upload(f, meta, ack) }); }
      catch (e) { patch(i, { state: "done", error: (e as Error).message }); }
    }
    qc.invalidateQueries({ queryKey: ["admin"] });
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-4 rounded-2xl border bg-card p-5">
        <Label text="Study name *" hint="Groups files, e.g. “Snapdeal CX calls (Nov 2026)”">
          <input list="studies" className={field} value={meta.study} onChange={set("study")} placeholder="Snapdeal CX calls" />
          <datalist id="studies">{studies.map((s) => <option key={s} value={s} />)}</datalist>
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Label text="Product"><input className={field} value={meta.product} onChange={set("product")} placeholder="Snapdeal" /></Label>
          <Label text="Session date"><input type="date" className={field} value={meta.date} onChange={set("date")} /></Label>
        </div>
        <Label text="Type of research">
          <select className={field} value={meta.kind} onChange={set("kind")}><option value="cx_call">CX call</option><option value="interview">Interview</option></select>
        </Label>
        <Label text="Names to remove" hint="Optional. Comma-separated names of participants or interviewers. Names in a spreadsheet's Name column are removed automatically.">
          <input className={field} value={meta.names} onChange={set("names")} placeholder="Asha, Rohit" />
        </Label>
        <label className="flex gap-2.5 rounded-lg border border-mixed/40 bg-mixed-soft/50 p-3 text-xs">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Approve sending recordings to Gemini" />
          <span><span className="font-semibold">Recordings (audio or video)</span> are sent to Google Gemini exactly as recorded. Voices and spoken names can't be removed first, and on Gemini's free tier Google may use them to improve its products. Names in the finished transcript are removed. <span className="font-semibold">I approve this for the recordings I upload.</span></span>
        </label>
        <p className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" />Names, mobile numbers, emails and cities are removed before anything is stored or sent to the AI. Original files and their file names are not kept.</p>
      </div>
      <div>
        <div role="button" tabIndex={0} aria-label="Choose files to upload" onClick={() => input.current?.click()} onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); run([...e.dataTransfer.files]); }}
          className={cn("grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed bg-card px-6 py-14 text-center transition-colors", over ? "border-foreground bg-secondary" : "hover:bg-secondary/50")}>
          <FileUp className="size-7 text-muted-foreground" />
          <p className="mt-3 font-display text-lg font-semibold">Drop files here, or click to choose</p>
          <p className="mt-1 text-sm text-muted-foreground">CSV and Excel call notes · transcripts as txt, docx or pdf · recordings as mp3, wav, m4a, mp4, mov</p>
          <p className="mt-1 text-xs text-muted-foreground">Recordings are transcribed in the background (audio only; what is on screen in a video is not analysed yet). Scanned PDFs can't be read yet.</p>
          <input ref={input} type="file" multiple hidden accept=".csv,.xlsx,.xls,.txt,.md,.docx,.pdf,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.mp4,.mov,.mkv,.webm" onChange={(e) => { run([...(e.target.files ?? [])]); e.target.value = ""; }} />
        </div>
        <ul className="mt-4 space-y-2">{rows.map((r, i) => <ResultRow key={i} row={r} />)}</ul>
      </div>
    </div>
  );
}

function ResultRow({ row }: { row: Row }) {
  const r = row.result;
  const tone = row.error || r?.status === "failed" || r?.status === "unsupported" ? "risk" : r?.status === "partial" || r?.status === "queued" ? "mixed" : "strong";
  return (
    <li className="rounded-xl border bg-card p-4 text-sm">
      <div className="flex items-center gap-3">
        {row.state !== "done" ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <span className={cn("size-2.5 rounded-full", tone === "risk" ? "bg-risk" : tone === "mixed" ? "bg-mixed" : "bg-strong")} />}
        <span className="min-w-0 flex-1 truncate font-medium">{row.name || "Upload"}</span>
        {r && <StatusBadge tone={tone === "risk" ? "risk" : tone === "mixed" ? "mixed" : "strong"}>{r.status}</StatusBadge>}
        {row.state === "waiting" && <span className="text-xs text-muted-foreground">waiting</span>}
      </div>
      {(row.error || r) && <p className="mt-1.5 text-muted-foreground">{row.error ?? r?.message}</p>}
      {r && r.sourcesAdded + r.sourcesSkipped > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">{r.format} · {r.participantsAdded} participant{r.participantsAdded === 1 ? "" : "s"} · {redactionText(r.redaction)}{r.sourcesSkipped > 0 && ` · ${r.sourcesSkipped} already imported`}{r.jobsQueued ? " · AI reading queued" : ""}</p>
      )}
    </li>
  );
}

function Label({ text, hint, children }: { text: string; hint?: string; children: ReactNode }) {
  return <label className="block"><span className="text-sm font-medium">{text}</span><span className="mt-1.5 block">{children}</span>{hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}</label>;
}

const JOB_LABEL: Record<string, string> = { queued: "Waiting for AI", running: "AI reading", done: "Read", failed: "Failed" };
function SourcesTab() {
  const q = useQuery({ queryKey: ["admin", "sources"], queryFn: adminApi.sources, refetchInterval: 5000 });
  const jobs = useQuery({ queryKey: ["admin", "jobs"], queryFn: adminApi.jobs, refetchInterval: 4000 });
  const inProgress = jobs.data?.transcriptions ?? [];
  if (q.isLoading) return <div className="mt-6"><LoadingBlock /></div>;
  if (q.isError) return <div className="mt-6"><ErrorState onRetry={() => q.refetch()} /></div>;
  const rows: AdminSource[] = q.data ?? [];
  if (!rows.length && !inProgress.length) return <div className="mt-6"><EmptyState title="No research yet" body="Upload a file on the Upload tab to get started." /></div>;
  return (
    <div className="mt-6">
    {inProgress.length > 0 && (
      <ul className="mb-4 space-y-2">
        {inProgress.map((t) => (
          <li key={t.id} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm"><Loader2 className="size-4 animate-spin text-muted-foreground" /><span className="font-medium">Recording · {t.study}</span><span className="text-muted-foreground">{t.status === "queued" ? "Waiting to start" : t.note}</span><span className="ml-auto text-xs text-muted-foreground">{relativeTime(t.createdAt)}</span></li>
        ))}
      </ul>
    )}
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-muted/40"><tr>{["Participant", "Study", "Type", "From", "Evidence", "AI", "Privacy", "Added"].map((h) => <th key={h} className="eyebrow px-4 py-3">{h}</th>)}</tr></thead>
        <tbody>{rows.map((s) => (
          <tr key={s.id} className="border-b last:border-0 align-top">
            <td className="px-4 py-3 font-medium tabular-nums">{s.participantId}</td>
            <td className="px-4 py-3">{s.study}{s.quality === "noisy_asr" && <span className="block text-xs text-mixed">Noisy machine transcript</span>}{s.quality === "asr_gemini" && <span className="block text-xs text-mixed">Machine transcript: check wording</span>}</td>
            <td className="px-4 py-3 text-xs">{s.sourceType === "cx_call" ? "CX call" : "Interview"}<span className="block text-muted-foreground">{s.origin === "researcher_notes" ? "researcher notes" : "verbatim transcript"}</span></td>
            <td className="px-4 py-3"><StatusBadge tone={s.submittedBy === "research_team" ? "strong" : "mixed"}>{s.submittedBy === "research_team" ? "Research team" : "Contributor"}</StatusBadge></td>
            <td className="px-4 py-3 tabular-nums">{s.evidence}{s.pendingEvidence > 0 && <span className="block text-xs text-mixed">{s.pendingEvidence} to review</span>}</td>
            <td className="px-4 py-3 text-xs">{s.job ? JOB_LABEL[s.job] : "—"}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{redactionText(s.redaction)}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{relativeTime(s.createdAt)}</td>
          </tr>))}</tbody>
      </table>
    </div>
    </div>
  );
}

function ReviewTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "review"], queryFn: () => adminApi.review("pending") });
  const act = useMutation({ mutationFn: (v: { id: number; action: "approve" | "reject" }) => adminApi.setStatus(v.id, v.action), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }) });
  if (q.isLoading) return <div className="mt-6"><LoadingBlock /></div>;
  if (q.isError) return <div className="mt-6"><ErrorState onRetry={() => q.refetch()} /></div>;
  if (!q.data?.total) return <div className="mt-6"><EmptyState title="Nothing waiting for review" body="Evidence from your own uploads is approved automatically. Notes sent in by other people appear here first." /></div>;
  return (
    <div className="mt-6">
      <p className="mb-3 text-sm text-muted-foreground">{q.data.total} piece{q.data.total === 1 ? "" : "s"} of evidence waiting. Nothing here is used in answers until you approve it. Showing the first {q.data.items.length}.</p>
      <ul className="space-y-3">
        {q.data.items.map((e) => (
          <li key={e.id} className="rounded-2xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{e.participantId}</span><span>{e.kind === "said" ? "said" : "did"}</span><span>· {e.theme}</span><span>· {e.sentiment}</span>
              {e.provenance === "researcher_note" && <StatusBadge tone="mixed">researcher's summary</StatusBadge>}
              {e.flags && <StatusBadge tone="risk">{e.flags.replace(/_/g, " ")}</StatusBadge>}
            </div>
            <blockquote className="mt-2 border-l-2 pl-3 text-base">{e.quote}</blockquote>
            {e.translation && <p className="mt-1.5 pl-3 text-sm text-muted-foreground">English: {e.translation}</p>}
            <div className="mt-3 flex gap-2">
              <Button size="sm" className="rounded-full" disabled={act.isPending} onClick={() => act.mutate({ id: e.id, action: "approve" })}><Check className="mr-1 size-4" />Approve</Button>
              <Button size="sm" variant="outline" className="rounded-full" disabled={act.isPending} onClick={() => act.mutate({ id: e.id, action: "reject" })}><X className="mr-1 size-4" />Reject</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoteTab() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"cx_call" | "interview">("cx_call");
  const send = useMutation({ mutationFn: () => adminApi.contribute(text, kind), onSuccess: () => setText("") });
  return (
    <form className="mt-6 max-w-2xl space-y-4 rounded-2xl border bg-card p-5" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
      <p className="text-sm text-muted-foreground">Paste an observation, a CX call summary or feedback. It's redacted on arrival and waits in the review queue; it isn't used in answers until the research team approves it.</p>
      <select aria-label="Type" className={field} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="cx_call">CX call</option><option value="interview">Interview / research note</option></select>
      <textarea aria-label="Note" rows={7} value={text} onChange={(e) => setText(e.target.value)} className={cn(field, "h-auto py-2")} placeholder="What did the customer say or do?" />
      <div className="flex items-center gap-3">
        <Button type="submit" className="rounded-full" disabled={text.trim().length < 10 || send.isPending}>Send for review</Button>
        {send.isSuccess && <span className="text-sm text-strong">Received. It's waiting for review.</span>}
        {send.isError && <span className="text-sm text-risk">{(send.error as Error).message}</span>}
      </div>
    </form>
  );
}

function RequestsTrigger() {
  const q = useQuery({ queryKey: ["admin", "requests"], queryFn: adminApi.studyRequests, refetchInterval: 15000 });
  const fresh = (q.data ?? []).filter((r) => r.status === "new").length;
  return <TabsTrigger value="requests" className="rounded-full">Study requests{fresh > 0 && <span className="ml-1.5 rounded-full bg-foreground px-1.5 text-[10px] font-semibold text-background">{fresh}</span>}</TabsTrigger>;
}

const REQ_STATUS: { value: StudyRequestItem["status"]; label: string }[] = [{ value: "new", label: "New" }, { value: "accepted", label: "Accepted" }, { value: "in_progress", label: "In progress" }, { value: "done", label: "Done" }, { value: "declined", label: "Declined" }];

function RequestsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "requests"], queryFn: adminApi.studyRequests });
  const save = useMutation({ mutationFn: (v: { id: string; status?: StudyRequestItem["status"]; teamNote?: string }) => adminApi.updateStudyRequest(v.id, { ...(v.status ? { status: v.status } : {}), ...(v.teamNote !== undefined ? { teamNote: v.teamNote } : {}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "requests"] }) });
  if (q.isLoading) return <div className="mt-6"><LoadingBlock /></div>;
  if (q.isError) return <div className="mt-6"><ErrorState onRetry={() => q.refetch()} /></div>;
  if (!q.data?.length) return <div className="mt-6"><EmptyState title="No study requests" body="When someone plans a test and asks the research team to run it, it shows up here with their role, team and note." /></div>;
  return (
    <ul className="mt-6 space-y-4">
      {q.data.map((r) => <RequestCard key={r.id} r={r} onSave={(v) => save.mutate({ id: r.id, ...v })} saving={save.isPending} />)}
    </ul>
  );
}

function RequestCard({ r, onSave, saving }: { r: StudyRequestItem; onSave: (v: { status?: StudyRequestItem["status"]; teamNote?: string }) => void; saving: boolean }) {
  const [reply, setReply] = useState(r.teamNote ?? "");
  const [open, setOpen] = useState(r.status === "new");
  const who = [r.requester.role, r.requester.team, r.requester.area].filter(Boolean).join(" · ") || "Unknown requester";
  return (
    <li className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg font-semibold">{r.title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{who} · {r.plan.audience.map((a) => a.name).join(" + ") || "All users"} · requested {relativeTime(r.createdAt)}</p>
        </div>
        <select aria-label="Status" className="h-9 rounded-full border bg-background px-3 text-sm" value={r.status} onChange={(e) => onSave({ status: e.target.value as StudyRequestItem["status"] })} disabled={saving}>
          {REQ_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {r.note && <p className="mt-3 rounded-xl bg-secondary p-3 text-sm"><span className="eyebrow mr-2">Their note</span>{r.note}</p>}
      <button className="mt-3 text-sm font-medium underline-offset-2 hover:underline" onClick={() => setOpen((o) => !o)}>{open ? "Hide plan" : "Show plan"}</button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <p><span className="eyebrow mr-2">Asked about</span>{r.plan.question}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {([["Objective", r.plan.studyPlan.objective], ["Audience & sample", r.plan.studyPlan.audience], ["Task", r.plan.studyPlan.task], ["Watch for", r.plan.studyPlan.watchFor]] as const).map(([k, v]) => <div key={k}><p className="eyebrow">{k}</p><p className="mt-1">{v}</p></div>)}
          </div>
          <div><p className="eyebrow">Questions</p><ol className="mt-1 list-decimal space-y-1 pl-5">{r.plan.studyPlan.questions.map((x) => <li key={x}>{x}</li>)}</ol></div>
          {r.plan.known.length > 0 && <div><p className="eyebrow">Already well understood</p><ul className="mt-1 list-disc space-y-1 pl-5">{r.plan.known.map((k) => <li key={k.title}><span className="font-medium">{k.title}</span>: {k.body}</li>)}</ul></div>}
          {r.plan.unknowns.length > 0 && <div><p className="eyebrow">Needs validation</p><ul className="mt-1 list-disc space-y-1 pl-5">{r.plan.unknowns.map((k) => <li key={k.title}><span className="font-medium">{k.title}</span>: {k.body}</li>)}</ul></div>}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <input aria-label="Reply to the requester" className={field} placeholder="Reply to the requester (shown on their plan)" value={reply} onChange={(e) => setReply(e.target.value)} />
        <Button size="sm" className="rounded-full" disabled={saving || reply === (r.teamNote ?? "")} onClick={() => onSave({ teamNote: reply })}>Send reply</Button>
      </div>
    </li>
  );
}

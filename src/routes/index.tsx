import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Paperclip, Send, ShieldCheck, Loader2, Check, Mic, Square, FileText, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api";
import { useAudiences, useParticipantCount, useProfile, useSaveProfile } from "@/api/hooks";
import { ROLE_OPTIONS, ROLE_STARTERS, roleLabel } from "@/lib/roleLens";
import type { Role } from "@/types/research";
import { AudienceChips, Eyebrow, PageHeader } from "@/components/research/primitives";
import { AudiencePickerDialog, type AudienceMode } from "@/components/research/AudiencePickerDialog";
import { PersonaChips } from "@/components/research/PersonaChips";
import type { AudienceRef } from "@/types/research";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDictation } from "@/hooks/use-dictation";

export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { audience?: string } => typeof s['audience'] === "string" ? { audience: s['audience'] } : {},
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Ask — Research Hub" }, { name: "description", content: "Ask what your team's research suggests, with evidence and confidence." }, { property: "og:title", content: "Ask — Research Hub" }, { property: "og:description", content: "Evidence-only answers from your team's research." }] }),
  component: AskPage,
});

const STEPS = ["Finding relevant evidence", "Checking agreement", "Checking contradictions", "Assessing evidence strength"];

function AskPage() {
  const { audience: pre } = Route.useSearch();
  const navigate = useNavigate();
  const audiences = useAudiences();
  const profile = useProfile();
  const saveProfile = useSaveProfile();
  const [roleOverride, setRoleOverride] = useState<Role | null>(null);
  const role = roleOverride ?? profile.data?.role ?? "designer";
  const switchRole = (r: Role) => {
    setRoleOverride(r);
    if (profile.data) saveProfile.mutate({ ...profile.data, role: r });
  };
  const [audience, setAudience] = useState<AudienceRef[]>([]);
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !audiences.data) return;
    const defaultAudience = audiences.data.find((a) => a.ref.id === pre) ?? audiences.data[0];
    if (defaultAudience) setAudience([defaultAudience.ref]);
    initialized.current = true;
  }, [audiences.data, pre]);
  const [mode, setMode] = useState<AudienceMode>("combine");
  const [picker, setPicker] = useState(false);
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [transcript, setTranscript] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState("en-IN");
  const dictation = useDictation((text) => setQ((current) => `${current}${current ? " " : ""}${text}`));
  const [step, setStep] = useState(-1);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = useParticipantCount(audience);
  const ask = useMutation({ mutationFn: () => api.ask({ question: q.trim(), audience, mode, attachments: [...files.map((name) => ({ name, kind: "local" as const })), ...(transcript.trim() ? [{ name: "Pasted CX transcript", kind: "transcript" as const, text: transcript.trim() }] : [])] }) });

  useEffect(() => {
    if (step < 0) return;
    if (step < STEPS.length) { const t = setTimeout(() => setStep((s) => s + 1), 450); return () => clearTimeout(t); }
    if (ask.data) navigate({ to: "/ask/$id", params: { id: ask.data.id } });
    return;
  }, [step, ask.data, navigate]);

  const submit = () => { if (!q.trim()) return; dictation.stop(); setStep(0); ask.mutate(); };

  if (step >= 0) {
    return (
      <div className="mx-auto max-w-md py-24">
        <Eyebrow className="text-brand">Working inside your research</Eyebrow>
        <p className="mt-3 font-display text-2xl font-semibold">“{q}”</p>
        <ul className="mt-8 space-y-3">
          {STEPS.map((s, i) => (
            <li key={s} className={cn("flex items-center gap-3", i > step && "text-muted-foreground/60")}>
              {i < step ? <Check className="size-4 text-strong" /> : i === step ? <Loader2 className="size-4 animate-spin" /> : <span className="size-4" />}{s}
            </li>
          ))}
        </ul>
        {ask.isError && <Button className="mt-6 rounded-full" onClick={() => { setStep(0); ask.mutate(); }}>Try again</Button>}
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow="Evidence-only assistant" title="What do you want to understand?" sub="Ask about behaviour, assess an idea, or improve your research. Answers stay inside the evidence your team already has." />
      <div className="mb-3 flex items-center justify-between"><Eyebrow>Audience</Eyebrow><span className="text-xs tabular-nums text-muted-foreground">{count.data ?? "–"} represented participants{mode === "compare" && audience.length > 1 ? " · comparing" : ""}</span></div>
      <AudienceChips audience={audience} onRemove={(id) => setAudience((a) => a.filter((x) => x.id !== id))} onAdd={() => setPicker(true)} />
      <div className="mt-3"><PersonaChips selected={audience.map((a) => a.id)} onSelect={(p) => setAudience((a) => a.some((x) => x.id === p.id) ? a.filter((x) => x.id !== p.id) : [...a, p])} /></div>
      <div className="ask-composer mt-5 rounded-2xl border bg-card p-3 focus-within:border-brand/40">
        <label htmlFor="ask" className="sr-only">Your question</label>
        <textarea id="ask" rows={4} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask what the research suggests, review a script, or share an idea…" className="w-full resize-none bg-transparent p-3 text-lg outline-none placeholder:text-muted-foreground" />
        {dictation.listening && <p role="status" className="px-3 pb-3 text-sm text-brand">Listening… {dictation.interim}</p>}
        {dictation.error && <p role="alert" className="px-3 pb-3 text-xs text-risk">{dictation.error}</p>}
        {showTranscript && <section className="mx-3 mb-3 rounded-lg border bg-muted/40 p-3"><div className="mb-2 flex items-center justify-between"><label htmlFor="cx-transcript" className="text-xs font-semibold">CX transcript · your material</label><Button variant="ghost" size="icon" aria-label="Remove pasted transcript" onClick={() => { setShowTranscript(false); setTranscript(""); }}><X /></Button></div><textarea id="cx-transcript" rows={4} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Paste caller notes or a transcript in English, Hindi or Hinglish…" className="w-full resize-y bg-transparent text-sm outline-none" /><p className="mt-2 text-xs text-muted-foreground">Not added to repository evidence. The mock answer does not analyse this transcript.</p></section>}
        {files.length > 0 && <div className="flex flex-wrap gap-2 px-3 pb-2">{files.map((f) => <span key={f} className="rounded-full bg-secondary px-3 py-1 text-xs">Your material · {f}</span>)}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="icon" title="Add material" aria-label="Add material" onClick={() => fileRef.current?.click()} className="rounded-full text-muted-foreground"><Paperclip /></Button>
          <Button variant="ghost" size="icon" title="Paste CX transcript" aria-label="Paste CX transcript" aria-pressed={showTranscript} onClick={() => setShowTranscript((s) => !s)} className={cn("rounded-full text-muted-foreground", showTranscript && "bg-brand-soft text-brand")}><FileText /></Button>
          <Button variant="ghost" size="icon" title={dictation.supported ? "Dictate question" : "Voice input unavailable in this browser"} aria-label={dictation.listening ? "Stop dictation" : "Dictate question"} aria-pressed={dictation.listening} onClick={() => dictation.listening ? dictation.stop() : dictation.start(voiceLanguage)} className={cn("rounded-full text-muted-foreground", dictation.listening && "bg-risk-soft text-risk")}>{dictation.listening ? <Square /> : <Mic />}</Button>
          <select aria-label="Dictation language" disabled={dictation.listening} value={voiceLanguage} onChange={(e) => setVoiceLanguage(e.target.value)} className="max-w-32 rounded-full border bg-background px-2 py-1.5 text-xs text-muted-foreground"><option value="en-IN">English (India)</option><option value="hi-IN">Hindi / Hinglish</option></select>
          </div>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => setFiles(Array.from(e.target.files ?? []).map((f) => f.name))} />
          <Button className="rounded-full px-5" disabled={!q.trim() || audience.length === 0} onClick={submit}><Send className="size-4" />Ask research</Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Voice input requires microphone permission and may use your browser’s speech service.</p>
      <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" />Attachments are your material, not repository evidence. Local files must be reattached after a reload.</p>
      <div className="mt-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Eyebrow>Starter prompts for {roleLabel(role)}</Eyebrow>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Switch role to preview prompts">
            {ROLE_OPTIONS.map((r) => (
              <button key={r.id} role="radio" aria-checked={role === r.id} onClick={() => switchRole(r.id)} className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium transition", role === r.id ? "border-brand bg-brand-soft text-brand" : "text-muted-foreground hover:text-foreground")}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
        {ROLE_STARTERS[role].map(([k, t]) => (
          <Button variant="outline" key={t} onClick={() => setQ(t)} className="research-card group flex h-auto items-center justify-between gap-4 whitespace-normal rounded-xl border bg-card p-5 text-left font-normal">
            <span><span className="eyebrow text-brand">{k}</span><span className="mt-1.5 block">{t}</span></span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
          </Button>
        ))}
        </div>
      </div>
      <AudiencePickerDialog open={picker} onOpenChange={setPicker} value={audience} mode={mode} onApply={(v, m) => { setAudience(v); setMode(m); }} />
    </div>
  );
}

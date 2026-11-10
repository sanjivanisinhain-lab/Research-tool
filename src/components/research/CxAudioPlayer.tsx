import { useRef, useState } from "react";
import { Headphones, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EvidenceItem } from "@/types/research";
import { cn } from "@/lib/utils";

export function CxAudioPlayer({ evidence }: { evidence: EvidenceItem }) {
  const audio = evidence.audio;
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [view, setView] = useState<"voice" | "transcript">("voice");
  const [error, setError] = useState(false);
  if (!audio) return null;
  const toggle = async () => {
    const player = ref.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    try { await player.play(); setError(false); } catch { setError(true); }
  };
  return <section className="mt-4 border-t pt-4" aria-label={`CX audio ${evidence.participantId}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="inline-flex items-center gap-2 text-xs font-medium text-brand"><Headphones className="size-4" />Simulated voice · {evidence.originalLanguage === "hi" ? "Hindi" : "Hinglish"}</span>
      <div className="inline-flex rounded-full border bg-secondary p-0.5" role="group" aria-label="Audio view">
        {(["voice", "transcript"] as const).map((v) => <Button key={v} variant="ghost" size="sm" aria-pressed={view === v} onClick={() => setView(v)} className={cn("h-7 rounded-full capitalize", view === v && "bg-card shadow-sm")}>{v === "voice" ? "Original voice" : "Transcript"}</Button>)}
      </div>
    </div>
    <audio ref={ref} src={audio.url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onError={() => setError(true)} />
    <div className="mt-3 flex items-center gap-3">
      <Button size="icon" className="shrink-0 rounded-full" aria-label={playing ? "Pause simulated call" : "Play simulated call"} onClick={toggle}>{playing ? <Pause /> : <Play />}</Button>
      <input type="range" min="0" max={audio.duration} step="0.01" value={Math.min(time, audio.duration)} aria-label="Call playback position" className="min-w-0 flex-1 accent-brand" onChange={(e) => { const next = Number(e.target.value); if (ref.current) ref.current.currentTime = next; setTime(next); }} />
      <span className="text-xs tabular-nums text-muted-foreground">{time.toFixed(1)} / {audio.duration.toFixed(1)}s</span>
      <Button variant="ghost" size="icon" aria-label="Replay from start" onClick={() => { if (ref.current) ref.current.currentTime = 0; setTime(0); }}><RotateCcw /></Button>
    </div>
    {view === "transcript" && <div className="mt-3 rounded-lg border bg-muted/50 p-3"><p className="mb-2 text-xs font-medium text-muted-foreground">Original · {evidence.originalLanguage === "hi" ? "Hindi" : "Hinglish"}</p><p className="text-sm leading-relaxed">{audio.cues.map((cue, i) => <span key={cue.start} className={cn("rounded px-0.5 transition-colors", time >= cue.start && time < cue.end && "bg-brand-soft text-brand")}>{cue.text}{i < audio.cues.length - 1 ? " " : ""}</span>)}</p>{evidence.translation && <div className="mt-3 border-t pt-3"><p className="mb-1 text-xs font-medium text-muted-foreground">English translation · not verbatim</p><p className="text-sm text-muted-foreground">{evidence.translation}</p></div>}</div>}
    <p className="mt-2 text-[11px] text-muted-foreground">Synthetic reading of the simulated quote; not an original caller recording.</p>
    {error && <p role="alert" className="mt-2 text-xs text-risk">Audio unavailable. The original transcript remains available.</p>}
  </section>;
}
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { OnboardingLayout } from "@/components/research/OnboardingLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useSaveProfile } from "@/api/hooks";
import type { Role } from "@/types/research";

export const Route = createFileRoute("/onboarding/context")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Work context — Research Hub" }, { name: "description", content: "Tell Research Hub what you're working on." }, { property: "og:title", content: "Work context — Research Hub" }, { property: "og:description", content: "Tell Research Hub what you're working on." }] }),
  component: ContextPage,
});

function ContextPage() {
  const [team, setTeam] = useState("");
  const [area, setArea] = useState("");
  const [note, setNote] = useState("");
  const save = useSaveProfile();
  const navigate = useNavigate();
  const submit = () => {
    const role = (sessionStorage.getItem("rh.role") as Role | null) ?? "other";
    save.mutate({ role, team: team.trim(), area: area.trim(), ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: () => navigate({ to: "/" }) });
  };
  return (
    <OnboardingLayout step={3}>
      <p className="eyebrow text-brand">Work context</p>
      <h2 className="mt-3 text-4xl font-semibold">What are you working on?</h2>
      <p className="mt-3 text-lg text-muted-foreground">Save this once. You can change it from your profile later.</p>
      <div className="mt-8 space-y-5">
        <div className="space-y-1.5"><Label htmlFor="team">Team or product</Label><Input id="team" className="h-11 bg-card" placeholder="e.g. Shopping experience" value={team} onChange={(e) => setTeam(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="area">Area of work</Label><Input id="area" className="h-11 bg-card" placeholder="e.g. Discovery and PDP" value={area} onChange={(e) => setArea(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="note">Anything else? <span className="text-muted-foreground">(optional)</span></Label><Textarea id="note" className="bg-card" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <div className="mt-8 flex items-center gap-4">
        <Button className="rounded-full px-6" disabled={!team.trim() || !area.trim() || save.isPending} onClick={submit}>Enter Research Hub <ArrowRight className="size-4" /></Button>
        <Link to="/onboarding/role" className="text-sm font-medium text-muted-foreground hover:text-foreground">Back</Link>
      </div>
    </OnboardingLayout>
  );
}

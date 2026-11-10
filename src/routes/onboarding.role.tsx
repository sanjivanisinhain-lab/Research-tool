import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { OnboardingLayout } from "@/components/research/OnboardingLayout";
import { Button } from "@/components/ui/button";
import { ROLE_OPTIONS } from "@/lib/roleLens";
import type { Role } from "@/types/research";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding/role")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Your role — Research Hub" }, { name: "description", content: "Choose the lens for recommendations." }, { property: "og:title", content: "Your role — Research Hub" }, { property: "og:description", content: "Choose the lens for recommendations." }] }),
  component: RolePage,
});

function RolePage() {
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    const saved = sessionStorage.getItem("rh.role");
    const match = ROLE_OPTIONS.find((option) => option.id === saved);
    if (match) setRole(match.id);
  }, []);
  const navigate = useNavigate();
  return (
    <OnboardingLayout step={2}>
      <p className="eyebrow text-brand">Your lens</p>
      <h2 className="mt-3 text-4xl font-semibold">What best describes your role?</h2>
      <p className="mt-3 text-lg text-muted-foreground">This tailors recommendations, not the underlying evidence.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2" role="radiogroup">
        {ROLE_OPTIONS.map((r) => (
          <button key={r.id} role="radio" aria-checked={role === r.id} onClick={() => setRole(r.id)} className={cn("relative rounded-2xl border-2 bg-card p-4 text-left transition", role === r.id ? "border-brand" : "border-transparent ring-1 ring-border hover:ring-foreground/30")}>
            {role === r.id && <span className="absolute right-3 top-3 grid size-5 place-items-center rounded-full bg-brand text-brand-foreground"><Check className="size-3" /></span>}
            <p className="font-semibold">{r.label}</p><p className="mt-0.5 text-sm text-muted-foreground">{r.hint}</p>
          </button>
        ))}
      </div>
      <div className="mt-8 flex items-center gap-4">
        <Button className="rounded-full px-6" disabled={!role} onClick={() => { if (!role) return; sessionStorage.setItem("rh.role", role); navigate({ to: "/onboarding/context" }); }}>Continue</Button>
        <Link to="/welcome" className="text-sm font-medium text-muted-foreground hover:text-foreground">Back</Link>
      </div>
    </OnboardingLayout>
  );
}

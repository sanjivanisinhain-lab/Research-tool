import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, ArrowRight } from "lucide-react";
import { OnboardingLayout } from "@/components/research/OnboardingLayout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/welcome")({
  head: () => ({ meta: [{ property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }, { title: "Welcome — Research Hub" }, { name: "description", content: "Research that can show its work." }, { property: "og:title", content: "Welcome — Research Hub" }, { property: "og:description", content: "Research that can show its work." }] }),
  component: Welcome,
});

function Welcome() {
  const cards = [
    ["Direct answers", "A clear conclusion first, then the reasoning."],
    ["Visible uncertainty", "Every answer says how far it can be trusted."],
    ["Traceable evidence", "Each claim links to a quote, participant and date."],
  ];
  return (
    <OnboardingLayout step={1}>
      <p className="eyebrow text-brand">Welcome</p>
      <h2 className="mt-3 text-4xl font-semibold">Research that can show its work.</h2>
      <p className="mt-3 text-lg text-muted-foreground">Research Hub answers only from your team's own research. When the research is silent, it says so.</p>
      <div className="mt-8 space-y-3">
        {cards.map(([t, d]) => (
          <div key={t} className="flex gap-4 rounded-2xl border bg-card p-4"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><Check className="size-4" /></span><div><p className="font-semibold">{t}</p><p className="text-sm text-muted-foreground">{d}</p></div></div>
        ))}
      </div>
      <Button asChild className="mt-8 w-fit rounded-full px-6"><Link to="/onboarding/role">Continue <ArrowRight className="size-4" /></Link></Button>
    </OnboardingLayout>
  );
}

import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Logo } from "./AppShell";
import { cn } from "@/lib/utils";

export function OnboardingLayout({ step, children }: { step: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="flex flex-col justify-between bg-brand p-10 text-brand-foreground lg:p-14">
        <div className="flex items-center gap-3"><Logo inverted /><span className="font-display text-lg font-semibold">Research Hub</span><span className="rounded-md border border-brand-foreground/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">Demo</span></div>
        <div className="my-14">
          <p className="eyebrow text-brand-foreground/70">Evidence, not guesswork</p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.05] xl:text-6xl">Make decisions with your actual users in mind.</h1>
          <p className="mt-5 max-w-md text-lg text-brand-foreground/75">Ask questions, assess ideas, and explore audience perspectives, all grounded in your team's research.</p>
        </div>
        <p className="flex max-w-md gap-3 text-sm text-brand-foreground/75"><ShieldCheck className="size-5 shrink-0" />Answers show sources, uncertainty, and gaps. Your role only changes how recommendations are framed.</p>
      </aside>
      <main className="flex flex-col p-8 lg:p-14">
        <div className="grid grid-cols-3 gap-2" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((i) => <span key={i} className={cn("h-1 rounded-full", i <= step ? "bg-brand" : "bg-border")} />)}
        </div>
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-12">{children}</div>
      </main>
    </div>
  );
}

import { IS_MOCK } from "@/config/dataMode";
import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { MessageCircle, MonitorPlay, UserRound, UsersRound, Clock, Plus, MoreHorizontal, Sparkle, Database } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useProfile, useSavedWork, useSaveProfile } from "@/api/hooks";
import { ROLE_OPTIONS, roleLabel } from "@/lib/roleLens";
import type { Role } from "@/types/research";
import { cn } from "@/lib/utils";
import { SimulatedDataBadge, relativeTime } from "./primitives";
import { ProfileDialog } from "./ProfileDialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { SavedWorkItem } from "@/types/research";

const NAV = [
  { to: "/", label: "Ask", icon: MessageCircle, match: (p: string) => p === "/" || p.startsWith("/ask") },
  { to: "/assess", label: "Assess prototype", icon: MonitorPlay, match: (p: string) => p.startsWith("/assess") },
  { to: "/persona-chat", label: "Persona chat", icon: UserRound, match: (p: string) => p.startsWith("/persona-chat") },
  { to: "/audiences", label: "Audiences", icon: UsersRound, match: (p: string) => p.startsWith("/audiences") },
  { to: "/saved", label: "Saved work", icon: Clock, match: (p: string) => p.startsWith("/saved") },
  // Research-team data management only exists with the real backend
  ...(IS_MOCK ? [] : [{ to: "/data", label: "Research data", icon: Database, match: (p: string) => p.startsWith("/data") }]),
] as const;

export const WORK_ICON: Record<SavedWorkItem["type"], typeof MessageCircle> = {
  answer: MessageCircle,
  assessment: MonitorPlay,
  persona_chat: UserRound,
  script_review: MessageCircle,
};

export function Logo({ inverted }: { inverted?: boolean }) {
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", inverted ? "bg-brand-foreground text-brand" : "bg-foreground text-background")}>
      <Sparkle className="size-4" />
    </span>
  );
}

export function WorkLink({ item, children, className }: { item: SavedWorkItem; children: ReactNode; className?: string }) {
  const t = item.target;
  if (t.to === "/persona-chat") return <Link to="/persona-chat" search={{ persona: t.persona }} className={className}>{children}</Link>;
  if (t.to === "/assess/$id") return <Link to="/assess/$id" params={{ id: t.id }} className={className}>{children}</Link>;
  return <Link to="/ask/$id" params={{ id: t.id }} className={className}>{children}</Link>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const profile = useProfile();
  const saveProfile = useSaveProfile();
  const saved = useSavedWork();
  const [editOpen, setEditOpen] = useState(false);
  const p = profile.data;
  const initials = roleLabel(p?.role).split(" ").map((w) => w[0]).join("").slice(0, 2);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="flex w-16 shrink-0 flex-col border-r bg-sidebar px-2 py-5 lg:w-64 lg:px-4">
        <div className="flex items-center gap-2.5 px-1">
          <Logo />
          <span className="hidden font-display text-lg font-semibold leading-none lg:inline">Research Hub</span>
          <span className="ml-auto hidden rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:inline">{IS_MOCK ? "Demo" : "Internal"}</span>
        </div>
        <Link to="/" aria-label="New question" className="mt-6 flex h-10 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90">
          <Plus className="size-4" /><span className="hidden lg:inline">New question</span>
        </Link>
        <nav className="mt-5 space-y-0.5" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match(path);
            return (
              <Link key={n.to} to={n.to} title={n.label} aria-current={active ? "page" : undefined} className={cn("flex h-10 items-center justify-center gap-3 rounded-xl px-3 text-sm lg:justify-start", active ? "bg-card font-semibold shadow-sm" : "text-foreground/70 hover:bg-sidebar-accent hover:text-foreground")}>
                <n.icon className="size-[18px] shrink-0" /><span className="hidden lg:inline">{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 hidden border-t pt-5 lg:block">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="eyebrow">Recent work</span>
            <Link to="/saved" className="text-xs font-medium hover:underline">View all</Link>
          </div>
          {saved.isLoading && <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
          {saved.isError && <button onClick={() => saved.refetch()} className="px-1 text-xs text-risk">Couldn't load. Retry</button>}
          {saved.data?.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing yet.</p>}
          <ul className="space-y-0.5">
            {saved.data?.slice(0, 3).map((s) => {
              const Icon = WORK_ICON[s.type];
              return (
                <li key={s.id}>
                  <WorkLink item={s} className="flex items-start gap-2.5 rounded-lg p-2 hover:bg-sidebar-accent">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card"><Icon className="size-3.5" /></span>
                    <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{s.title}</span><span className="text-[11px] text-muted-foreground">{relativeTime(s.updatedAt)}</span></span>
                  </WorkLink>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-auto space-y-3">
          <SimulatedDataBadge className="hidden px-1 lg:inline-flex" />
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left hover:bg-sidebar-accent">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand">{p ? initials : "?"}</span>
              <span className="hidden min-w-0 flex-1 lg:block">
                <span className="block truncate text-sm font-semibold">{roleLabel(p?.role)}</span>
                <span className="block truncate text-xs text-muted-foreground">{p?.team ?? "Set up your profile"}</span>
              </span>
              <MoreHorizontal className="hidden size-4 text-muted-foreground lg:block" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Switch role · {roleLabel(p?.role)}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={p?.role ?? ""} onValueChange={(v) => p && saveProfile.mutate({ ...p, role: v as Role })}>
                    {ROLE_OPTIONS.map((r) => <DropdownMenuRadioItem key={r.id} value={r.id}>{r.label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit profile</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto" id="main">
        <div className="mx-auto w-full max-w-[1100px] px-6 py-10 md:px-10 md:py-14">{children}</div>
      </main>
      <ProfileDialog open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AUTH_REQUIRED_EVENT, authApi, useAccountAction, useMe, type Me } from "@/api/auth";
import { IS_MOCK } from "@/config/dataMode";
import { ErrorState, Logo } from "./primitives";

const field = "h-11 w-full rounded-lg border bg-card px-3 text-sm outline-none focus:border-foreground/40";

/** Shows the app only to a signed-in person. The demo (mock) build has no accounts and skips this. */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();
  useEffect(() => { // a request came back 401: the session ended, so re-check who is signed in
    const h = () => { qc.clear(); qc.invalidateQueries({ queryKey: ["me"] }); };
    window.addEventListener(AUTH_REQUIRED_EVENT, h);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, h);
  }, [qc]);
  if (IS_MOCK) return <>{children}</>;
  if (me.isLoading) return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  if (me.isError || !me.data) return <div className="mx-auto max-w-md py-24"><ErrorState message="Couldn't reach the server." onRetry={() => me.refetch()} /></div>;
  if (!me.data.user) return <AuthScreen info={me.data} />;
  if (me.data.user.mustChangePassword) return <ChangePasswordScreen email={me.data.user.email} forced />;
  return <>{children}</>;
}

function AuthScreen({ info }: { info: Me }) {
  const [mode, setMode] = useState<"signin" | "signup">(info.firstRun ? "signup" : "signin");
  const [v, setV] = useState({ name: "", email: "", password: "", setupCode: "" });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const act = useAccountAction(() => mode === "signup"
    ? authApi.signup({ email: v.email, password: v.password, ...(v.name ? { name: v.name } : {}), ...(v.setupCode ? { setupCode: v.setupCode } : {}) })
    : authApi.login({ email: v.email, password: v.password }));
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3"><Logo /><span className="font-display text-xl font-semibold">Research Hub</span></div>
        <div className="rounded-2xl border bg-card p-7">
          <h1 className="font-display text-2xl font-semibold">{mode === "signup" ? (info.firstRun ? "Set up the first account" : "Create your account") : "Sign in"}</h1>
          {info.firstRun && <p className="mt-2 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">You're the first person here, so this account becomes the <span className="font-medium text-foreground">admin</span>. You can promote teammates from the Research data screen.</p>}
          {!info.firstRun && mode === "signup" && info.allowedEmailDomains.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Sign-up is limited to {info.allowedEmailDomains.map((d) => `@${d}`).join(", ")} addresses.</p>}
          <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); act.mutate(undefined); }}>
            {mode === "signup" && <label className="block text-sm font-medium">Name <span className="font-normal text-muted-foreground">(optional)</span><input className={`${field} mt-1.5`} value={v.name} onChange={set("name")} autoComplete="name" /></label>}
            <label className="block text-sm font-medium">Email<input type="email" required className={`${field} mt-1.5`} value={v.email} onChange={set("email")} autoComplete="email" /></label>
            <label className="block text-sm font-medium">Password<input type="password" required minLength={mode === "signup" ? 10 : 1} className={`${field} mt-1.5`} value={v.password} onChange={set("password")} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
              {mode === "signup" && <span className="mt-1 block text-xs font-normal text-muted-foreground">At least 10 characters. A few random words works well.</span>}</label>
            {mode === "signup" && info.firstRun && info.setupCodeRequired && <label className="block text-sm font-medium">Setup code<input className={`${field} mt-1.5`} value={v.setupCode} onChange={set("setupCode")} autoComplete="off" /></label>}
            {act.isError && <p role="alert" className="text-sm text-risk">{(act.error as Error).message}</p>}
            <Button type="submit" className="h-11 w-full rounded-full" disabled={act.isPending}>{act.isPending ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}</Button>
          </form>
          {!info.firstRun && (
            <p className="mt-5 text-center text-sm text-muted-foreground">
              {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
              <button className="font-medium text-foreground underline underline-offset-2" onClick={() => { act.reset(); setMode(mode === "signin" ? "signup" : "signin"); }}>{mode === "signin" ? "Create an account" : "Sign in"}</button>
            </p>
          )}
          {mode === "signin" && <p className="mt-3 text-center text-xs text-muted-foreground">Forgot your password? Ask a research team admin to reset it.</p>}
        </div>
      </div>
    </div>
  );
}

function ChangePasswordForm({ onDone, forced }: { onDone?: () => void; forced?: boolean }) {
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const act = useAccountAction(() => authApi.changePassword({ currentPassword: cur, newPassword: next }));
  useEffect(() => { if (act.isSuccess) onDone?.(); }, [act.isSuccess, onDone]);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); act.mutate(undefined); }}>
      <label className="block text-sm font-medium">{forced ? "Temporary password" : "Current password"}<input type="password" required className={`${field} mt-1.5`} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
      <label className="block text-sm font-medium">New password<input type="password" required minLength={10} className={`${field} mt-1.5`} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /><span className="mt-1 block text-xs font-normal text-muted-foreground">At least 10 characters. You'll be signed out on your other devices.</span></label>
      {act.isError && <p role="alert" className="text-sm text-risk">{(act.error as Error).message}</p>}
      <Button type="submit" className="h-11 w-full rounded-full" disabled={act.isPending}>{act.isPending ? "Saving…" : "Change password"}</Button>
    </form>
  );
}

function ChangePasswordScreen({ email }: { email: string; forced?: boolean }) {
  const logout = useAccountAction(() => authApi.logout());
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border bg-card p-7">
        <h1 className="font-display text-2xl font-semibold">Choose a new password</h1>
        <p className="mt-2 mb-5 text-sm text-muted-foreground">{email} is using a temporary password from an admin. Set your own to continue.</p>
        <ChangePasswordForm forced />
        <button className="mt-4 w-full text-center text-sm text-muted-foreground underline underline-offset-2" onClick={() => logout.mutate(undefined)}>Sign out</button>
      </div>
    </div>
  );
}

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent><DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader><ChangePasswordForm onDone={() => onOpenChange(false)} /></DialogContent>
    </Dialog>
  );
}

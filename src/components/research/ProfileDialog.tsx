import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useProfile, useSaveProfile } from "@/api/hooks";
import { ROLE_OPTIONS } from "@/lib/roleLens";
import type { Role } from "@/types/research";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useProfile();
  const save = useSaveProfile();
  const [role, setRole] = useState<Role>("designer");
  const [team, setTeam] = useState("");
  const [area, setArea] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open && data) { setRole(data.role); setTeam(data.team); setArea(data.area); setNote(data.note ?? ""); }
  }, [open, data]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background sm:max-w-lg">
        <DialogTitle className="font-display text-2xl">Your profile</DialogTitle>
        <DialogDescription>Your role tailors recommendations, not the underlying evidence.</DialogDescription>
        <div className="grid grid-cols-2 gap-2">
          {ROLE_OPTIONS.map((r) => (
            <button key={r.id} type="button" onClick={() => setRole(r.id)} aria-pressed={role === r.id} className={cn("rounded-xl border p-3 text-left text-sm font-medium", role === r.id ? "border-brand bg-brand-soft/50" : "bg-card")}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          <div><Label htmlFor="p-team">Team or product</Label><Input id="p-team" value={team} onChange={(e) => setTeam(e.target.value)} /></div>
          <div><Label htmlFor="p-area">Area of work</Label><Input id="p-area" value={area} onChange={(e) => setArea(e.target.value)} /></div>
          <div><Label htmlFor="p-note">Anything else?</Label><Textarea id="p-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <Button className="rounded-full" disabled={!team.trim() || !area.trim() || save.isPending} onClick={() => save.mutate({ role, team, area, note }, { onSuccess: () => { toast.success("Profile saved"); onOpenChange(false); } })}>
          Save profile
        </Button>
      </DialogContent>
    </Dialog>
  );
}

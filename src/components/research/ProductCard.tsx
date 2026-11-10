import { useEffect, useState } from "react";
import { ShoppingBag, Timer, Footprints } from "lucide-react";
import type { Annotation } from "@/types/research";
import { cn } from "@/lib/utils";
import { signalDot } from "./primitives";

// Local sample prototype: ShopEasy product card. Elements are real DOM so they can be annotated.
export function ProductCard({
  annotations,
  activeId,
  onSelect,
}: {
  annotations?: Annotation[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const [secs, setSecs] = useState(8 * 60 + 42);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);
  const mmss = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const ann = (el: Annotation["element"]) => annotations?.find((a) => a.element === el);
  const Marker = ({ el }: { el: Annotation["element"] }) => {
    const a = ann(el);
    if (!a) return null;
    const i = annotations!.indexOf(a) + 1;
    return (
      <button
        type="button"
        onClick={() => onSelect?.(a.id)}
        aria-label={`Annotation ${i}: ${a.title}`}
        className={cn(
          "absolute -right-3 -top-3 z-10 grid size-7 place-items-center rounded-full border-2 border-card text-xs font-bold text-primary-foreground shadow-md transition",
          signalDot(a.signal),
          activeId === a.id && "scale-125 ring-2 ring-foreground",
        )}
      >
        {i}
      </button>
    );
  };
  const ring = (el: Annotation["element"]) => ann(el) && activeId === ann(el)!.id && "outline-2 outline-dashed outline-offset-4 outline-foreground/60";

  return (
    <div className="mx-auto w-full max-w-[300px] overflow-visible rounded-[28px] border-[6px] border-foreground/90 bg-card shadow-xl">
      <div className="flex items-center justify-between px-4 pb-2 pt-3 text-[11px] font-semibold">
        <span>ShopEasy</span><ShoppingBag className="size-4" />
      </div>
      <div className="relative mx-3 grid aspect-square place-items-center rounded-2xl bg-gradient-to-br from-secondary to-accent">
        <Footprints className="size-24 text-foreground/25" aria-hidden />
        <span className="absolute left-3 top-3 rounded-full bg-card px-2 py-0.5 text-[10px] font-semibold">Product image</span>
      </div>
      <div className="space-y-2 p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Urban Step</p>
        <p className="font-display text-lg font-semibold leading-tight">Cloudwalk Everyday</p>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={cn("relative text-2xl font-bold tabular-nums", ring("price"))}>₹899<Marker el="price" /></span>
          <span className={cn("relative text-sm text-muted-foreground line-through tabular-nums", ring("original_price"))}>₹1,499<Marker el="original_price" /></span>
          <span className="rounded-md bg-strong-soft px-1.5 py-0.5 text-xs font-semibold text-strong">Save ₹600</span>
        </div>
        <div className={cn("relative flex items-center gap-2 rounded-lg bg-risk px-3 py-2 text-xs font-semibold text-primary-foreground", ring("countdown"))}>
          <Timer className="size-3.5" /> Offer ends in <span className="tabular-nums">{mmss}</span>
          <Marker el="countdown" />
        </div>
        <button type="button" className="mt-1 w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground">Add to cart</button>
      </div>
    </div>
  );
}

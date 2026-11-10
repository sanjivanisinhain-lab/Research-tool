import type { NextFunction, Request, Response } from "express";

/** Sliding-window counter per key. In memory: fine for a single server process. */
export function slidingWindow(windowMs: number, max: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Records an attempt. Returns how long to wait if the key is over its limit. */
    take(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) }; }
      recent.push(now); hits.set(key, recent);
      if (hits.size > 20_000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k); // keep memory bounded
      return { ok: true, retryAfterSec: 0 };
    },
  };
}

/** Express middleware: at most `max` requests per `windowMs` per key (default: signed-in user, else address). */
export function rateLimit(windowMs: number, max: number, keyOf: (req: Request) => string = (r) => r.user?.id ?? r.ip ?? "anon") {
  const w = slidingWindow(windowMs, max);
  return (req: Request, res: Response, next: NextFunction) => {
    const r = w.take(keyOf(req));
    if (r.ok) return next();
    res.setHeader("Retry-After", String(r.retryAfterSec));
    res.status(429).json({ error: `Too many requests. Try again in ${r.retryAfterSec < 90 ? `${r.retryAfterSec} seconds` : `${Math.ceil(r.retryAfterSec / 60)} minutes`}.` });
  };
}

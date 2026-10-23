// A8 RateLimiter — per-IP fixed-window failure counter with lockout: a window
// starts at the first failure and resets once windowMs elapses (not a true
// sliding window). In-memory only (cleared on restart); expired entries are
// pruned at most once per window.
// Injected clock for tests.
export interface RateLimiter { record(ip: string): void; isLocked(ip: string): boolean; size(): number; }

interface Entry { count: number; windowStart: number; lockedUntil: number; }

export function createRateLimiter(opts: {
  windowMs?: number; maxFailures?: number; lockMs?: number;
  now: () => number; onLock?: (ip: string) => void;
}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxFailures = opts.maxFailures ?? 10;
  const lockMs = opts.lockMs ?? 300_000;
  const map = new Map<string, Entry>();
  let lastPrune = 0;
  return {
    record(ip) {
      const t = opts.now();
      if (t - lastPrune >= windowMs) {
        lastPrune = t;
        for (const [k, v] of map) if (t - v.windowStart > windowMs && v.lockedUntil <= t) map.delete(k);
      }
      let e = map.get(ip);
      if (!e || t - e.windowStart > windowMs) { e = { count: 0, windowStart: t, lockedUntil: 0 }; map.set(ip, e); }
      e.count++;
      if (e.count >= maxFailures && e.lockedUntil <= t) {
        e.lockedUntil = t + lockMs;
        opts.onLock?.(ip);
      }
    },
    isLocked(ip) {
      const e = map.get(ip);
      if (!e) return false;
      return e.lockedUntil > opts.now();
    },
    size() { return map.size; },
  };
}

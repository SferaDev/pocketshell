// A tab activation re-sends this device's size only when another device may
// own the shared tmux window: the agent reports a different size, or this
// device has not re-asserted its size for a while (the reported size can lag).
export const ACTIVATE_RESEND_MS = 60_000;

export function shouldForceActivationResize(p: {
  server: { cols: number; rows: number };
  lastSent: { cols: number; rows: number };
  lastForcedAt: number;
  now: number;
}): boolean {
  const known = p.server.cols > 0 && p.server.rows > 0;
  if (known && (p.server.cols !== p.lastSent.cols || p.server.rows !== p.lastSent.rows)) return true;
  return p.now - p.lastForcedAt > ACTIVATE_RESEND_MS;
}

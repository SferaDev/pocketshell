import { describe, expect, it } from "vitest";
import { ACTIVATE_RESEND_MS, shouldForceActivationResize } from "./activation-resize";

const base = { server: { cols: 66, rows: 33 }, lastSent: { cols: 66, rows: 33 }, lastForcedAt: 1_000, now: 2_000 };

describe("shouldForceActivationResize", () => {
  it("skips the resize when the agent already has this device's size", () => {
    expect(shouldForceActivationResize(base)).toBe(false);
  });

  it("re-sends when another device resized the shared window", () => {
    expect(shouldForceActivationResize({ ...base, server: { cols: 120, rows: 40 } })).toBe(true);
    expect(shouldForceActivationResize({ ...base, server: { cols: 66, rows: 20 } })).toBe(true);
  });

  it("re-sends on the first activation, when nothing was sent yet", () => {
    expect(shouldForceActivationResize({ ...base, lastSent: { cols: 0, rows: 0 }, lastForcedAt: Number.NEGATIVE_INFINITY })).toBe(true);
  });

  it("re-sends after a while even if the reported size matches, in case it is stale", () => {
    expect(shouldForceActivationResize({ ...base, now: base.lastForcedAt + ACTIVATE_RESEND_MS + 1 })).toBe(true);
  });

  it("falls back to the age check when the agent reported no size", () => {
    expect(shouldForceActivationResize({ ...base, server: { cols: 0, rows: 0 } })).toBe(false);
    expect(shouldForceActivationResize({ ...base, server: { cols: 0, rows: 0 }, now: base.lastForcedAt + ACTIVATE_RESEND_MS + 1 })).toBe(true);
  });
});

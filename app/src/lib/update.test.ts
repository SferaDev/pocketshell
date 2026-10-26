import { describe, it, expect } from "vitest";
import { phaseLabelKey, hasUpdate, compareSemver, shouldReloadAfterUpdate, shouldReloadForVersion } from "./update";

describe("update pure logic", () => {
  it("phaseLabelKey maps each phase", () => {
    expect(phaseLabelKey("downloading")).toBe("update.phase.downloading");
    expect(phaseLabelKey("error")).toBe("update.phase.error");
    expect(phaseLabelKey("weird")).toBe("update.phase.working");
  });
  it("hasUpdate/compareSemver", () => {
    expect(compareSemver("0.3.0", "0.4.0")).toBe(-1);
    expect(hasUpdate("0.3.0", "0.4.0")).toBe(true);
    expect(hasUpdate("0.4.0", "0.4.0")).toBe(false);
  });
});

describe("shouldReloadAfterUpdate", () => {
  it("reloads when an update was in flight and the agent moved to a new version", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.2", "restarting")).toBe(true);
  });

  it("does not reload when the version did not move (supervisor rolled back)", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.1", "restarting")).toBe(false);
  });

  it("does not reload on a plain reconnect with no update in flight", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "1.0.2", null)).toBe(false);
  });

  it("does not reload when the agent version is unknown", () => {
    expect(shouldReloadAfterUpdate("1.0.1", "", "restarting")).toBe(false);
  });
});

describe("shouldReloadForVersion", () => {
  it("reloads a page whose build differs from the agent's", () => {
    expect(shouldReloadForVersion("1.0.0-aaa", "1.0.0-bbb", null)).toBe(true);
  });
  it("leaves a matching page alone", () => {
    expect(shouldReloadForVersion("1.0.0-aaa", "1.0.0-aaa", null)).toBe(false);
  });
  it("leaves the page alone when the agent does not report a version", () => {
    expect(shouldReloadForVersion("1.0.0-aaa", undefined, null)).toBe(false);
  });
  it("reloads only once per agent version, so a persistent mismatch cannot loop", () => {
    expect(shouldReloadForVersion("1.0.0-aaa", "1.0.0-bbb", "1.0.0-bbb")).toBe(false);
    expect(shouldReloadForVersion("1.0.0-aaa", "1.0.0-ccc", "1.0.0-bbb")).toBe(true);
  });
});

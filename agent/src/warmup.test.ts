import { test, expect } from "bun:test";
import { runWarmup } from "./warmup";
import { buildFdaGuidance } from "./readiness";

const okTmux = (calls?: string[][]) => (args: string[]) => {
  calls?.push(args);
  return { exitCode: 0 };
};

test("non-darwin is a full no-op: no probes, no lines", () => {
  let reads = 0;
  let tmuxCalled = false;
  const lines = runWarmup({
    platform: "linux",
    readdir: () => { reads++; return []; },
    tmux: () => { tmuxCalled = true; return { exitCode: 0 }; },
  });
  expect(lines).toEqual([]);
  expect(reads).toBe(0);
  expect(tmuxCalled).toBe(false);
});

test("darwin: never reads Files and Folders dirs, spawns+kills a scratch tmux session", () => {
  const read: string[] = [];
  const tmuxCalls: string[][] = [];
  const lines = runWarmup({
    platform: "darwin",
    home: "/h",
    readdir: (p) => { read.push(p); return []; },
    tmux: okTmux(tmuxCalls),
  });
  expect(read).toEqual(["/h/Library/Safari"]);
  expect(tmuxCalls.some((a) => a[0] === "new-session" && a.includes("-d"))).toBe(true);
  expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(true);
  // Safari readable -> FDA present -> no guidance
  expect(lines).toEqual([]);
});

test("failed Safari probe (no FDA) yields manual FDA guidance lines", () => {
  const lines = runWarmup({
    platform: "darwin",
    home: "/h",
    readdir: (p) => {
      if (p.endsWith("Library/Safari")) throw new Error("EPERM");
      return [];
    },
    tmux: okTmux(),
  });
  expect(lines).toEqual(buildFdaGuidance());
  expect(lines.join("\n")).toContain("Full Disk Access");
  expect(lines.join("\n")).toContain("~/.local/bin/pocketshell-agent");
});

test("tmux failure never throws and never blocks the rest", () => {
  const lines = runWarmup({
    platform: "darwin",
    home: "/h",
    readdir: () => [],
    tmux: () => ({ exitCode: 1 }),
  });
  expect(lines).toEqual([]);
});

test("buildFdaGuidance is honest: no promise of a prompt, points at System Settings", () => {
  const text = buildFdaGuidance().join("\n");
  expect(text).toContain("System Settings");
  expect(text).toContain("Privacy & Security");
  expect(text).toContain("Cmd+Shift+G");
});

test("buildFdaGuidance reads as an optional hint, not an alarm", () => {
  const text = buildFdaGuidance().join("\n").toLowerCase();
  // Framed as opt-in so users who never touch protected paths aren't alarmed.
  expect(text).toContain("optional");
  expect(text).toContain("only if you");
  // No alarm-style "NOT granted / will fail" wording.
  expect(text).not.toContain("not granted");
  expect(text).not.toContain("will fail");
});

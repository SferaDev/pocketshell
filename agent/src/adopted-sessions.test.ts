import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep pane FIFOs out of the real run dir; must precede any TerminalService.
process.env.POCKETSHELL_RUN_DIR = mkdtempSync(join(tmpdir(), "ps-run-"));
import { TerminalService, type TmuxRunner } from "./terminal";
import { loadAdopted } from "./adopted-store";
import { ShellService } from "./shell-service";
import { hasTmux, uniqueSessionName, killSession } from "./test-support";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const res = (code: number, out = "") => ({ exitCode: code, stdout: enc(out), stderr: new Uint8Array() });

// Fake tmux where `alive` is the set of existing sessions; records argv.
function fake(alive: Set<string>, calls: string[][] = []): TmuxRunner {
  return (args) => {
    calls.push(args);
    const t = args[args.indexOf("-t") + 1];
    if (args.includes("has-session")) return res(alive.has(t) ? 0 : 1);
    if (args.includes("new-session")) { alive.add(args[args.indexOf("-s") + 1]); return res(0); }
    if (args.includes("kill-session")) { alive.delete(t); return res(0); }
    if (args.includes("rename-session")) { alive.delete(t); alive.add(args[args.length - 1]); return res(0); }
    return res(args.includes("list-sessions") ? 1 : 0);
  };
}

function setup(alive: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ps-adopted-"));
  const file = join(dir, "adopted-sessions.json");
  const set = new Set(alive);
  const calls: string[][] = [];
  const mk = () => new TerminalService({ tmux: fake(set, calls), langFallback: null, adoptedFile: file });
  return { file, set, calls, mk };
}
const names = (file: string) => loadAdopted(file).map((e) => e.name).sort();

test("ensure writes the adopted file (0600) with name, size and createdAt", () => {
  const { file, mk } = setup();
  const t = mk();
  t.ensure("a", { cols: 100, rows: 30 });
  t.dispose();
  const [e] = loadAdopted(file);
  expect(e).toMatchObject({ name: "a", cols: 100, rows: 30 });
  expect(e.createdAt).toBeGreaterThan(0);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("kill, rename and reap update the file", async () => {
  const { file, set, mk } = setup();
  const t = mk();
  t.ensure("a", {});
  t.ensure("b", {});
  t.ensure("c", {});
  expect(names(file)).toEqual(["a", "b", "c"]);
  await t.kill("a");
  expect(names(file)).toEqual(["b", "c"]);
  t.rename("b", "b2");
  expect(names(file)).toEqual(["b2", "c"]);
  set.delete("c");
  (t as unknown as { reap(n: string, c: number): void }).reap("c", 0);
  expect(names(file)).toEqual(["b2"]);
  t.dispose();
});

test("resize persists the new size", () => {
  const { file, mk } = setup();
  const t = mk();
  t.ensure("a", { cols: 80, rows: 24 });
  t.resize("a", 120, 40);
  t.dispose();
  expect(loadAdopted(file)[0]).toMatchObject({ cols: 120, rows: 40 });
});

test("dispose keeps the file so the next boot can re-adopt", () => {
  const { file, mk } = setup();
  const t = mk();
  t.ensure("a", {});
  t.dispose();
  expect(names(file)).toEqual(["a"]);
});

test("restore re-adopts existing sessions, drops gone ones, never resizes or spawns", async () => {
  const { file, set, calls, mk } = setup();
  const first = mk();
  first.ensure("keep", { cols: 90, rows: 33 });
  first.ensure("gone", {});
  first.dispose();
  set.delete("gone");
  calls.length = 0;

  const second = mk();
  second.restoreAdopted();
  expect(second.has("keep")).toBe(true);
  expect((second as unknown as { sessions: Map<string, unknown> }).sessions.has("keep")).toBe(true);
  expect((second as unknown as { sessions: Map<string, unknown> }).sessions.has("gone")).toBe(false);
  expect(names(file)).toEqual(["keep"]);
  expect(calls.some((a) => a.includes("new-session"))).toBe(false);
  expect(calls.some((a) => a.includes("resize-window"))).toBe(false);
  const meta = (await second.list()).find((s) => s.name === "keep")!;
  expect(meta).toMatchObject({ attached: true, cols: 90, rows: 33 });
  second.dispose();
});

test("malformed, missing and wrong-shape files start empty without throwing", () => {
  for (const body of ["{not json", "[]", '{"sessions":"x"}', '{"sessions":[null,1,{"name":""},{"cols":1}]}', null]) {
    const { file, mk } = setup(["a"]);
    if (body !== null) writeFileSync(file, body);
    const t = mk();
    expect(() => t.restoreAdopted()).not.toThrow();
    expect(t.list()).resolves.toBeDefined();
    expect((t as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    t.dispose();
  }
});

test("without adoptedFile nothing is written or restored", () => {
  const set = new Set(["a"]);
  const t = new TerminalService({ tmux: fake(set), langFallback: null });
  t.ensure("a", {});
  expect(() => t.restoreAdopted()).not.toThrow();
  t.dispose();
});

test("shell sessions are not persisted", () => {
  const { file, mk } = setup();
  const t = mk();
  const sh = new ShellService();
  sh.create("shelly", {});
  expect(existsSync(file)).toBe(false);
  t.ensure("a", {});
  expect(names(file)).toEqual(["a"]);
  sh.dispose();
  t.dispose();
});

test.skipIf(!hasTmux())("real tmux: a restarted service re-adopts a live session without resizing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-adopted-"));
  const file = join(dir, "adopted-sessions.json");
  const NAME = uniqueSessionName("adopt");
  const GONE = uniqueSessionName("adoptgone");
  const first = new TerminalService({ adoptedFile: file });
  try {
    first.ensure(NAME, { cols: 100, rows: 30 });
    first.ensure(GONE, { cols: 100, rows: 30 });
    first.dispose();
    killSession(GONE);
    const size = () => Bun.spawnSync(["tmux", "display-message", "-p", "-t", NAME, "#{window_width}x#{window_height}"]).stdout.toString().trim();
    const before = size();

    const second = new TerminalService({ adoptedFile: file });
    second.restoreAdopted();
    const list = await second.list();
    expect(list.find((s) => s.name === NAME)?.attached).toBe(true);
    expect(list.some((s) => s.name === GONE)).toBe(false);
    expect(names(file)).toEqual([NAME]);
    expect(size()).toBe(before);
    second.dispose();
  } finally {
    killSession(NAME);
    killSession(GONE);
  }
});

// Fake tmux for a restored session whose window option reads `windowSize` and whose
// one real client was last active at `activity` (unix seconds).
function restoredWindow(windowSize: string, activity: () => number) {
  const { file, set, mk: _mk } = setup(["work"]);
  const first = _mk();
  first.ensure("work", { cols: 72, rows: 35 });
  first.dispose();
  const calls: string[][] = [];
  const base = fake(set, calls);
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "show-options") { calls.push(args); return res(0, windowSize); }
    if (args[0] === "display-message") { calls.push(args); return res(0, "@4\n"); }
    if (args.includes("list-clients")) { calls.push(args); return res(0, `${activity()}\twork\n`); }
    return base(args);
  };
  let t = 1_000_000;
  const svc = new TerminalService({ tmux, langFallback: null, adoptedFile: file, now: () => t });
  return { svc, calls, advance: (ms: number) => { t += ms; } };
}
const unsets = (calls: string[][]) => calls.filter((a) => a[0] === "set-option" && a.includes("-uw"));

test("restore reclaims a window left pinned before a restart and releases it on later client activity", async () => {
  let act = 1000;
  const { svc, calls, advance } = restoredWindow("manual\n", () => act);
  svc.restoreAdopted();
  await svc.arbitrateWindows();
  expect(unsets(calls)).toEqual([]);
  advance(5000);
  act = 1005;
  await svc.arbitrateWindows();
  expect(unsets(calls)).toEqual([["set-option", "-uw", "-t", "@4", "window-size"]]);
  svc.dispose();
});

test("restore leaves a window tmux sizes itself untracked", async () => {
  const { svc, calls, advance } = restoredWindow("", () => 9999);
  svc.restoreAdopted();
  advance(5000);
  await svc.arbitrateWindows();
  svc.releaseWindow("work");
  expect(unsets(calls)).toEqual([]);
  svc.dispose();
});

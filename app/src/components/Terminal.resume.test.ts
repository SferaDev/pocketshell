import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import type { Terminal as XTerm } from "@xterm/xterm";
import Terminal from "./Terminal.svelte";
import { toB64 } from "../lib/bytes";

type OutputFrame = { sessionId: string; seq: number; data: Uint8Array };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const enc = (s: string) => new TextEncoder().encode(s);

// Mirrors Connection's resume bookkeeping: seen follows output, resume() overrides it.
function stubConn(opts: { features?: string[]; history?: () => Promise<{ data: string; seq: number }> } = {}) {
  const features = new Set(opts.features ?? ["resume"]);
  const outputCbs: Array<(frame: OutputFrame) => void> = [];
  const missCbs: Array<(id: string, seed?: Promise<unknown>) => void> = [];
  const seen = new Map<string, number>();
  let historySeq = 3;
  const conn = {
    attach: vi.fn(),
    detach: vi.fn(),
    resize: vi.fn(),
    resume: vi.fn((id: string, seq: number) => { seen.set(id, seq); return true; }),
    hasFeature: (n: string) => features.has(n),
    seenSeq: (id: string) => seen.get(id) ?? 0,
    onResumeMiss: (cb: (id: string, seed?: Promise<unknown>) => void) => { missCbs.push(cb); return () => {}; },
    rpc: vi.fn((method: string) => {
      if (method === "term.history") {
        return opts.history?.() ?? Promise.resolve({ data: toB64(enc(`history-${historySeq}\n`)), seq: historySeq });
      }
      if (method === "term.paneInfo") return Promise.resolve({ currentCommand: "zsh", alternateOn: false, isShell: true });
      return Promise.resolve({});
    }),
    onOutput: (cb: (frame: OutputFrame) => void) => { outputCbs.push(cb); return () => {}; },
    onInput: () => () => {},
    emit(sessionId: string, text: string, seq: number) {
      if (seq > (seen.get(sessionId) ?? 0)) seen.set(sessionId, seq);
      for (const cb of outputCbs) cb({ sessionId, seq, data: enc(text) });
    },
    miss(sessionId: string, seed?: Promise<unknown>) { for (const cb of missCbs) cb(sessionId, seed); },
    setHistorySeq(n: number) { historySeq = n; },
  };
  return conn;
}

const historyCalls = (conn: ReturnType<typeof stubConn>) =>
  conn.rpc.mock.calls.filter((call) => call[0] === "term.history").length;

function screenText(term: XTerm): string {
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

const flushWrites = (term: XTerm) => new Promise<void>((resolve) => term.write("", resolve));

let originalMatchMedia: typeof window.matchMedia;
beforeAll(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  });
});
afterAll(() => { window.matchMedia = originalMatchMedia; });

async function mountSeeded(conn: ReturnType<typeof stubConn>) {
  let term: XTerm | undefined;
  const props = {
    conn: conn as any, sessionId: "A", active: true, streaming: true,
    onReady: (_id: string, value: XTerm) => { term = value; },
  };
  const view = render(Terminal, { props });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 3, { seed: true }));
  return { ...view, props, term: () => term! };
}

test("returning to a detached tab replays the gap instead of fetching history", async () => {
  const conn = stubConn();
  const { rerender, props, term } = await mountSeeded(conn);
  conn.emit("A", "live-4\r\n", 4);
  await rerender({ ...props, active: false, streaming: true });
  conn.emit("A", "stashed-5\r\n", 5);
  await rerender({ ...props, active: false, streaming: false });
  conn.emit("A", "in-flight-6\r\n", 6); // arrives after detach: dropped here, replayed by the agent

  await rerender({ ...props, active: true, streaming: true });
  await tick();
  expect(historyCalls(conn)).toBe(1);
  expect(conn.resume).toHaveBeenCalledWith("A", 5, expect.objectContaining({ lines: expect.any(Number) }));
  conn.emit("A", "in-flight-6\r\n", 6);
  conn.emit("A", "replayed-7\r\n", 7);
  await flushWrites(term());

  const text = screenText(term());
  const order = ["history-3", "live-4", "stashed-5", "in-flight-6", "replayed-7"].map((s) => text.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(text.split("in-flight-6").length).toBe(2);
});

test("a resume miss falls back to the offline snapshot and seeded attach", async () => {
  const conn = stubConn();
  const { rerender, props, term } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: false });
  conn.setHistorySeq(40);

  await rerender({ ...props, active: true, streaming: true });
  await tick();
  expect(conn.resume).toHaveBeenCalledTimes(1);
  expect(historyCalls(conn)).toBe(1);
  conn.attach.mockClear();

  conn.miss("A");
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 40, { seed: true }));
  expect(historyCalls(conn)).toBe(2);
  await flushWrites(term());
  expect(screenText(term())).toContain("history-40");
});

test("a seeded resume miss writes the agent's snapshot without another history request", async () => {
  const conn = stubConn();
  const { rerender, props, term } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: false });
  await rerender({ ...props, active: true, streaming: true });
  await tick();
  conn.attach.mockClear();

  conn.miss("A", Promise.resolve({ data: toB64(enc("seeded-50\n")), seq: 50 }));
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 50, { seed: true }));
  expect(historyCalls(conn)).toBe(1);
  await flushWrites(term());
  expect(screenText(term())).toContain("seeded-50");
});

test("an agent without the resume feature keeps the history reseed", async () => {
  const conn = stubConn({ features: [] });
  const { rerender, props } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: false });
  conn.setHistorySeq(9);
  await rerender({ ...props, active: true, streaming: true });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 9, { seed: true }));
  expect(conn.resume).not.toHaveBeenCalled();
  expect(historyCalls(conn)).toBe(2);
});

test("a stash too large to keep is not resumable", async () => {
  const conn = stubConn();
  const { rerender, props } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: true });
  conn.emit("A", "x".repeat(256 * 1024 + 1), 4);
  await rerender({ ...props, active: false, streaming: false });
  conn.setHistorySeq(9);
  await rerender({ ...props, active: true, streaming: true });
  await waitFor(() => expect(conn.attach).toHaveBeenCalledWith("A", 9, { seed: true }));
  expect(conn.resume).not.toHaveBeenCalled();
});

test("a stale miss after the tab stopped again is ignored", async () => {
  const conn = stubConn();
  const { rerender, props } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: false });
  await rerender({ ...props, active: true, streaming: true });
  await rerender({ ...props, active: false, streaming: false });
  conn.miss("A");
  await tick();
  expect(historyCalls(conn)).toBe(1);
});

test("resuming while hidden keeps stashing and flushes in order on activation", async () => {
  const conn = stubConn();
  const { rerender, props, term } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: true });
  conn.emit("A", "stashed-4\r\n", 4);
  await rerender({ ...props, active: false, streaming: false });
  await rerender({ ...props, active: false, streaming: true });
  expect(conn.resume).toHaveBeenCalledWith("A", 4, expect.anything());
  conn.emit("A", "replayed-5\r\n", 5);
  expect(screenText(term())).not.toContain("stashed-4");

  await rerender({ ...props, active: true, streaming: true });
  await flushWrites(term());
  const text = screenText(term());
  expect(text.indexOf("stashed-4")).toBeGreaterThan(-1);
  expect(text.indexOf("replayed-5")).toBeGreaterThan(text.indexOf("stashed-4"));
  expect(historyCalls(conn)).toBe(1);
});

// pipe-pane carries the pane's own ?1049h/?1049l, so an alt-screen session in the gap replays like a live stream.
test("alt-screen enter and exit inside the gap leave the normal buffer as a live stream would", async () => {
  const conn = stubConn();
  const { rerender, props, term } = await mountSeeded(conn);
  await rerender({ ...props, active: false, streaming: true });
  conn.emit("A", "\x1b[?1049h\x1b[HVIM-SCREEN", 4);
  await rerender({ ...props, active: false, streaming: false });

  await rerender({ ...props, active: true, streaming: true });
  expect(conn.resume).toHaveBeenCalledWith("A", 4, expect.anything());
  await flushWrites(term());
  expect(term().buffer.active.type).toBe("alternate");
  expect(screenText(term())).toContain("VIM-SCREEN");

  conn.emit("A", "\x1b[HVIM-REDRAW\x1b[?1049lafter-vim\r\n", 5);
  await flushWrites(term());
  expect(term().buffer.active.type).toBe("normal");
  const text = screenText(term());
  expect(text).toContain("history-3");
  expect(text).toContain("after-vim");
  expect(text).not.toContain("VIM");
});

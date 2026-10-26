import { test, expect } from "bun:test";
import { OutputBatcher } from "./output-batcher";

const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);

// Manual clock: setTimeout callbacks are captured, never run until fireAll().
function fakeClock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    setTimeout: (fn: () => void, _ms: number) => { const id = next++; timers.set(id, fn); return id; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    fireAll: () => { const fns = [...timers.values()]; timers.clear(); for (const f of fns) f(); },
    pending: () => timers.size,
  };
}

function harness(opts: { flushBytes?: number; flushMs?: number } = {}) {
  const clock = fakeClock();
  const flushed: { sessionId: string; data: Uint8Array }[] = [];
  const batcher = new OutputBatcher((sessionId, data) => flushed.push({ sessionId, data }), {
    flushBytes: opts.flushBytes ?? 8,
    flushMs: opts.flushMs ?? 8,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  // Spend each session's leading-edge flush so later pushes land inside a window.
  const prime = (...ids: string[]) => {
    for (const id of ids) batcher.push(id, b("!"));
    flushed.length = 0;
  };
  return { clock, flushed, batcher, prime };
}

test("a lone chunk after a quiet window is flushed immediately (leading edge)", () => {
  const { clock, flushed, batcher } = harness();
  batcher.push("s", b("a"));
  expect(flushed.map((f) => Buffer.from(f.data).toString())).toEqual(["a"]);
  expect(clock.pending()).toBe(0);
  clock.advance(8);
  batcher.push("s", b("b"));
  expect(flushed.length).toBe(2);
  expect(clock.pending()).toBe(0);
});

test("a burst right after a leading flush coalesces into one windowed batch", () => {
  const { clock, flushed, batcher } = harness();
  batcher.push("s", b("a"));
  clock.advance(1);
  batcher.push("s", b("b"));
  batcher.push("s", b("c"));
  expect(flushed.length).toBe(1);
  expect(clock.pending()).toBe(1);
  clock.advance(8);
  clock.fireAll();
  expect(flushed.map((f) => Buffer.from(f.data).toString())).toEqual(["a", "bc"]);
});

test("a windowed flush counts as recent: the next chunk inside flushMs waits", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("s");
  batcher.push("s", b("x"));
  clock.advance(8);
  clock.fireAll();
  clock.advance(3);
  batcher.push("s", b("y"));
  expect(flushed.map((f) => Buffer.from(f.data).toString())).toEqual(["x"]);
  expect(clock.pending()).toBe(1);
});

test("the leading edge is tracked per session", () => {
  const { flushed, batcher, prime } = harness();
  prime("a");
  batcher.push("a", b("A"));
  batcher.push("b", b("B"));
  expect(flushed.map((f) => f.sessionId)).toEqual(["b"]);
});

test("clear() forgets the last flush, so a reused session id starts on the leading edge", () => {
  const { flushed, batcher, prime } = harness();
  prime("s");
  batcher.clear("s");
  batcher.push("s", b("z"));
  expect(flushed.length).toBe(1);
});

test("small bursts within the window flush as ONE concatenated batch on expiry", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("s");
  batcher.push("s", b("ab"));
  batcher.push("s", b("cd"));
  batcher.push("s", b("e"));
  expect(flushed.length).toBe(0); // nothing before the window expires
  clock.fireAll(); // window expires
  expect(flushed.length).toBe(1);
  expect(Buffer.from(flushed[0].data).toString()).toBe("abcde");
  expect(clock.pending()).toBe(0); // timer consumed
});

test("the window is opened by the first byte only — later pushes do not extend it", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("s");
  batcher.push("s", b("a"));
  batcher.push("s", b("b"));
  batcher.push("s", b("c"));
  expect(clock.pending()).toBe(1); // still exactly one timer
  clock.fireAll();
  expect(flushed.length).toBe(1);
});

test("reaching flushBytes flushes immediately, without waiting for the window", () => {
  const { clock, flushed, batcher, prime } = harness({ flushBytes: 8 });
  prime("s");
  batcher.push("s", b("12345"));
  expect(flushed.length).toBe(0);
  batcher.push("s", b("678")); // 5+3 = 8 >= flushBytes
  expect(flushed.length).toBe(1);
  expect(Buffer.from(flushed[0].data).toString()).toBe("12345678");
  expect(clock.pending()).toBe(0); // window timer cancelled by the early flush
  clock.fireAll(); // nothing left to fire
  expect(flushed.length).toBe(1);
});

test("a single chunk at/above flushBytes flushes on its own", () => {
  const { clock, flushed, batcher } = harness({ flushBytes: 4 });
  batcher.push("s", b("wxyz"));
  expect(flushed.length).toBe(1);
  expect(clock.pending()).toBe(0);
});

test("batches are isolated per session", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("a", "b");
  batcher.push("a", b("A1"));
  batcher.push("b", b("B1"));
  batcher.push("a", b("A2"));
  batcher.flush("a"); // explicit flush of one session only
  expect(flushed.map((f) => f.sessionId)).toEqual(["a"]);
  expect(Buffer.from(flushed[0].data).toString()).toBe("A1A2");
  clock.fireAll(); // b's own window still fires separately
  expect(flushed.length).toBe(2);
  expect(flushed[1].sessionId).toBe("b");
  expect(Buffer.from(flushed[1].data).toString()).toBe("B1");
});

test("clear() drops buffered bytes and cancels the window (session destroyed)", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("s");
  batcher.push("s", b("tail"));
  batcher.clear("s");
  expect(clock.pending()).toBe(0);
  clock.fireAll();
  expect(flushed.length).toBe(0); // tail bytes never delivered
});

test("flush() on an empty session is a no-op", () => {
  const { flushed, batcher } = harness();
  batcher.flush("nope");
  expect(flushed.length).toBe(0);
});

test("clearAll() cancels every pending window", () => {
  const { clock, flushed, batcher, prime } = harness();
  prime("a", "b");
  batcher.push("a", b("x"));
  batcher.push("b", b("y"));
  batcher.clearAll();
  expect(clock.pending()).toBe(0);
  clock.fireAll();
  expect(flushed.length).toBe(0);
});

test("a single-chunk batch is passed through without copying", () => {
  const { flushed, batcher, prime } = harness();
  prime("s");
  const chunk = b("solo");
  batcher.push("s", chunk);
  batcher.flush("s");
  expect(flushed[0].data).toBe(chunk); // same reference — no concat copy
});

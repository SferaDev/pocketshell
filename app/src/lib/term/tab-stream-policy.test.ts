import { describe, expect, test } from "vitest";
import { graceExpiryIsCurrent, KEEP_RECENT_STREAMS, stopStream, switchStream, type StreamPolicyState } from "./tab-stream-policy";

const st = (current: string | null, recent: string[] = [], grace: string | null = null): StreamPolicyState =>
  ({ current, recent, grace });

describe("switchStream", () => {
  test("keeps the previous terminal streaming as recent when selecting another terminal", () => {
    expect(switchStream(st("A"), "B")).toEqual({
      state: st("B", ["A"]),
      stream: ["B", "A"],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("switching back and forth never detaches either terminal", () => {
    let state = st("A");
    for (const next of ["B", "A", "B", "A"]) {
      const t = switchStream(state, next);
      expect(t.detachNow).toEqual([]);
      expect(t.scheduleDetach).toBeNull();
      state = t.state;
    }
    expect(state).toEqual(st("A", ["B"]));
  });

  test("keeps the last two used terminals streaming besides the current one", () => {
    expect(KEEP_RECENT_STREAMS).toBe(2);
    expect(switchStream(st("B", ["A"]), "C")).toEqual({
      state: st("C", ["B", "A"]),
      stream: ["C", "B", "A"],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("gives the grace window to the terminal that falls out of the recent set", () => {
    expect(switchStream(st("C", ["B", "A"]), "D")).toEqual({
      state: st("D", ["C", "B"], "A"),
      stream: ["D", "C", "B", "A"],
      detachNow: [],
      scheduleDetach: "A",
    });
  });

  test("immediately detaches an older grace terminal when another one falls out", () => {
    expect(switchStream(st("D", ["C", "B"], "A"), "E")).toEqual({
      state: st("E", ["D", "C"], "B"),
      stream: ["E", "D", "C", "B"],
      detachNow: ["A"],
      scheduleDetach: "B",
    });
  });

  test("reactivates the grace terminal without detaching anything", () => {
    expect(switchStream(st("D", ["C", "B"], "A"), "A")).toEqual({
      state: st("A", ["D", "C"], "B"),
      stream: ["A", "D", "C", "B"],
      detachNow: [],
      scheduleDetach: "B",
    });
  });

  test("selecting a recent terminal reorders the recent set", () => {
    expect(switchStream(st("C", ["B", "A"]), "A")).toEqual({
      state: st("A", ["C", "B"]),
      stream: ["A", "C", "B"],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("keeps the current terminal streaming when selecting a file tab", () => {
    expect(switchStream(st("A"), null)).toEqual({
      state: st(null, ["A"]),
      stream: ["A"],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("does nothing when selecting the already-current terminal", () => {
    const previous = st("A", ["B"]);
    expect(switchStream(previous, "A")).toEqual({
      state: previous,
      stream: [],
      detachNow: [],
      scheduleDetach: null,
    });
  });

  test("never duplicates a terminal or keeps more than current, recent and grace", () => {
    const transition = switchStream(st("A", ["A", "B", "C"], "A"), "D");

    expect(new Set(transition.stream).size).toBe(transition.stream.length);
    expect(transition.stream.length).toBeLessThanOrEqual(KEEP_RECENT_STREAMS + 2);
  });

  test("honours a custom recent limit", () => {
    expect(switchStream(st("B", ["A"]), "C", 1)).toEqual({
      state: st("C", ["B"], "A"),
      stream: ["C", "B", "A"],
      detachNow: [],
      scheduleDetach: "A",
    });
  });
});

describe("graceExpiryIsCurrent", () => {
  const captured = { sessionId: "A", generation: 4 };

  test("accepts the current grace timer for an inactive streamed session", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: st("B", [], "A"),
      generation: 4,
      streaming: new Set(["B", "A"]),
    })).toBe(true);
  });

  test.each([
    ["renamed", st("B", [], "renamed-A"), new Set(["B", "renamed-A"])],
    ["closed", st("B"), new Set(["B"])],
  ])("rejects a %s grace session", (_reason, state, streaming) => {
    expect(graceExpiryIsCurrent(captured, { state, generation: 4, streaming })).toBe(false);
  });

  test("rejects a reactivated grace session", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: st("A", [], "B"),
      generation: 4,
      streaming: new Set(["A", "B"]),
    })).toBe(false);
  });

  test("rejects a stale timer generation", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: st("B", [], "A"),
      generation: 5,
      streaming: new Set(["B", "A"]),
    })).toBe(false);
  });

  test("rejects a session that was already removed from the stream", () => {
    expect(graceExpiryIsCurrent(captured, {
      state: st("B", [], "A"),
      generation: 4,
      streaming: new Set(["B"]),
    })).toBe(false);
  });
});

describe("App focus entry path projection", () => {
  test.each([
    ["click terminal -> terminal", st("A"), "B", st("B", ["A"]), ["B", "A"]],
    ["terminal -> file", st("A"), null, st(null, ["A"]), ["A"]],
    ["file -> terminal", st(null, ["A"]), "B", st("B", ["A"]), ["B", "A"]],
    ["new terminal activation", st("A"), "new", st("new", ["A"]), ["new", "A"]],
    ["close current and select successor", st(null, ["B"]), "B", st("B"), ["B"]],
  ] as const)("%s", (_path, previous, next, state, stream) => {
    const transition = switchStream({ ...previous, recent: [...previous.recent] }, next);
    expect(transition.state).toEqual(state);
    expect(transition.stream).toEqual(stream);
  });
});

describe("stopStream", () => {
  test("removes a current session from state and streaming before detaching it", () => {
    expect(stopStream(st("A", [], "B"), "A")).toEqual({
      state: st(null, [], "B"),
      stream: ["B"],
      detachNow: ["A"],
      preserveGraceTimer: false,
    });
  });

  test("removes a grace session from state and streaming before detaching it", () => {
    expect(stopStream(st("A", [], "B"), "B")).toEqual({
      state: st("A"),
      stream: ["A"],
      detachNow: ["B"],
      preserveGraceTimer: false,
    });
  });

  test("removes a recent session from state and streaming before detaching it", () => {
    expect(stopStream(st("A", ["B", "C"]), "B")).toEqual({
      state: st("A", ["C"]),
      stream: ["A", "C"],
      detachNow: ["B"],
      preserveGraceTimer: false,
    });
  });

  test("preserves the live grace timer when stopping an unrelated session", () => {
    const previous = st("A", ["C"], "B");
    const stop = stopStream(previous, "D");

    expect(stop).toEqual({
      state: previous,
      stream: [],
      detachNow: ["D"],
      preserveGraceTimer: true,
    });
    expect(stop.state).toBe(previous);
  });
});

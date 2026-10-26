import { describe, expect, it } from "vitest";
import {
  MAX_STEPS_PER_FRAME,
  dragToWheelSteps,
  isVerticalDrag,
  newWheelState,
  pointToCell,
  sgrWheelSequence,
  x10WheelSequence,
} from "./alt-scroll";

describe("dragToWheelSteps", () => {
  it("accumulates sub-line drags until a full line is crossed", () => {
    const s = newWheelState();
    expect(dragToWheelSteps(s, 5, 20)).toBe(0);
    expect(dragToWheelSteps(s, 5, 20)).toBe(0);
    expect(dragToWheelSteps(s, 12, 20)).toBe(-1);
    expect(s.acc).toBeCloseTo(2);
  });
  it("finger down is wheel up (negative), finger up is wheel down", () => {
    expect(dragToWheelSteps(newWheelState(), 45, 20)).toBe(-2);
    expect(dragToWheelSteps(newWheelState(), -45, 20)).toBe(2);
  });
  it("caps one frame and drops the excess", () => {
    const s = newWheelState();
    expect(dragToWheelSteps(s, 2000, 20)).toBe(-MAX_STEPS_PER_FRAME);
    expect(Math.abs(s.acc)).toBeLessThan(20);
  });
  it("ignores bad input", () => {
    expect(dragToWheelSteps(newWheelState(), NaN, 20)).toBe(0);
    expect(dragToWheelSteps(newWheelState(), 50, 0)).toBe(0);
  });
});

describe("pointToCell", () => {
  const g = { left: 10, top: 20, width: 800, height: 480, cols: 80, rows: 24 };
  it("maps to 1-based cells", () => {
    expect(pointToCell(g, 10, 20)).toEqual({ col: 1, row: 1 });
    expect(pointToCell(g, 10 + 10 * 5 + 1, 20 + 20 * 3 + 1)).toEqual({ col: 6, row: 4 });
  });
  it("clamps outside the grid", () => {
    expect(pointToCell(g, -50, -50)).toEqual({ col: 1, row: 1 });
    expect(pointToCell(g, 5000, 5000)).toEqual({ col: 80, row: 24 });
  });
});

describe("sgrWheelSequence", () => {
  it("builds wheel up and down reports", () => {
    expect(sgrWheelSequence(-1, 3, 7)).toBe("\x1b[<64;3;7M");
    expect(sgrWheelSequence(2, 3, 7)).toBe("\x1b[<65;3;7M\x1b[<65;3;7M");
  });
  it("is empty for zero steps", () => {
    expect(sgrWheelSequence(0, 1, 1)).toBe("");
  });
});

describe("x10WheelSequence", () => {
  it("encodes button and 1-based cell with a 32 offset", () => {
    expect(x10WheelSequence(-1, 3, 7)).toBe("\x1b[M" + String.fromCharCode(96, 35, 39));
    expect(x10WheelSequence(1, 1, 1)).toBe("\x1b[M" + String.fromCharCode(97, 33, 33));
    expect(x10WheelSequence(0, 1, 1)).toBe("");
  });
});

describe("isVerticalDrag", () => {
  it("needs slop and vertical dominance", () => {
    expect(isVerticalDrag(0, 3)).toBe(false);
    expect(isVerticalDrag(2, 20)).toBe(true);
    expect(isVerticalDrag(30, 20)).toBe(false);
  });
});

// Touch drag to wheel events for mouse-reporting apps (tmux hides their mouse-mode DECSET from us).
export interface WheelState { acc: number }

export const MAX_STEPS_PER_FRAME = 6;

export function newWheelState(): WheelState {
  return { acc: 0 };
}

/** Finger moving down (dy > 0) reveals earlier content, i.e. wheel up (negative steps). */
export function dragToWheelSteps(state: WheelState, dy: number, lineHeight: number): number {
  if (!Number.isFinite(dy) || !(lineHeight > 0)) return 0;
  state.acc += dy;
  const whole = Math.trunc(state.acc / lineHeight);
  if (whole === 0) return 0;
  const capped = Math.max(-MAX_STEPS_PER_FRAME, Math.min(MAX_STEPS_PER_FRAME, whole));
  state.acc -= whole * lineHeight;
  return -capped;
}

export interface CellGrid { left: number; top: number; width: number; height: number; cols: number; rows: number }

/** 1-based cell under a client point, clamped to the grid. */
export function pointToCell(g: CellGrid, x: number, y: number): { col: number; row: number } {
  const cw = g.width / g.cols;
  const ch = g.height / g.rows;
  const col = Math.floor((x - g.left) / cw) + 1;
  const row = Math.floor((y - g.top) / ch) + 1;
  return {
    col: Math.max(1, Math.min(g.cols, Number.isFinite(col) ? col : 1)),
    row: Math.max(1, Math.min(g.rows, Number.isFinite(row) ? row : 1)),
  };
}

/** SGR wheel reports: button 64 = up, 65 = down; `steps` < 0 is up. Empty when steps is 0. */
export function sgrWheelSequence(steps: number, col: number, row: number): string {
  if (!steps) return "";
  const btn = steps < 0 ? 64 : 65;
  return `\x1b[<${btn};${col};${row}M`.repeat(Math.abs(steps));
}

/** Legacy X10 report (apps that enabled mouse tracking without SGR); coordinates cap at 223. */
export function x10WheelSequence(steps: number, col: number, row: number): string {
  if (!steps) return "";
  const chr = (n: number) => String.fromCharCode(32 + Math.min(223, n));
  return `\x1b[M${chr(steps < 0 ? 64 : 65)}${chr(col)}${chr(row)}`.repeat(Math.abs(steps));
}

/** Vertical-dominant drag test, so horizontal tab swipes keep working. */
export function isVerticalDrag(dx: number, dy: number, slop = 6): boolean {
  return Math.abs(dy) > slop && Math.abs(dy) > Math.abs(dx);
}

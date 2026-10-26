import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, WAKE_IDLE_MS, WAKE_PROBE_MS, type Scheduler, type WebSocketLike } from "./connection";
import { encode } from "./protocol";

// Own file so the document listeners of the many undisposed connections in
// connection.test.ts never see the visibility events fired here.

class FakeWS implements WebSocketLike {
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  // A half-dead socket: close() never lands an onclose on its own.
  constructor(private silentClose = false) {}
  send(d: Uint8Array) { this.sent.push(new TextDecoder().decode(d)); }
  close() { this.closed = true; if (!this.silentClose) this.onclose?.(); }
  fire(raw: string) {
    const b = new TextEncoder().encode(raw);
    const data = new ArrayBuffer(b.byteLength);
    new Uint8Array(data).set(b);
    this.onmessage?.({ data });
  }
}

function passthrough() {
  let state: "handshaking" | "transport" = "handshaking";
  return {
    get state() { return state; },
    start() { return new Uint8Array([1]); },
    receive(frame: Uint8Array) {
      if (state === "handshaking") { state = "transport"; return { status: "handshake" as const, established: true }; }
      return { status: "message" as const, plaintext: frame };
    },
    send: (pt: Uint8Array) => pt,
  };
}

function setup(opts: { silentClose?: boolean } = {}) {
  let t = 0;
  let id = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const sched: Scheduler = {
    setTimeout: (fn, ms) => { const i = id++; timeouts.set(i, { at: t + ms, fn }); return i; },
    clearTimeout: (i) => { timeouts.delete(i); },
    setInterval: () => 0,
    clearInterval: () => {},
    now: () => t,
  };
  const advance = (ms: number) => {
    const target = t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timeouts) if (e[1].at <= target && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      t = due[1].at;
      timeouts.delete(due[0]);
      due[1].fn();
    }
    t = target;
  };
  const sockets: FakeWS[] = [];
  const conn = new Connection({
    url: "ws://x", scheduler: sched, random: () => 0.5,
    wsFactory: () => { const s = new FakeWS(opts.silentClose); sockets.push(s); return s; },
    channelFactory: passthrough, getPairing: () => null,
  });
  const establish = (s: FakeWS) => { s.onopen?.(); s.fire("x"); };
  establish(sockets[0]);
  return { conn, sockets, advance, establish, pings: (s: FakeWS) => s.sent.filter((m) => m.includes('"ping"')).length };
}

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
const becomeVisible = () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); };

const conns: Connection[] = [];
afterEach(() => { for (const c of conns.splice(0)) c.dispose(); visibility = "visible"; });

describe("wake check", () => {
  it("drops a silent socket and reconnects without backoff when the page comes back", () => {
    const h = setup({ silentClose: true });
    conns.push(h.conn);
    expect(h.conn.status).toBe("online");
    h.advance(WAKE_IDLE_MS + 1);
    becomeVisible();
    expect(h.pings(h.sockets[0])).toBe(1);
    h.advance(WAKE_PROBE_MS);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.conn.status).toBe("connecting");
    expect(h.sockets).toHaveLength(2);
  });

  it("keeps a socket that answers the probe", () => {
    const h = setup();
    conns.push(h.conn);
    h.advance(WAKE_IDLE_MS + 1);
    becomeVisible();
    h.advance(100);
    h.sockets[0].fire(encode({ type: "pong" }));
    h.advance(WAKE_PROBE_MS);
    expect(h.sockets[0].closed).toBe(false);
    expect(h.conn.status).toBe("online");
    expect(h.sockets).toHaveLength(1);
  });

  it("does not probe a socket that received something recently", () => {
    const h = setup();
    conns.push(h.conn);
    h.advance(WAKE_IDLE_MS - 1);
    becomeVisible();
    expect(h.pings(h.sockets[0])).toBe(0);
  });

  it("only probes once while a probe is pending", () => {
    const h = setup();
    conns.push(h.conn);
    h.advance(WAKE_IDLE_MS + 1);
    becomeVisible();
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    expect(h.pings(h.sockets[0])).toBe(1);
  });

  it("ignores the event while the page is still hidden", () => {
    const h = setup();
    conns.push(h.conn);
    h.advance(WAKE_IDLE_MS + 1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.pings(h.sockets[0])).toBe(0);
  });

  it("reconnects right away when a socket closes just after the wake", () => {
    const h = setup();
    conns.push(h.conn);
    becomeVisible();
    h.sockets[0].close();
    expect(h.conn.status).toBe("offline");
    h.advance(0);
    expect(h.sockets).toHaveLength(2);
  });

  it("keeps the jittered backoff for drops that are not near a wake", () => {
    const h = setup();
    conns.push(h.conn);
    h.sockets[0].close();
    h.advance(499);
    expect(h.sockets).toHaveLength(1);
    h.advance(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("reconnects at once when the page comes back offline", () => {
    const h = setup();
    conns.push(h.conn);
    h.sockets[0].close();
    expect(h.conn.status).toBe("offline");
    becomeVisible();
    expect(h.sockets).toHaveLength(2);
  });

  it("ignores a late close from the abandoned socket", () => {
    const h = setup({ silentClose: true });
    conns.push(h.conn);
    h.advance(WAKE_IDLE_MS + 1);
    becomeVisible();
    h.advance(WAKE_PROBE_MS);
    h.establish(h.sockets[1]);
    expect(h.conn.status).toBe("online");
    const statuses: string[] = [];
    h.conn.onStatus((s) => statuses.push(s));
    h.sockets[0].onclose?.();
    expect(statuses).toEqual([]);
  });

  it("removes its listeners on dispose", () => {
    const h = setup();
    const spy = vi.spyOn(h.conn, "checkAlive");
    h.conn.dispose();
    becomeVisible();
    expect(spy).not.toHaveBeenCalled();
  });
});

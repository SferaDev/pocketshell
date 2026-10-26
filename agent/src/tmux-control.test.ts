import { test, expect } from "bun:test";
import { CONTROL_SESSION, TmuxControl, controlLine, type ControlSpawner } from "./tmux-control";
import type { TmuxResult } from "./terminal";
import { hasTmux, uniqueSessionName, killSession, waitFor } from "./test-support";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const okResult = (s: string): TmuxResult => ({ exitCode: 0, stdout: new TextEncoder().encode(s), stderr: new Uint8Array() });

// Scripted control stream: records what the client writes and lets the test emit tmux's replies.
function fakeControl() {
  const written: string[] = [];
  let onData: ((t: string) => void) | null = null;
  let onExit: (() => void) | null = null;
  let spawns = 0;
  let alive = false;
  let num = 100;
  const exit = () => { if (alive) { alive = false; onExit?.(); } };
  const spawn: ControlSpawner = (d, e) => {
    spawns++;
    alive = true;
    onData = d;
    onExit = e;
    return { write: (t) => written.push(t), close: exit, kill: exit };
  };
  const block = (lines: string[], ok = true) => {
    const n = num++;
    onData?.(`%begin 1700000000 ${n} 1\n${lines.map((l) => l + "\n").join("")}%${ok ? "end" : "error"} 1700000000 ${n} 1\n`);
  };
  return {
    spawn,
    written,
    get spawns() { return spawns; },
    get alive() { return alive; },
    emit: (t: string) => onData?.(t),
    // Attach-command reply plus the reply to the internal destroy-unattached set-option.
    boot: () => { onData?.("%begin 1700000000 1 0\n%end 1700000000 1 0\n"); block([]); },
    block,
    exit,
  };
}

function harness(opts: { enabled?: () => boolean; now?: () => number; replyTimeoutMs?: number } = {}) {
  const fake = fakeControl();
  const fallbackCalls: string[][] = [];
  const ctl = new TmuxControl({
    spawn: fake.spawn,
    fallback: async (args) => { fallbackCalls.push(args); return okResult("fallback\n"); },
    ...opts,
  });
  return { fake, ctl, fallbackCalls };
}

test("controlLine quotes only what the tmux parser would reinterpret", () => {
  expect(controlLine(["send-keys", "-H", "-t", "dev", "61", "0a"])).toBe("send-keys -H -t dev 61 0a");
  expect(controlLine(["display-message", "-p", "-t", "a b", "#{x}|$HOME"])).toBe("display-message -p -t 'a b' '#{x}|$HOME'");
  expect(controlLine(["rename-session", "it's;"])).toBe("rename-session 'it'\\''s;'");
  expect(controlLine(["display-message", "-p", ""])).toBe("display-message -p ''");
  expect(controlLine(["display-message", "-p", "a\nb"])).toBeNull();
});

test("holds commands until the attach reply, then sends destroy-unattached first", async () => {
  const { fake, ctl } = harness();
  const p = ctl.run(["display-message", "-p", "-t", "s", "#{window_id}"]);
  expect(fake.written).toEqual([]);
  fake.boot();
  expect(fake.written).toEqual([
    `set-option -t ${CONTROL_SESSION} destroy-unattached on\n`,
    "display-message -p -t s '#{window_id}'\n",
  ]);
  fake.block(["@3"]);
  const r = await p;
  expect(r.exitCode).toBe(0);
  expect(dec(r.stdout)).toBe("@3\n");
  ctl.dispose();
});

test("replies are matched to commands in order; %error becomes exit code 1 with stderr", async () => {
  const { fake, ctl } = harness();
  const a = ctl.run(["has-session", "-t", "gone"]);
  const b = ctl.run(["-u", "list-sessions", "-F", "#{session_name}"]);
  const c = ctl.run(["send-keys", "-H", "-t", "s", "61"]);
  fake.boot();
  expect(fake.written[2]).toBe("list-sessions -F '#{session_name}'\n"); // global -u dropped
  fake.block(["can't find session: gone"], false);
  fake.emit("%sessions-changed\n%window-renamed @1 zsh\n"); // notifications between blocks
  fake.block(["work", "build"]);
  fake.block([]);
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  expect(ra.exitCode).toBe(1);
  expect(dec(ra.stderr)).toBe("can't find session: gone\n");
  expect(dec(rb.stdout)).toBe("work\nbuild\n");
  expect(rc.exitCode).toBe(0);
  expect(rc.stdout.length).toBe(0);
  expect(ctl.served).toBe(3);
  ctl.dispose();
});

test("a body line that looks like %end for another command stays in the block", async () => {
  const { fake, ctl } = harness();
  const p = ctl.run(["display-message", "-p", "x"]);
  fake.boot();
  fake.emit("%begin 1700000000 500 1\n%end 1700000000 499 1\nreal\n");
  fake.emit("%end 1700000000 500 1\n");
  expect(dec((await p).stdout)).toBe("%end 1700000000 499 1\nreal\n");
  ctl.dispose();
});

test("replies split across reads are reassembled", async () => {
  const { fake, ctl } = harness();
  const p = ctl.run(["display-message", "-p", "x"]);
  fake.boot();
  fake.emit("%begin 1700000000 7 1\nhel");
  fake.emit("lo\n%end 1700000000 7");
  fake.emit(" 1\n");
  expect(dec((await p).stdout)).toBe("hello\n");
  ctl.dispose();
});

test("capture-pane and unquotable arguments bypass the client", async () => {
  const { fake, ctl, fallbackCalls } = harness();
  await ctl.run(["-u", "capture-pane", "-p", "-t", "s"]);
  await ctl.run(["display-message", "-p", "a\nb"]);
  expect(fake.spawns).toBe(0);
  expect(fallbackCalls.length).toBe(2);
  ctl.dispose();
});

test("a failed attach routes queued commands to the fallback and backs off before retrying", async () => {
  let now = 1000;
  const { fake, ctl, fallbackCalls } = harness({ now: () => now });
  const p = ctl.run(["send-keys", "-H", "-t", "s", "61"]);
  fake.emit("%begin 1 1 0\nno server running\n%error 1 1 0\n");
  expect((await p).exitCode).toBe(0); // never written, so the fallback runs it once
  expect(fallbackCalls).toEqual([["send-keys", "-H", "-t", "s", "61"]]);
  await ctl.run(["has-session", "-t", "s"]);
  expect(fake.spawns).toBe(1); // inside the backoff window
  now += 1000;
  void ctl.run(["has-session", "-t", "s"]);
  expect(fake.spawns).toBe(2);
  ctl.dispose();
});

test("when the client dies, written queries re-run through the fallback but written input does not", async () => {
  const { fake, ctl, fallbackCalls } = harness();
  void ctl.run(["has-session", "-t", "s"]);
  const q = ctl.run(["display-message", "-p", "-t", "s", "#{pane_id}"]);
  const k = ctl.run(["send-keys", "-H", "-t", "s", "61"]);
  fake.boot();
  fake.block([]);
  fake.exit();
  const [rq, rk] = await Promise.all([q, k]);
  expect(dec(rq.stdout)).toBe("fallback\n");
  expect(rk.exitCode).toBe(1);
  expect(fallbackCalls.map((a) => a[0])).toEqual(["display-message"]);
  // The next command restarts the client straight away (it had booted fine).
  void ctl.run(["has-session", "-t", "s"]);
  expect(fake.spawns).toBe(2);
  ctl.dispose();
});

test("%exit from tmux tears the client down", async () => {
  const { fake, ctl } = harness();
  const p = ctl.run(["has-session", "-t", "s"]);
  fake.boot();
  fake.emit("%exit server exited\n");
  expect(fake.alive).toBe(false);
  expect(dec((await p).stdout)).toBe("fallback\n");
  ctl.dispose();
});

test("a reply that never comes kills the client after the timeout", async () => {
  const { fake, ctl } = harness({ replyTimeoutMs: 20 });
  const p = ctl.run(["display-message", "-p", "x"]);
  fake.boot();
  expect(dec((await p).stdout)).toBe("fallback\n");
  expect(fake.alive).toBe(false);
  ctl.dispose();
});

test("when disabled the client is closed and commands go to the fallback", async () => {
  let enabled = true;
  const { fake, ctl, fallbackCalls } = harness({ enabled: () => enabled });
  const p = ctl.run(["has-session", "-t", "s"]);
  fake.boot();
  fake.block([]);
  await p;
  enabled = false;
  await ctl.run(["has-session", "-t", "s"]);
  expect(fake.alive).toBe(false);
  expect(fallbackCalls.length).toBe(1);
  ctl.dispose();
});

const tmuxOut = (args: string[]) => new TextDecoder().decode(Bun.spawnSync(["tmux", ...args]).stdout).trim();

test.skipIf(!hasTmux())("real tmux: queries and input go through one hidden, size-neutral client", async () => {
  const NAME = uniqueSessionName("ctl");
  const fallbackCalls: string[][] = [];
  const ctl = new TmuxControl({
    fallback: async (args) => { fallbackCalls.push(args); return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() }; },
  });
  try {
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", NAME, "-x", "100", "-y", "30", "cat"]);
    const info = await ctl.run(["display-message", "-p", "-t", NAME, "#{window_width}x#{window_height}|#{session_attached}"]);
    expect(dec(info.stdout)).toBe("100x30|0\n");
    expect((await ctl.run(["has-session", "-t", `${NAME}-missing`])).exitCode).toBe(1);
    expect((await ctl.run(["send-keys", "-H", "-t", NAME, "68", "69", "0d"])).exitCode).toBe(0);
    expect(await waitFor(() => tmuxOut(["capture-pane", "-p", "-t", NAME]).includes("hi"))).toBe(true);
    expect(ctl.served).toBe(3);
    expect(fallbackCalls).toEqual([]);

    // Not a client of the user's session, so neither sizing nor last-device-wins sees it.
    expect(tmuxOut(["list-clients", "-t", NAME, "-F", "#{client_name}"])).toBe("");
    expect(tmuxOut(["display-message", "-p", "-t", NAME, "#{window_width}x#{window_height}|#{session_attached}"])).toBe("100x30|0");
    const flags = tmuxOut(["list-clients", "-t", CONTROL_SESSION, "-F", "#{client_flags}"]);
    expect(flags).toContain("ignore-size");
    expect(flags).toContain("no-output");

    ctl.dispose();
    expect(await waitFor(() => Bun.spawnSync(["tmux", "has-session", "-t", CONTROL_SESSION]).exitCode !== 0)).toBe(true);
  } finally {
    ctl.dispose();
    killSession(NAME);
  }
}, 15000);

test.skipIf(!hasTmux())("real tmux: control traffic neither resizes a shared window nor counts as client activity", async () => {
  const NAME = uniqueSessionName("ctlsz");
  const HOST = `${NAME}-host`;
  const ctl = new TmuxControl({ fallback: async () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() }) });
  try {
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", NAME, "-x", "80", "-y", "24", "cat"]);
    Bun.spawnSync(["tmux", "set-option", "-g", "window-size", "latest"]);
    Bun.spawnSync(["tmux", "set-option", "-g", "status", "off"]);
    // A real terminal client of NAME, 90x20, living in another session's pane.
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", HOST, "-x", "90", "-y", "20", `env -u TMUX tmux attach -t ${NAME}`]);
    const size = () => tmuxOut(["display-message", "-p", "-t", NAME, "#{window_width}x#{window_height}"]);
    const real = () => tmuxOut(["list-clients", "-t", NAME, "-F", "#{client_activity}"]);
    expect(await waitFor(() => real() !== "")).toBe(true);
    expect(await waitFor(() => size() === "90x20")).toBe(true);
    const activity = real();
    await Bun.sleep(1100); // client_activity has one-second resolution
    for (let i = 0; i < 5; i++) {
      await ctl.run(["send-keys", "-H", "-t", NAME, "61"]);
      await ctl.run(["display-message", "-p", "-t", NAME, "#{pane_current_command}"]);
    }
    expect(ctl.served).toBe(10);
    expect(real()).toBe(activity);
    expect(size()).toBe("90x20");
  } finally {
    ctl.dispose();
    killSession(HOST);
    killSession(NAME);
  }
}, 15000);

// One long-lived `tmux -C` client that carries input and queries, replacing a
// process spawn per command. Commands go out one per line; tmux answers each
// with a %begin ... %end|%error block, in order, so a FIFO of pending requests
// matches replies to commands. Notifications arrive only between blocks and
// are ignored.
//
// The client attaches to a hidden session of its own (control mode cannot stay
// up without one) with `ignore-size,no-output`: it never takes part in window
// sizing, receives no pane output, and is never listed by `list-clients -t` on
// a user session, so last-device-wins arbitration does not see it.
// `destroy-unattached` removes the hidden session as soon as the client goes,
// and `-N` keeps a restart from ever starting a tmux server.
//
// Anything that cannot go through the client (not started, restarting, a
// newline in an argument) runs through the spawning fallback runner instead.
// capture-pane always does: its output is large and pane-controlled, and a
// captured line that mimics %end/%begin would desynchronise the reply queue.
import type { AsyncTmuxRunner, TmuxResult } from "./terminal";

export const CONTROL_SESSION = "__pocketshell_ctl";

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30_000;
const REPLY_TIMEOUT_MS = 5000;

// Read-only commands that may be re-run through the fallback if the client dies mid-flight.
const RETRYABLE = new Set([
  "display-message", "has-session", "list-sessions", "list-clients", "list-panes",
  "list-windows", "show-options",
]);
const DIRECT = new Set(["capture-pane"]);

const subcommand = (args: string[]): string => args.find((a) => !a.startsWith("-")) ?? "";

export interface ControlTransport {
  write(text: string): void;
  close(): void; // end stdin: tmux detaches the client and it exits
  kill(): void;
}

export type ControlSpawner = (
  onData: (text: string) => void,
  onExit: () => void,
) => ControlTransport | null;

export const defaultControlSpawner: ControlSpawner = (onData, onExit) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ["tmux", "-N", "-u", "-C", "new-session", "-A", "-s", CONTROL_SESSION, "-f", "ignore-size,no-output", "cat"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
  } catch {
    return null;
  }
  const stdin = proc.stdin as import("bun").FileSink;
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const c of stdout) onData(dec.decode(c, { stream: true }));
    } catch { /* closed */ }
  })();
  void proc.exited.then(() => onExit(), () => onExit());
  proc.unref();
  return {
    write: (text) => { try { stdin.write(text); stdin.flush(); } catch { /* exiting */ } },
    close: () => { try { stdin.end(); } catch { /* already closed */ } },
    kill: () => { try { proc.kill(); } catch { /* already gone */ } },
  };
};

const SAFE_WORD = /^[A-Za-z0-9_@%.,:/=+-]+$/;

// tmux command-language quoting; null when an argument cannot be put on one line.
export function controlLine(args: string[]): string | null {
  const words: string[] = [];
  for (const a of args) {
    if (/[\n\r\0]/.test(a)) return null;
    words.push(SAFE_WORD.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  }
  return words.join(" ");
}

interface Request {
  args: string[];
  line: string;
  resolve: (r: TmuxResult) => void;
  written: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Block {
  id: string; // "<command number> <flags>" from %begin
  lines: string[];
}

const enc = new TextEncoder();

export class TmuxControl {
  private transport: ControlTransport | null = null;
  private booted = false;
  private queue: Request[] = []; // unwritten requests while booting, then written ones awaiting replies
  private partial = "";
  private block: Block | null = null;
  private retryAt = 0;
  private backoff = RESTART_MIN_MS;
  private disposed = false;
  private generation = 0;
  /** Commands answered by the control client (diagnostics and tests). */
  served = 0;

  constructor(
    private readonly deps: {
      fallback: AsyncTmuxRunner;
      spawn?: ControlSpawner;
      enabled?: () => boolean;
      now?: () => number;
      replyTimeoutMs?: number;
    },
  ) {}

  readonly run: AsyncTmuxRunner = (args) => {
    const line = controlLine(args[0] === "-u" ? args.slice(1) : args);
    if (line === null || this.disposed || DIRECT.has(subcommand(args))) return this.deps.fallback(args);
    if (this.deps.enabled && !this.deps.enabled()) {
      this.close();
      return this.deps.fallback(args);
    }
    if (!this.transport && !this.start()) return this.deps.fallback(args);
    return new Promise<TmuxResult>((resolve) => {
      const req: Request = { args, line, resolve, written: false, timer: null };
      this.queue.push(req);
      if (this.booted) this.write(req);
    });
  };

  get running(): boolean {
    return this.transport !== null && this.booted;
  }

  /** Detach the client; the hidden session goes with it. Restarts on the next command. */
  close(): void {
    if (!this.transport) return;
    const t = this.transport;
    this.settle(this.teardown());
    t.close();
  }

  dispose(): void {
    this.disposed = true;
    this.close();
  }

  private start(): boolean {
    const now = (this.deps.now ?? Date.now)();
    if (now < this.retryAt) return false;
    const gen = ++this.generation;
    this.partial = "";
    this.block = null;
    this.booted = false;
    const t = (this.deps.spawn ?? defaultControlSpawner)(
      (text) => { if (gen === this.generation) this.onData(text); },
      () => { if (gen === this.generation) this.onDeath(); },
    );
    if (!t) {
      this.scheduleRetry(now);
      return false;
    }
    this.transport = t;
    return true;
  }

  private scheduleRetry(now: number): void {
    this.retryAt = now + this.backoff;
    this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
  }

  private write(req: Request): void {
    req.written = true;
    req.timer = setTimeout(() => {
      if (req.timer !== null && this.transport) this.transport.kill();
    }, this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS);
    (req.timer as { unref?: () => void }).unref?.();
    this.transport?.write(req.line + "\n");
  }

  private onData(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const raw of lines) this.onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
  }

  private onLine(line: string): void {
    if (this.block) {
      const m = /^%(end|error) \d+ (\d+ \d+)$/.exec(line);
      if (m && m[2] === this.block.id) {
        const out = this.block.lines;
        this.block = null;
        this.onBlock(m[1] === "end", out);
      } else {
        this.block.lines.push(line);
      }
      return;
    }
    const b = /^%begin \d+ (\d+ \d+)$/.exec(line);
    if (b) this.block = { id: b[1], lines: [] };
    else if (line === "%exit" || line.startsWith("%exit ")) this.transport?.kill();
  }

  private onBlock(ok: boolean, lines: string[]): void {
    if (!this.booted) {
      // The first block answers the attach command itself.
      if (!ok) {
        this.transport?.kill();
        return;
      }
      this.booted = true;
      this.backoff = RESTART_MIN_MS;
      this.transport?.write(`set-option -t ${CONTROL_SESSION} destroy-unattached on\n`);
      this.queue.unshift({ args: [], line: "", resolve: () => {}, written: true, timer: null });
      for (const r of this.queue) if (!r.written) this.write(r);
      return;
    }
    const req = this.queue.shift();
    if (!req) return;
    if (req.timer !== null) clearTimeout(req.timer);
    req.timer = null;
    if (req.args.length === 0) return; // internal command
    this.served++;
    const text = lines.length ? lines.join("\n") + "\n" : "";
    req.resolve(ok
      ? { exitCode: 0, stdout: enc.encode(text), stderr: new Uint8Array() }
      : { exitCode: 1, stdout: new Uint8Array(), stderr: enc.encode(text) });
  }

  private onDeath(): void {
    const wasBooted = this.booted;
    const pending = this.teardown();
    if (!this.disposed && !wasBooted) this.scheduleRetry((this.deps.now ?? Date.now)());
    this.settle(pending);
  }

  private settle(pending: Request[]): void {
    for (const r of pending) {
      if (r.args.length === 0) continue;
      const sub = subcommand(r.args);
      // A written mutating command may already have run; re-sending could duplicate input.
      if (!r.written || RETRYABLE.has(sub)) void this.deps.fallback(r.args).then(r.resolve);
      else r.resolve({ exitCode: 1, stdout: new Uint8Array(), stderr: enc.encode("tmux control client exited") });
    }
  }

  private teardown(): Request[] {
    this.generation++;
    this.transport = null;
    this.booted = false;
    this.block = null;
    this.partial = "";
    const pending = this.queue;
    this.queue = [];
    for (const r of pending) if (r.timer !== null) { clearTimeout(r.timer); r.timer = null; }
    return pending;
  }
}

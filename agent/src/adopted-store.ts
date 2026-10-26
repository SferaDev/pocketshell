// Adopted tmux sessions persisted at <keyDir>/adopted-sessions.json so an agent
// restart does not demote them to foreign. Atomic write (tmp+rename), mode 0600.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AdoptedEntry { name: string; cols: number; rows: number; createdAt: number }

export function adoptedFilePath(keyDir: string): string {
  return join(keyDir, "adopted-sessions.json");
}

const dim = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);

// Malformed or missing file reads as empty; bad entries are skipped.
export function loadAdopted(file: string): AdoptedEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
    if (!Array.isArray(raw?.sessions)) return [];
    const seen = new Set<string>();
    const out: AdoptedEntry[] = [];
    for (const e of raw.sessions as Record<string, unknown>[]) {
      const name = e?.name;
      if (typeof name !== "string" || !name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, cols: dim(e.cols, 80), rows: dim(e.rows, 24), createdAt: dim(e.createdAt, Date.now()) });
    }
    return out;
  } catch { return []; }
}

export function saveAdopted(file: string, sessions: AdoptedEntry[]): void {
  const tmp = join(dirname(file), `.adopted.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

// Test preload: refuse to run where a test could reach the developer's tmux server or ~/.pocketshell.
// Bun spawns children with the original environment, so isolation must happen before bun starts.
const leaks = [
  process.env.TMUX && "TMUX is set (tests would drive your real tmux server)",
  process.env.TMUX_PANE && "TMUX_PANE is set",
  !process.env.TMUX_TMPDIR && "TMUX_TMPDIR is unset",
  !process.env.POCKETSHELL_KEY_DIR && "POCKETSHELL_KEY_DIR is unset (tests would write ~/.pocketshell)",
].filter(Boolean);
if (leaks.length) {
  throw new Error(`Unsafe test environment: ${leaks.join("; ")}. Run \`bun run test\`, which isolates both.`);
}

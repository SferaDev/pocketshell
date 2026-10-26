#!/bin/sh
# Run bun test against a throwaway tmux server and key dir, never the developer's.
set -eu
T=$(mktemp -d)
K=$(mktemp -d)
trap 'env -u TMUX tmux -S "$T/tmux-$(id -u)/default" kill-server >/dev/null 2>&1 || true; rm -rf "$T" "$K"' EXIT
env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$T" POCKETSHELL_KEY_DIR="$K" bun test "$@"

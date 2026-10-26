export const TAB_DETACH_GRACE_MS = 2_000;
// Recently used terminals, besides the current one, that keep streaming with
// no timer: switching back to one never pays a history reseed.
export const KEEP_RECENT_STREAMS = 2;

export interface StreamPolicyState {
  current: string | null;
  // Most recent first, at most KEEP_RECENT_STREAMS.
  recent: string[];
  grace: string | null;
}

export interface StreamTransition {
  state: StreamPolicyState;
  stream: string[];
  detachNow: string[];
  scheduleDetach: string | null;
}

export interface StreamStop {
  state: StreamPolicyState;
  stream: string[];
  detachNow: string[];
  preserveGraceTimer: boolean;
}

function streamIds(state: StreamPolicyState): string[] {
  return [...new Set([state.current, ...state.recent, state.grace].filter((id): id is string => id !== null))];
}

export function switchStream(
  previous: StreamPolicyState,
  nextTerminal: string | null,
  keepRecent = KEEP_RECENT_STREAMS,
): StreamTransition {
  if (nextTerminal === previous.current) {
    return { state: previous, stream: [], detachNow: [], scheduleDetach: null };
  }

  const used = [...new Set([previous.current, ...previous.recent])]
    .filter((id): id is string => id !== null && id !== nextTerminal);
  const recent = used.slice(0, keepRecent);
  const evicted = used.slice(keepRecent);
  const oldGrace = previous.grace !== null && previous.grace !== nextTerminal && !recent.includes(previous.grace)
    ? previous.grace
    : null;
  // The tab that just fell out of the recent set gets the grace window; a tab
  // already in grace keeps it only while nothing newer needs the slot.
  const grace = evicted[0] ?? oldGrace;
  const detachNow = [
    ...(oldGrace !== null && oldGrace !== grace ? [oldGrace] : []),
    ...evicted.slice(1),
  ];
  const state = { current: nextTerminal, recent, grace };

  return {
    state,
    stream: streamIds(state),
    detachNow,
    scheduleDetach: grace,
  };
}

export function stopStream(previous: StreamPolicyState, sessionId: string): StreamStop {
  if (previous.current !== sessionId && previous.grace !== sessionId && !previous.recent.includes(sessionId)) {
    return {
      state: previous,
      stream: [],
      detachNow: [sessionId],
      preserveGraceTimer: true,
    };
  }

  const state = {
    current: previous.current === sessionId ? null : previous.current,
    recent: previous.recent.filter((id) => id !== sessionId),
    grace: previous.grace === sessionId ? null : previous.grace,
  };

  return {
    state,
    stream: streamIds(state),
    detachNow: [sessionId],
    preserveGraceTimer: false,
  };
}

export function graceExpiryIsCurrent(
  captured: { sessionId: string; generation: number },
  current: { state: StreamPolicyState; generation: number; streaming: ReadonlySet<string> },
): boolean {
  return current.generation === captured.generation
    && current.state.grace === captured.sessionId
    && current.state.current !== captured.sessionId
    && current.streaming.has(captured.sessionId);
}

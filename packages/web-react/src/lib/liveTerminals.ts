import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "./chat/model";
import { deriveLiveTerminalEndedAt, deriveLiveTerminalFromMessages } from "./sessionStatus";
import type { Session, SessionLastOutcome } from "./types";

export type LiveTerminalEntry = {
  lastOutcome: SessionLastOutcome;
  lastErrorCode: string | null;
  endedAt: number;
};

export type LiveTerminalChatSource = {
  version: number;
  metaVersion?: number;
  isSending: (sessId: string | undefined) => boolean;
  getSession: (sessId: string | undefined) => { messages?: ReadonlyArray<ChatMessage> } | undefined;
};

function sameTerminal(a: LiveTerminalEntry | undefined, b: LiveTerminalEntry): boolean {
  return (
    !!a &&
    a.lastOutcome === b.lastOutcome &&
    a.lastErrorCode === b.lastErrorCode &&
    a.endedAt === b.endedAt
  );
}

/**
 * Tracks sessions transitioning from in-flight to terminal in the current tab.
 *
 * Only allocates a new Map snapshot and enqueues `applySessionTerminal` deltas
 * when an entry actually changes, preventing the `setSessions -> liveTerminals ->
 * useEffect -> setSessions` infinite re-render loop.
 */
export function useLiveTerminals(opts: {
  demo: boolean;
  chat: LiveTerminalChatSource;
  sessions: ReadonlyArray<Pick<Session, "id">>;
  applySessionTerminal: (
    sessId: string,
    terminal: LiveTerminalEntry | null,
  ) => void;
}): {
  liveTerminals: Map<string, LiveTerminalEntry>;
  liveTerminal: (id: string) => LiveTerminalEntry | undefined;
} {
  const { demo, chat, sessions, applySessionTerminal } = opts;
  const sendingIdsRef = useRef(new Set<string>());
  const terminalsRef = useRef(new Map<string, LiveTerminalEntry>());
  const snapshotRef = useRef(new Map<string, LiveTerminalEntry>());
  const pendingDeltasRef = useRef<Array<[string, LiveTerminalEntry]>>([]);
  const metaTick = chat.metaVersion ?? chat.version;

  const liveTerminals = useMemo(() => {
    void metaTick;
    if (demo) return snapshotRef.current;
    const now = new Set<string>();
    for (const s of sessions) {
      if (chat.isSending(s.id)) now.add(s.id);
    }
    let mutated = false;
    for (const id of now) {
      if (terminalsRef.current.delete(id)) mutated = true;
    }
    for (const id of sendingIdsRef.current) {
      if (!now.has(id)) {
        const msgs = chat.getSession(id)?.messages;
        const t = deriveLiveTerminalFromMessages(msgs);
        if (t) {
          const entry: LiveTerminalEntry = {
            ...t,
            endedAt: deriveLiveTerminalEndedAt(msgs),
          };
          if (!sameTerminal(terminalsRef.current.get(id), entry)) {
            terminalsRef.current.set(id, entry);
            pendingDeltasRef.current.push([id, entry]);
            mutated = true;
          }
        }
      }
    }
    sendingIdsRef.current = now;
    if (mutated) {
      snapshotRef.current = new Map(terminalsRef.current);
    }
    return snapshotRef.current;
  }, [demo, chat, metaTick, sessions]);

  useEffect(() => {
    const deltas = pendingDeltasRef.current;
    if (deltas.length === 0) return;
    pendingDeltasRef.current = [];
    for (const [id, t] of deltas) {
      applySessionTerminal(id, t);
    }
  }, [liveTerminals, applySessionTerminal]);

  const liveTerminal = useCallback(
    (id: string) => liveTerminals.get(id),
    [liveTerminals],
  );

  return { liveTerminals, liveTerminal };
}

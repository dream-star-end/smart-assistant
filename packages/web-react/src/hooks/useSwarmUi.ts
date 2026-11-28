import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findSwarmCardByIdentity,
  isAntigravityModelForUi,
  latestSwarmCard,
  type SwarmOpenRequest,
} from "../components/chat/swarmDetect";
import type { ChatMessage } from "../lib/chat/model";
import { isDialogLayerOpen } from "../lib/hotkeys";
import {
  readSessionSwarmMode,
  subscribeSessionSwarmMode,
  writeSessionSwarmMode,
} from "../lib/sessionSwarmMode";
import type { PublicModel } from "../lib/types";
import { useAccountDefaultSwarmSync, usePersistDefaultSwarmMode } from "./useSwarmDefaultSync";

export { usePersistDefaultSwarmMode };

export type SetSwarmModeOptions = {
  /** Persist as the account's default collaboration mode for future sessions/reloads (default: true). Pass false for automatic non-Antigravity fallback. */
  persistDefault?: boolean;
};

function resolveEffectiveSwarmEnabled(opts: {
  persistedId: string | undefined;
  sessionKey: string;
  persistedMap: Record<string, boolean | null>;
  draftSwarm: Record<string, boolean>;
  detectedSwarm: boolean;
  resolvedDefault: boolean;
}): boolean {
  const { persistedId, sessionKey, persistedMap, draftSwarm, detectedSwarm, resolvedDefault } = opts;
  if (!persistedId) {
    return typeof draftSwarm[sessionKey] === "boolean" ? draftSwarm[sessionKey] : resolvedDefault;
  }
  const explicitValue =
    persistedId in persistedMap ? (persistedMap[persistedId] ?? undefined) : readSessionSwarmMode(persistedId);
  const promotedDraft = typeof draftSwarm[persistedId] === "boolean" ? draftSwarm[persistedId] : undefined;
  return explicitValue ?? promotedDraft ?? (detectedSwarm ? true : resolvedDefault);
}

export type UseSwarmModeOptions = {
  demo: boolean;
  sessionKey: string;
  /** Persisted session id when viewing a materialized session; undefined on a fresh draft. */
  activeSessionId?: string;
  /** Authenticated user id for account-scoped default persistence; undefined never writes unscoped global storage. */
  userId?: string;
  /** Server-persisted default collaboration mode (`user_preferences.default_swarm_mode`). */
  defaultSwarmMode?: boolean;
  /** Callback to persist account default collaboration mode to the server (`/api/me/preferences`). */
  onPersistDefaultSwarmMode?: (enabled: boolean) => void;
  /** True when the active session already contains a live or historical SwarmBoard card. */
  hasSessionSwarm?: boolean;
  /** Optional session messages + monotonic version to detect existing SwarmBoard cards without extra caller wiring. */
  wsMessages?: readonly ChatMessage[];
  messagesVersion?: number;
  modelId: string | undefined;
  models: PublicModel[];
};

export function useSwarmMode(opts: UseSwarmModeOptions) {
  const {
    demo, sessionKey, activeSessionId, userId, defaultSwarmMode, onPersistDefaultSwarmMode,
    hasSessionSwarm = false, wsMessages, messagesVersion = 0, modelId, models,
  } = opts;
  const accountId = !demo ? userId : undefined;
  const persistedId = !demo ? activeSessionId : undefined;
  const [draftSwarm, setDraftSwarm] = useState<Record<string, boolean>>({});
  const [persistedMap, setPersistedMap] = useState<Record<string, boolean | null>>({});
  const { resolvedDefault, markLocalDefault } = useAccountDefaultSwarmSync(accountId, defaultSwarmMode);

  const detectedSwarm = useMemo(() => {
    void messagesVersion;
    if (hasSessionSwarm) return true;
    if (!persistedId || !wsMessages?.length) return false;
    const card = latestSwarmCard(wsMessages);
    return Boolean(card && (card.snapshot.phase === "starting" || card.snapshot.phase === "running"));
  }, [hasSessionSwarm, persistedId, wsMessages, messagesVersion]);

  useEffect(() => {
    if (!persistedId) return;
    const set = (v: boolean | undefined) => {
      const next = v ?? null;
      setPersistedMap((prev) => (prev[persistedId] === next ? prev : { ...prev, [persistedId]: next }));
    };
    const stored = readSessionSwarmMode(persistedId);
    const draftVal = draftSwarm[persistedId];
    if (stored === undefined && typeof draftVal === "boolean") {
      writeSessionSwarmMode(persistedId, draftVal);
      set(draftVal);
      setDraftSwarm((prev) => {
        if (!(persistedId in prev)) return prev;
        const copy = { ...prev };
        delete copy[persistedId];
        return copy;
      });
    } else {
      set(stored);
    }
    return subscribeSessionSwarmMode(persistedId, set);
  }, [persistedId, draftSwarm]);

  const swarmSupported = !demo && isAntigravityModelForUi(modelId, models);
  const effectiveEnabled = resolveEffectiveSwarmEnabled({
    persistedId,
    sessionKey,
    persistedMap,
    draftSwarm,
    detectedSwarm,
    resolvedDefault,
  });
  const swarmMode = swarmSupported && effectiveEnabled;

  const setSwarmMode = useCallback(
    (next: boolean, setOpts?: SetSwarmModeOptions) => {
      const persistDefault = setOpts?.persistDefault !== false;
      if (persistedId) {
        writeSessionSwarmMode(persistedId, next);
        setPersistedMap((prev) => ({ ...prev, [persistedId]: next }));
      } else if (persistDefault && accountId) {
        setDraftSwarm((prev) => {
          if (!(sessionKey in prev)) return prev;
          const copy = { ...prev };
          delete copy[sessionKey];
          return copy;
        });
      } else {
        setDraftSwarm((prev) => ({ ...prev, [sessionKey]: next }));
      }
      if (persistDefault && accountId) {
        markLocalDefault(next);
        onPersistDefaultSwarmMode?.(next);
      }
    },
    [persistedId, sessionKey, accountId, markLocalDefault, onPersistDefaultSwarmMode],
  );

  const toggleSwarmMode = useCallback(
    (setOpts?: SetSwarmModeOptions) => {
      setSwarmMode(!effectiveEnabled, setOpts);
    },
    [effectiveEnabled, setSwarmMode],
  );

  return { swarmSupported, swarmMode, setSwarmMode, toggleSwarmMode };
}

export function useSwarmBoard(opts: {
  sessionKey: string;
  wsMessages: ChatMessage[];
  /** Monotonic version counter from useChatSocket (`chat.version`), required because
   *  `wsMessages` is mutated in place across live frame arrivals. */
  messagesVersion: number;
}) {
  const { sessionKey, wsMessages, messagesVersion } = opts;
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardFocus, setBoardFocus] = useState<{
    member: string | null;
    channel: string | null;
    seq: number | null;
    cardId: string | null;
    blockId: string | null;
    followLatest: boolean;
    snapshot: SwarmSnapshot | null;
  }>({ member: null, channel: null, seq: null, cardId: null, blockId: null, followLatest: true, snapshot: null });
  const [dismissedSwarmKey, setDismissedSwarmKey] = useState<string | null>(null);

  // Re-evaluate whenever `messagesVersion` ticks (wsMessages is mutated in place).
  const latestCard = useMemo(() => {
    void messagesVersion;
    return latestSwarmCard(wsMessages);
  }, [wsMessages, messagesVersion]);
  const latestSwarm = latestCard?.snapshot ?? null;

  // Reset board overlay when navigating to another session so a stale swarm never lingers.
  useEffect(() => {
    setBoardOpen(false);
    setBoardFocus({ member: null, channel: null, seq: null, cardId: null, blockId: null, followLatest: true, snapshot: null });
  }, [sessionKey]);

  const openBoard = useCallback((req: SwarmOpenRequest) => {
    setBoardFocus({
      member: req.focusMember ?? null,
      channel: req.focusChannel ?? null,
      seq: req.focusSeq ?? null,
      cardId: req.cardId ?? null,
      blockId: req.blockId ?? null,
      followLatest: !req.cardId && !req.blockId,
      snapshot: req.snapshot,
    });
    setBoardOpen(true);
  }, []);

  // Follow live updates for the exact card/turn opened in the drawer without letting a
  // newer turn's board hijack a historical card that merely shares the same swarmId.
  const activeDrawerSwarm = useMemo(() => {
    void messagesVersion;
    if (boardFocus.cardId || boardFocus.blockId) {
      const matched = findSwarmCardByIdentity(wsMessages, boardFocus.cardId, boardFocus.blockId);
      if (matched) return matched.snapshot;
      return boardFocus.snapshot ?? latestSwarm;
    }
    if (boardFocus.followLatest && latestSwarm) return latestSwarm;
    return boardFocus.snapshot ?? latestSwarm;
  }, [wsMessages, messagesVersion, boardFocus, latestSwarm]);

  useEffect(() => {
    if (!latestCard) return;
    const onKey = (e: KeyboardEvent) => {
      // macOS 按 Option+S 会把 e.key 映成 "ß"，必须同时识别物理键 e.code === "KeyS"（对齐 lib/hotkeys.ts）。
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.isComposing &&
        e.keyCode !== 229 &&
        (e.code === "KeyS" || e.key.toLowerCase() === "s")
      ) {
        if (!boardOpen && isDialogLayerOpen()) return;
        e.preventDefault();
        setBoardFocus({
          member: null,
          channel: null,
          seq: null,
          cardId: latestCard.messageId,
          blockId: latestCard.blockId ?? null,
          followLatest: true,
          snapshot: latestCard.snapshot,
        });
        setBoardOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [latestCard, boardOpen]);

  const latestSwarmKey = latestCard ? `${latestCard.blockId ?? latestCard.messageId}:${latestCard.snapshot.swarmId}` : null;

  return {
    latestCard,
    latestSwarm,
    latestSwarmKey,
    boardOpen,
    setBoardOpen,
    boardFocus,
    activeDrawerSwarm,
    openBoard,
    dismissedSwarmKey,
    dismissSwarm: useCallback((key: string) => setDismissedSwarmKey(key), []),
  };
}

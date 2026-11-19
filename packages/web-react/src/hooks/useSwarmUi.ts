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
import type { PublicModel } from "../lib/types";

export function useSwarmMode(opts: {
  demo: boolean;
  sessionKey: string;
  modelId: string | undefined;
  models: PublicModel[];
}) {
  const { demo, sessionKey, modelId, models } = opts;
  const [swarmModeBySession, setSwarmModeBySession] = useState<Record<string, boolean>>({});
  const swarmSupported = !demo && isAntigravityModelForUi(modelId, models);
  const swarmMode = swarmSupported && Boolean(swarmModeBySession[sessionKey]);
  const toggleSwarmMode = useCallback(() => {
    setSwarmModeBySession((prev) => ({ ...prev, [sessionKey]: !prev[sessionKey] }));
  }, [sessionKey]);
  return { swarmSupported, swarmMode, toggleSwarmMode };
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
    cardId: string | null;
    blockId: string | null;
    followLatest: boolean;
    snapshot: SwarmSnapshot | null;
  }>({ member: null, channel: null, cardId: null, blockId: null, followLatest: true, snapshot: null });
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
    setBoardFocus({ member: null, channel: null, cardId: null, blockId: null, followLatest: true, snapshot: null });
  }, [sessionKey]);

  const openBoard = useCallback((req: SwarmOpenRequest) => {
    setBoardFocus({
      member: req.focusMember ?? null,
      channel: req.focusChannel ?? null,
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
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        if (!boardOpen && isDialogLayerOpen()) return;
        e.preventDefault();
        setBoardFocus({
          member: null,
          channel: null,
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

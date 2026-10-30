import { parsePlatformReasoningEffort } from "@openclaude/protocol/browser";
import type { RefObject } from "react";
import type { ChatMessage } from "../lib/chat/model";
import { canonicalTaskContinuationError, manualTaskContinuationSource, taskContinuationPrompt } from "../lib/chat/manualTaskContinuation";
import { exactUserReplayPayload, interruptedContinuationTarget } from "../lib/chat/socket";
import { identityIsCurrent } from "../lib/resolvedIdentity";
import type { ChatCardActionsInput } from "./useChatCardActions";

type ManualTaskContinuationActionInput = Pick<ChatCardActionsInput,
  "activeId" | "demo" | "identity" | "authRef" | "sockRef" | "send"> & {
  error: ChatMessage;
  agentId: string;
  activeSessionRef: RefObject<string | undefined>;
  pendingContinuations: RefObject<Set<string>>;
  loadExactOrToast: ChatCardActionsInput["loadExactUserMessage"];
};

/** Loaded only after a human click. Recheck entry after the chunk arrives,
 * then preserve the same hydration, checkpoint and normal-admission gates. */
export async function continueManualTask({ activeId, demo, identity, authRef, sockRef, send,
  error, agentId, activeSessionRef, pendingContinuations, loadExactOrToast }: ManualTaskContinuationActionInput): Promise<void> {
  if (demo || !activeId || activeSessionRef.current !== activeId) return;
  if (!identity || !identityIsCurrent(identity, authRef.current)) return;
  const sock = sockRef.current;
  const rows = sock?.getMessages(activeId) ?? [];
  const canonical = canonicalTaskContinuationError(rows, error);
  const source = canonical && manualTaskContinuationSource(rows, error);
  if (!sock || !source || !canonical) return;
  const key = `${activeId}\0${source.id}`;
  if (pendingContinuations.current.has(key)) return;
  pendingContinuations.current.add(key);
  try {
    if (interruptedContinuationTarget(rows, canonical, activeId)) {
      sock.continueInterruptedTurn({ sessId: activeId, errorMessageId: canonical.id, agentId });
      return;
    }
    const exact = await loadExactOrToast(source);
    if (!exact || !identityIsCurrent(identity, authRef.current) || activeSessionRef.current !== activeId || sockRef.current !== sock ||
      manualTaskContinuationSource(sock.getMessages(activeId), error)?.id !== source.id) return;
    const replay = exactUserReplayPayload(exact);
    // Explicit human follow-up uses the normal admission/credit/auth gates.
    // It neither deletes old content nor resends an executed task.
    const text = taskContinuationPrompt(replay.text);
    const routing = exact._routing;
    if (routing) {
      await sock.send({
        sessId: activeId, agentId, text, media: replay.media, displayText: "继续",
        model: routing.model, teamMode: routing.teamMode,
        effortLevel: routing.effortLevel === null ? null : parsePlatformReasoningEffort(routing.effortLevel),
        collabMode: routing.collabMode, advisorModel: routing.advisorModel,
        collabConfigVersion: routing.collabConfigVersion,
        contextTier: routing.contextTier, serviceTier: routing.serviceTier,
      });
    } else {
      await send(text, replay.media, undefined, "继续", undefined, { sessionId: activeId });
    }
  } finally {
    pendingContinuations.current.delete(key);
  }
}

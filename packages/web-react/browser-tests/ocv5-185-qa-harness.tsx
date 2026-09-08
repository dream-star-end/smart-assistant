/**
 * OCV5-185 dual-browser QA harness.
 * Real PermissionCard + MessageList (MessageRenderer) + useChatSocket.
 * Transport (HTTP/WS) is the mock server in ocv5-185-qa.node-test.mjs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useChatSocket } from "../src/hooks/useChatSocket";
import { api } from "../src/lib/api";
import type { AuthSession } from "../src/lib/types";
import { MessageList } from "../src/components/MessageRenderer";
import {
  activeModalRequest,
  resetPermissionPopupCoordinator,
  subscribePermissionCoordinator,
} from "../src/lib/chat/permissionPopupCoordinator";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

function makeAuth(token: string): AuthSession {
  let epoch = 1;
  let current = token;
  return {
    snapshot: () => ({ token: current, epoch }),
    beginIdentity: () => {
      epoch += 1;
      current = "";
      return epoch;
    },
    commitToken: (expected, next) => {
      if (expected !== epoch) return false;
      current = next;
      return true;
    },
    expire: (expected) => {
      if (expected !== epoch) return false;
      current = "";
      return true;
    },
  };
}

function params() {
  const q = new URLSearchParams(location.search);
  return {
    userId: q.get("user") || "user-a",
    sessId: q.get("sess") || "sess185qa01",
    agentId: q.get("agent") || "main",
    token: q.get("token") || `tok-${q.get("user") || "user-a"}`,
    live: q.get("live") === "1",
  };
}

function Harness() {
  const cfg = useMemo(() => params(), []);
  const auth = useMemo(() => makeAuth(cfg.token), [cfg.token]);
  const sock = useChatSocket({
    auth,
    ready: true,
    laneReady: true,
    enabled: true,
    defaultAgentId: cfg.agentId,
    userId: cfg.userId,
  });
  const [, setCoordTick] = useState(0);
  const [loadError, setLoadError] = useState("");

  useEffect(() => resetPermissionPopupCoordinator(), [cfg.userId, cfg.sessId]);
  useEffect(() => subscribePermissionCoordinator(() => setCoordTick((n) => n + 1)), []);

  useEffect(() => {
    sock.ensureSession(cfg.sessId, cfg.agentId, "OCV5-185 QA");
    sock.setActiveSession(cfg.sessId);
  }, [cfg.agentId, cfg.sessId, sock]);

  const applyDetail = useCallback(
    (detail: Awaited<ReturnType<typeof api.getSession>>, full: boolean) => {
      sock.mergeServerHistory({
        sessId: cfg.sessId,
        agentId: detail.agentId || cfg.agentId,
        messages: Array.isArray(detail.messages) ? (detail.messages as never[]) : [],
        full,
        maxSeq: detail.maxSeq,
        archivedThroughSeq: detail.archivedThroughSeq,
        archivedCount: detail.archivedCount,
        serverUpdatedAt: detail.updatedAt,
        historyRevision: detail.historyRevision,
        timelineGeneration: detail.timelineGeneration,
        timelineCursor: detail.timelineCursor,
        timelineHasMore: detail.timelineHasMore,
        timelineSnapshotMaxSeq: detail.timelineSnapshotMaxSeq,
        permissionPrompts: detail.permissionPrompts,
      });
    },
    [cfg.agentId, cfg.sessId, sock],
  );

  const loadSession = useCallback(async () => {
    setLoadError("");
    try {
      sock.ensureSession(cfg.sessId, cfg.agentId, "OCV5-185 QA");
      sock.setActiveSession(cfg.sessId);
      const detail = await api.getSession(auth, cfg.sessId, 0);
      applyDetail(detail, true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [applyDetail, auth, cfg.agentId, cfg.sessId, sock]);

  /** Incremental snapshot only: does not full-replace the local tape. */
  const loadSnapshot = useCallback(async () => {
    setLoadError("");
    try {
      const detail = await api.getSession(auth, cfg.sessId, 0);
      applyDetail(detail, false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [applyDetail, auth, cfg.sessId]);

  const messages = sock.getMessages(cfg.sessId);
  const unresolved = messages.some((m) => m.role === "permission" && m._resolved !== true);
  const sending = sock.isSending(cfg.sessId) || (cfg.live && unresolved);
  const cards = messages
    .filter((m) => m.role === "permission")
    .map((m) => ({
      id: m.id,
      requestId: m.requestId,
      toolName: m.toolName,
      toolUseId: m.toolUseId ?? null,
      turnOwner: m._turnOwnerId ?? null,
      resolved: m._resolved === true,
      behavior: m._behavior ?? null,
      settledReason: m._settledReason ?? null,
      pending: m._controlPending === true,
      detached: m._detachedAskUser === true,
    }));

  useEffect(() => {
    const apiSurface = {
      loadSession,
      loadSnapshot,
      getState: () => ({
        userId: cfg.userId,
        sessId: cfg.sessId,
        agentId: cfg.agentId,
        status: sock.status.label,
        statusCls: sock.status.cls,
        version: sock.version,
        sending,
        loadError,
        activeModal: activeModalRequest(),
        cards,
      }),
    };
    (window as unknown as { __qa: typeof apiSurface }).__qa = apiSurface;
  }, [cards, cfg.agentId, cfg.sessId, cfg.userId, loadError, loadSession, loadSnapshot, sending, sock.status.cls, sock.status.label, sock.version]);

  return (
    <TooltipProvider>
      <ToastProvider>
        <div data-testid="qa-root" data-user={cfg.userId} data-agent={cfg.agentId} data-sess={cfg.sessId}>
          <div data-testid="qa-ws-status">{sock.status.cls}</div>
          <div data-testid="qa-ws-label">{sock.status.label}</div>
          <div data-testid="qa-active-modal">{activeModalRequest() ?? ""}</div>
          <pre data-testid="qa-cards">{JSON.stringify(cards)}</pre>
          {loadError ? <div data-testid="qa-load-error">{loadError}</div> : null}
          <div style={{ height: 720, overflow: "auto" }} data-testid="qa-timeline">
            <MessageList
              messages={messages}
              sending={sending}
              cb={{}}
              onRespondPermission={(p) => {
                sock.respondPermission({ sessId: cfg.sessId, ...p });
              }}
              sessionId={cfg.sessId}
            />
          </div>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

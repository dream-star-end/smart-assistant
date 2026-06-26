import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import type { ChatMessage, ChatSession } from "../lib/chat/model";
import { rebuildIndexes } from "../lib/chat/model";
import { ChatSocket, type ChatSnapshot } from "../lib/chat/socket";
import type { InboundMessage } from "../lib/chat/frames";
import type { AuthSession } from "../lib/types";

/**
 * P4 —— 真实 WS 对话引擎的 React 绑定。
 *
 * 架构（spec §0）：ChatSocket 是渲染树之外的单例 service，持有 ws + 全部高频可变
 * 状态；本 hook 只做三件事：
 *  1. 按 auth 身份**惰性创建并复用**一个 ChatSocket（authRef 注入 token/续期回调）；
 *  2. 用 `useSyncExternalStore` 订阅 service 的缓存快照（不每帧 setState）；
 *  3. 把 `gate.ready`（容器 ready）作为 connect 的**硬前置**喂给 service。
 *
 * 卸载 / 登出时 stop() 解绑全部 window 事件 + 关闭 ws。
 */
export type UseChatSocket = {
  status: ChatSnapshot["status"];
  provisioning: boolean;
  /** 取某会话当前消息快照（就地 mutation 的数组，随 version 变更触发重渲）。*/
  getMessages: (sessId: string | undefined) => ChatMessage[];
  getSession: (sessId: string | undefined) => ChatSession | undefined;
  isSending: (sessId: string | undefined) => boolean;
  ensureSession: (sessId: string, agentId: string, title?: string) => void;
  removeSession: (sessId: string) => void;
  /** 切换会话 agent（§11 跨 agent 污染守卫的写入点）。*/
  switchAgent: (sessId: string, agentId: string) => void;
  send: (p: {
    sessId: string;
    agentId: string;
    text: string;
    displayText?: string;
    media?: InboundMessage["content"]["media"];
    model?: string;
    effortLevel?: InboundMessage["effortLevel"];
  }) => void;
  stop: (sessId: string) => void;
  respondPermission: (p: {
    sessId: string;
    requestId: string;
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  }) => void;
};

const EMPTY_MESSAGES: ChatMessage[] = [];

export function useChatSocket(opts: {
  auth: AuthSession | null;
  /** gate.ready：容器 running —— WS 连接硬前置。*/
  ready: boolean;
  /** 进入工作区且非 demo。*/
  enabled: boolean;
  defaultAgentId?: string;
  /** 商业版余额刷新（cost_charged / 4506 / insufficient_credits）。*/
  refreshBalance?: () => void;
}): UseChatSocket {
  const { auth, ready, enabled, defaultAgentId, refreshBalance } = opts;

  // authRef / refreshBalanceRef：让 service deps 永远读到最新闭包，无 stale。
  const authRef = useRef(auth);
  authRef.current = auth;
  const refreshBalanceRef = useRef(refreshBalance);
  refreshBalanceRef.current = refreshBalance;
  const defaultAgentRef = useRef(defaultAgentId);
  defaultAgentRef.current = defaultAgentId;

  // 单例 service：整个组件生命周期复用同一实例。
  const socketRef = useRef<ChatSocket | null>(null);
  if (!socketRef.current) {
    socketRef.current = new ChatSocket({
      getToken: () => authRef.current?.getToken() ?? "",
      silentRefresh: async () => {
        const r = await api.refresh();
        if (r) {
          authRef.current?.setToken(r.accessToken);
          return r.accessToken;
        }
        return null;
      },
      onAuthExpired: () => authRef.current?.onExpired(),
      refreshBalance: () => refreshBalanceRef.current?.(),
      reportClientError: (p) => {
        // 真 turn 失败自动上报（best-effort，端点 P6 接；这里静默兜底）。
        void fetch("/api/client-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(p),
        }).catch(() => {});
      },
      // resume_failed / 重连 reconcile：REST 全量 sync 作最终权威源（server-wins）。
      syncSession: async (sessId) => {
        const a = authRef.current;
        if (!a) return;
        const socket = socketRef.current;
        const sess = socket?.sessions.get(sessId);
        if (!sess) return;
        try {
          const detail = await api.getSession(a, sessId);
          const serverMsgs = Array.isArray(detail.messages) ? (detail.messages as ChatMessage[]) : null;
          // 只在 server 返回非空 tape 时做全量替换——绝不用空结果抹掉活转录。
          if (serverMsgs && serverMsgs.length > 0) {
            sess.messages = serverMsgs;
            sess._streamingAssistant = null;
            sess._streamingThinking = null;
            sess._blockIdToMsgId = new Map();
            sess._agentGroups = new Map();
            rebuildIndexes(sess);
          }
          sess._liveStreamBroken = false;
        } catch {
          /* sync 失败：保留现状，下次重连/前台再试 */
        }
      },
      defaultAgentId: defaultAgentRef.current,
    });
  }
  const socket = socketRef.current;

  // 订阅 service 快照。
  const snap = useSyncExternalStore(socket.subscribe, socket.getSnapshot);

  // 生命周期：enabled 时 start（绑事件）；卸载/禁用时 stop（解绑 + 关 ws）。
  useEffect(() => {
    if (!enabled || !auth) {
      socket.bumpAuthEpoch();
      socket.stop();
      return;
    }
    socket.start();
    return () => {
      socket.stop();
    };
  }, [enabled, auth, socket]);

  // gate.ready 作为 connect 硬前置喂给 service。
  useEffect(() => {
    if (!enabled || !auth) return;
    socket.setGateReady(ready);
  }, [enabled, auth, ready, socket]);

  const getMessages = useCallback(
    (sessId: string | undefined) => {
      if (!sessId) return EMPTY_MESSAGES;
      // 依赖 snap.version 触发重算；messages 是就地 mutation 的同一数组。
      void snap.version;
      return snap.sessions.get(sessId)?.messages ?? EMPTY_MESSAGES;
    },
    [snap],
  );
  const getSession = useCallback(
    (sessId: string | undefined) => {
      void snap.version;
      return sessId ? snap.sessions.get(sessId) : undefined;
    },
    [snap],
  );
  const isSending = useCallback(
    (sessId: string | undefined) => {
      void snap.version;
      return !!(sessId && snap.sessions.get(sessId)?._sendingInFlight);
    },
    [snap],
  );

  const ensureSession = useCallback((sessId: string, agentId: string, title?: string) => {
    socket.ensureSession(sessId, agentId, title);
  }, [socket]);
  const removeSession = useCallback((sessId: string) => socket.removeSession(sessId), [socket]);
  const switchAgent = useCallback((sessId: string, agentId: string) => socket.switchAgent(sessId, agentId), [socket]);
  const send = useCallback<UseChatSocket["send"]>((p) => socket.sendMessage(p), [socket]);
  const stop = useCallback((sessId: string) => socket.stopTurn(sessId), [socket]);
  const respondPermission = useCallback<UseChatSocket["respondPermission"]>(
    (p) => socket.respondPermission(p),
    [socket],
  );

  return useMemo(
    () => ({
      status: snap.status,
      provisioning: snap.provisioning,
      getMessages,
      getSession,
      isSending,
      ensureSession,
      removeSession,
      switchAgent,
      send,
      stop,
      respondPermission,
    }),
    [snap, getMessages, getSession, isSending, ensureSession, removeSession, switchAgent, send, stop, respondPermission],
  );
}

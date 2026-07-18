import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { reportClientFriction } from "../lib/clientFriction";
import type { ChatMessage, ChatSession } from "../lib/chat/model";
import { ChatSocket, type ChatSnapshot } from "../lib/chat/socket";
import type { InboundMessage, RepoBindErrorWire, RepoStatusWire } from "../lib/chat/frames";
import { SessionStore, type StoredSession } from "../lib/persist";
import type { AuthSession } from "../lib/types";

/** 流式期防 IDB 写抖：尾沿 debounce 后落盘一次（isFinal/resume_failed 走立即写，不等它）。*/
const PERSIST_DEBOUNCE_MS = 900;

/**
 * 会话写盘签名（debounce 去重，避免无谓 IDB 写）：消息条数 + 末条多维度（文本/工具输出/
 * partialJson 长度、完成标记、状态）+ 游标 + 时间戳。覆盖流式期最常变的「末条」增长
 * （含 Bash tail / 工具输出）。中段旧消息的罕见变更不进签名 —— 兜底靠 pagehide/隐藏时
 * 的全量 flush（无条件落盘）与 isFinal 立即写。
 */
function persistSignature(s: StoredSession): string {
  const last = s.messages[s.messages.length - 1];
  const lastSig = last
    ? `${last.text?.length ?? 0}/${last.output?.length ?? 0}/${last.partialJson?.length ?? 0}/${last._completed ? 1 : 0}/${last.status ?? ""}`
    : "";
  // title 计入:rename 是纯元数据变更,漏掉它 IndexedDB 永远存旧标题(reload 即回退)。
  // _selectedModelId 同理:会话级模型选择也是纯元数据变更,漏掉则选完不发消息时 reload 即回退。
  const inflightSig = s._sendingInFlight
    ? `1/${s._turnStartedAt ?? 0}/${s._lastFrameAt ?? 0}`
    : "0";
  return `${s.messages.length}:${lastSig}:${s._lastFrameSeq ?? 0}:${s._maxSeq ?? 0}:${s.updatedAt ?? s.lastAt}:${s.title}:${s.agentId}:${s._selectedModelId ?? ""}:${inflightSig}:${s._trackerResetAt ?? 0}:${s._trackerResetServerTs ?? 0}:${s._localTeardownAt ?? 0}:${s._agentSwitchedAt ?? 0}`;
}

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
  browserOnline: boolean;
  /** 快照单调版本号:消息数组是就地 mutation 的同一引用,version 才是变更的权威信号
   *  (autoscroll 等 effect 的依赖必须用它;依赖数组引用恒等则流式期间永不触发)。*/
  version: number;
  /** 取某会话当前消息快照（就地 mutation 的数组，随 version 变更触发重渲）。*/
  getMessages: (sessId: string | undefined) => ChatMessage[];
  getSession: (sessId: string | undefined) => ChatSession | undefined;
  isSending: (sessId: string | undefined) => boolean;
  ensureSession: (sessId: string, agentId: string, title?: string) => void;
  /** Confirm the server session row before an ownership-gated operation that
   * can occur before the first message (notably GoalState set). */
  ensureServerSession: (sessId: string, agentId: string, title?: string) => Promise<boolean>;
  removeSession: (sessId: string) => void;
  /** 重命名会话(WS service 内存 + IndexedDB;服务端 PATCH 由 App 层同步)。*/
  renameSession: (sessId: string, title: string) => void;
  /** 会话级模型选择(WS service 内存 + IndexedDB;服务端 PATCH 由 App 层同步,与 rename 同构)。*/
  setSessionModel: (sessId: string, modelId: string) => void;
  /** 切换会话 agent（§11 跨 agent 污染守卫的写入点）。*/
  switchAgent: (sessId: string, agentId: string) => void;
  send: (p: {
    sessId: string;
    agentId: string;
    text: string;
    displayText?: string;
    media?: InboundMessage["content"]["media"];
    imageEdit?: InboundMessage["content"]["imageEdit"];
    model?: string;
    effortLevel?: InboundMessage["effortLevel"];
    teamMode?: boolean;
  }) => void;
  stop: (sessId: string) => void;
  /** 重试一条发送失败的用户消息（复用原 payload 走既有发送入口原地重发）。*/
  retryMessage: (p: {
    sessId: string;
    msgId: string;
    agentId: string;
  }) => void;
  /** 告知当前选中会话（S1 对账无条件优先拉它）。*/
  setActiveSession: (sessId: string | undefined) => void;
  /** Apply REST/WS platform goal snapshots to the live session model. */
  setGoalState: (sessId: string, goal: ChatSession["goalState"]) => void;
  /** 会话级 transient 软提示（"较长时间未收到新内容…"，非持久，随 version 快照读回）。*/
  getTransientNotice: (sessId: string | undefined) => { text: string; ts: number } | null;
  respondPermission: (p: {
    sessId: string;
    requestId: string;
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  }) => void;
  /** 历史加载：把 server canonical 消息合并进会话（server-wins / id 幂等）并落地。
   *  `archivedThroughSeq` 透传给 full 合并(热尾巴:本地 `_seq ≤ 水位`的旧行无条件保留)。*/
  mergeServerHistory: (p: {
    sessId: string;
    agentId: string;
    messages: ChatMessage[];
    full: boolean;
    maxSeq?: number;
    archivedThroughSeq?: number;
    archivedCount?: number;
    /** SessionDetail.updatedAt:full 缺席删除(同步权威传播 P1)的版本护栏证据。*/
    serverUpdatedAt?: number;
    /** SessionDetail.modelId(会话级模型选择):携带时 server-wins 镜像进会话态。*/
    modelId?: string;
  }) => void;
  /** server 增量游标（getSession 的 sinceSeq；无则 0=全量）。*/
  storedMaxSeq: (sessId: string | undefined) => number;
  /**
   * 归档滚动加载：从云端拉一页更早的归档历史(getSessionArchive)并前插进会话(只前插/按 id 去重,
   * 不覆盖本地富卡)。返回本页结果供 UI 驱动"加载更多"按钮三态(loading/更多/无更多/失败可重试)。
   */
  loadOlderHistory: (
    sessId: string | undefined,
  ) => Promise<{ ok: boolean; loaded: number; hasMore: boolean; error?: boolean }>;
  /**
   * §9 折叠卷展开:拉 tape 记录一页(getTapeRecords)并就地展开折叠 anchor(socket.applyExpandedTapeRecords)。
   * `cursor` 缺省(null)=首页,续拉传上次返回的 nextCursor。并发去重(同 anchor 在飞时忽略);非抛出式契约。
   */
  expandCollapsedTape: (
    sessId: string | undefined,
    anchorId: string,
    tapeId: string,
    cursor?: number | null,
  ) => Promise<{ ok: boolean; nextCursor?: number | null; total?: number; busy?: boolean; error?: boolean }>;
  /** §9 折叠卷收起(纯本地,抹展开行还原折叠态)。 */
  collapseTape: (sessId: string | undefined, anchorId: string) => void;
  /**
   * §9 截断记录"查看完整":原样拉 tape 记录一页(不改会话内存,供截断工具卡内联抽屉显示更完整版本)。
   * 失败返 null(非抛出)。
   */
  fetchTapeRecords: (
    sessId: string | undefined,
    tapeId: string,
    cursor?: number | null,
  ) => Promise<{ records: ChatMessage[]; nextCursor: number | null; total: number } | null>;
  /** §9(M-§9-1)单条超大记录分块读(≤256KB/请求;失败返 null 非抛出)。 */
  fetchTapeRecordChunk: (
    sessId: string | undefined,
    tapeId: string,
    recordOrdinal: number,
    offset?: number,
  ) => Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null>;
  /** 删除某会话的本地持久副本（与 removeSession 配套）。*/
  removePersisted: (sessId: string) => void;
  /** 清空当前 user 命名空间（登出隐私收尾）。*/
  wipePersistence: () => Promise<void>;
  /** GitHub：发仓库绑定帧（PUT /github-selection 成功后）。peer/agentId/channel 由 socket 按 v3 形状构造。*/
  sendRepoBind: (sessId: string, agentId: string, version: number) => void;
  /** GitHub：发解绑帧（DELETE /github-selection 成功后）。*/
  sendRepoUnbind: (sessId: string, version: number) => void;
};

const EMPTY_MESSAGES: ChatMessage[] = [];

export function useChatSocket(opts: {
  auth: AuthSession | null;
  /** gate.ready：容器 running —— WS 连接硬前置。*/
  ready: boolean;
  /**
   * cohort lane 就绪（P3 RFC D1，来自 useAuth.laneReady）：与 ready 正交的 WS 连接前置。
   * lane 决策达成前不建 WS（防首连落错 slot）；3s 兜底放行防死锁（见 useLaneGate）。
   */
  laneReady: boolean;
  /** 进入工作区且非 demo。*/
  enabled: boolean;
  defaultAgentId?: string;
  /** 商业版余额刷新（cost_charged / 4506 / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 自动免单站内信提交后的未读角标刷新。 */
  refreshInbox?: () => void;
  /** 当前登录用户 id：IndexedDB 持久按它命名空间（隐私隔离）。null=不持久。*/
  userId?: string | null;
  /** boot/登录从 IndexedDB 读回会话后回调（供侧栏装载本地会话）。*/
  onHydrated?: (stored: StoredSession[]) => void;
  /** GitHub 仓库绑定状态帧回调（容器→bridge→client）。交 useRepoBinding 消费。*/
  onRepoStatus?: (frame: RepoStatusWire) => void;
  /** GitHub 绑定校验失败帧回调。*/
  onRepoBindError?: (frame: RepoBindErrorWire) => void;
}): UseChatSocket {
  const { auth, ready, laneReady, enabled, defaultAgentId, refreshBalance, refreshInbox, userId, onHydrated } = opts;

  // authRef / refreshBalanceRef：让 service deps 永远读到最新闭包，无 stale。
  const authRef = useRef(auth);
  authRef.current = auth;
  const refreshBalanceRef = useRef(refreshBalance);
  refreshBalanceRef.current = refreshBalance;
  const refreshInboxRef = useRef(refreshInbox);
  refreshInboxRef.current = refreshInbox;
  const defaultAgentRef = useRef(defaultAgentId);
  defaultAgentRef.current = defaultAgentId;
  const onHydratedRef = useRef(onHydrated);
  onHydratedRef.current = onHydrated;
  // 仓库绑定帧回调:经 ref 让单例 service 永远读到最新闭包(socket 只构造一次)。
  const onRepoStatusRef = useRef(opts.onRepoStatus);
  onRepoStatusRef.current = opts.onRepoStatus;
  const onRepoBindErrorRef = useRef(opts.onRepoBindError);
  onRepoBindErrorRef.current = opts.onRepoBindError;

  // 持久存储（按 user 命名空间）+ 立即落盘句柄 + 写盘签名（防无谓 IDB 写）。
  const storeRef = useRef<SessionStore | null>(null);
  const persistRef = useRef<(sessId: string) => void>(() => {});
  const sigRef = useRef<Map<string, string>>(new Map());
  // IndexedDB 注水是否完成：持久启用时，connect 须等注水完成，否则首个 hello 不带恢复的
  // 断点续传游标（restored 会话无法 auto-resume，要等下次重连才补）。
  const [hydrationDone, setHydrationDone] = useState(false);

  // 单例 service：整个组件生命周期复用同一实例。
  const socketRef = useRef<ChatSocket | null>(null);
  if (!socketRef.current) {
    socketRef.current = new ChatSocket({
      getToken: () => authRef.current?.snapshot().token ?? "",
      getAuthEpoch: () => authRef.current?.snapshot().epoch ?? -1,
      silentRefresh: async (expectedEpoch) => {
        const session = authRef.current;
        if (!session) return { kind: "stale", epoch: expectedEpoch };
        return api.refresh(session, expectedEpoch, "ws_auth");
      },
      onAuthExpired: (expectedEpoch) => authRef.current?.expire(expectedEpoch),
      refreshBalance: () => refreshBalanceRef.current?.(),
      refreshInbox: () => refreshInboxRef.current?.(),
      reportClientError: (p) => {
        reportClientFriction({
          surface: "chat",
          stage: p.type,
          code: p.code,
          traceId: p.traceId,
          sessionId: p.sessionId,
        }, authRef.current?.snapshot().token);
      },
      // resume_failed / 重连 reconcile：有游标走 REST 增量、无游标才全量；两者都以 server
      // 为最终权威源并走 applyServerMessages 收口（含 client-owned 行保留与团队卡归一化）。
      syncSession: async (sessId, context) => {
        const a = authRef.current;
        if (!a) return;
        const socket = socketRef.current;
        const sess = socket?.sessions.get(sessId);
        if (!sess) return;
        try {
          const sinceSeq = typeof sess._maxSeq === "number" && sess._maxSeq > 0 ? sess._maxSeq : 0;
          const detail = await api.getSession(a, sessId, sinceSeq);
          const serverMsgs = Array.isArray(detail.messages) ? (detail.messages as ChatMessage[]) : null;
          // 只在 server 返回非空 tape 时合并——绝不用空结果抹掉活转录。热尾巴:透传归档水位,
          // 本地 `_seq ≤ archivedThroughSeq`的旧行才不会被"server 不认识 = 丢弃"误杀。
          if (serverMsgs && (serverMsgs.length > 0 || detail.isPartial)) {
            socket?.applyServerMessages(
              sessId,
              detail.agentId || sess.agentId,
              serverMsgs,
              !detail.isPartial,
              detail.maxSeq,
              {
              archivedThroughSeq: detail.archivedThroughSeq,
              archivedCount: detail.archivedCount,
              completedClientMessageId: context?.clientMessageId,
              serverUpdatedAt: detail.updatedAt,
              },
            );
          }
          sess._liveStreamBroken = false;
          persistRef.current(sessId); // server-wins 合并后落地新 tape + 游标
        } catch {
          /* sync 失败：保留现状，下次重连/前台再试 */
        }
      },
      syncGoalState: async (sessId) => {
        const a = authRef.current;
        if (!a) return;
        const goal = await api.getSessionGoal(a, sessId);
        socketRef.current?.setGoalState(sessId, goal);
      },
      // 首次发消息前在主控建 client_sessions 行（见 socket.ts deps.ensureServerSession 注释）。
      // fire-and-forget：建行是快 REST，远早于容器跑完 turn 后的 authored POST；失败不阻塞发送
      // （容器 append 自带重试 + syncSession GET 兜底）。messages:[] + baseSyncedAt:0 → 已存在
      // 则 rejected_stale 空操作，绝不 clobber server-authored 历史。
      ensureServerSession: async (sessId, agentId, title, modelId) => {
        const a = authRef.current;
        if (!a) return false; // 未登录:不标 ensured,登录后下次发送重试
        try {
          // modelId(会话级模型选择)随建行携带;受理路径抢先建行(PR#126)时本 PUT 409,
          // 由 socket 侧建行确认后的 persistSessionModel PATCH 收敛。
          await api.putSession(a, sessId, {
            agentId,
            title: title || "新会话",
            messages: [],
            ...(modelId ? { modelId } : {}),
            _baseSyncedAt: 0,
          });
          return true; // PUT 200:建行确认
        } catch (e) {
          // 409 = 行已存在(并发抢先 / 已建)→ 同样视为已确认,不必重试;其余(网络/5xx/401)→ 重试。
          return (e as { status?: number } | null)?.status === 409;
        }
      },
      // 会话级模型选择收敛补写(建行确认后由 socket 调;best-effort,失败下次选择/发送再收敛)。
      persistSessionModel: async (sessId, modelId) => {
        const a = authRef.current;
        if (!a) return;
        try {
          await api.patchSessionModel(a, sessId, modelId);
        } catch {
          /* best-effort:本地 + IndexedDB 仍在;下次显式选择或跨设备打开时以 server 为准 */
        }
      },
      // 跨设备持久化用户消息(行已由 ensureServerSession 建)。best-effort,失败静默。
      persistUserMessage: async (sessId, msg) => {
        const a = authRef.current;
        if (!a) return;
        try {
          await api.appendUserMessage(a, sessId, msg);
        } catch {
          /* best-effort:本地 + IndexedDB 仍在,仅跨设备该条不显 */
        }
      },
      // resume_failed 游标推进 / isFinal turn 收尾：立即落 IndexedDB（防 reload 死循环 + 不丢轮）。
      persistSession: (sessId) => persistRef.current(sessId),
      // GitHub 仓库绑定状态/错误帧 → 透传给 useRepoBinding（经 ref，无 stale）。
      onRepoStatus: (frame) => onRepoStatusRef.current?.(frame),
      onRepoBindError: (frame) => onRepoBindErrorRef.current?.(frame),
      defaultAgentId: defaultAgentRef.current,
    });
  }
  const socket = socketRef.current;

  // 订阅 service 快照。
  const snap = useSyncExternalStore(socket.subscribe, socket.getSnapshot);

  // 立即落盘句柄（isFinal / resume_failed / syncSession 触发）：读当前 store，写盘并更新签名。
  persistRef.current = (sessId: string) => {
    const store = storeRef.current;
    if (!store) return;
    const stored = socket.toStored(sessId);
    if (!stored) return;
    sigRef.current.set(sessId, persistSignature(stored));
    void store.putSession(stored);
  };

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

  // gate.ready 作为 connect 硬前置喂给 service。持久启用（userId 在）时，须等 IndexedDB
  // 注水完成再放行连接，让首个 hello 带上恢复的 per-session 游标（boot auto-resume）。
  // 禁用（登出/换号）时显式把 gateReady 降为 false：单例 service 的 connect 闸是边沿触发
  // （ready && !was 才 connect），若登出不复位，再登录时 ready 仍 === was(true) → 永不重连。
  useEffect(() => {
    if (!enabled || !auth) {
      socket.setGateReady(false);
      return;
    }
    if (userId && !hydrationDone) return;
    socket.setGateReady(ready);
  }, [enabled, auth, ready, socket, userId, hydrationDone]);

  // cohort lane 就绪闸（P3 RFC D1）：与 gateReady 正交的第二连接前置，独立喂给 service。
  // 未登录/登出 → 复位 false（下次认证经 laneReady 重新上升沿放行）。两闸在 socket.connect
  // 里双真才建连，谁后到位谁触发 connect，故与 gate effect 的执行顺序无关、无竞态。
  useEffect(() => {
    socket.setLaneReady(!!(enabled && auth) && laneReady);
  }, [enabled, auth, laneReady, socket]);

  // 持久存储生命周期：登录(enabled+userId)→开 store + 从 IndexedDB 注水会话（reload 不丢）；
  // 卸载/登出→flush + close。pagehide / 切到后台时同步 flush，保 mid-stream reload 不丢。
  // 此 effect 必须声明在下方 debounce 落盘 effect 之前（同 commit 内先建 store 再消费）。
  useEffect(() => {
    if (!enabled || !userId) return;
    const store = new SessionStore(userId);
    storeRef.current = store;
    sigRef.current = new Map();
    setHydrationDone(false);
    let cancelled = false;

    const flushAll = () => {
      const st = storeRef.current;
      if (!st) return;
      for (const [id] of socket.sessions) {
        const stored = socket.toStored(id);
        if (!stored) continue;
        sigRef.current.set(id, persistSignature(stored));
        void st.putSession(stored);
      }
    };

    // 注水是 best-effort：成功 / 失败(IndexedDB 隐私模式·配额·headless 不可用) / 超时
    // **都必须放行 gate**,否则 WS 连接被永久阻塞 → 整个聊天打不开(P6 回归根因:原
    // getAll().then 无 catch,IDB reject 即 hydrationDone 永 false)。失败仅降级"无持久"。
    let hydrationSettled = false;
    const releaseHydration = () => {
      if (cancelled || hydrationSettled) return;
      hydrationSettled = true;
      setHydrationDone(true);
    };
    const hydrationTimer = setTimeout(releaseHydration, 3000); // IDB 卡住兜底,不无限等
    void store
      .getAll()
      .then((all) => {
        if (cancelled) return;
        for (const stored of all) socket.loadStored(stored);
        onHydratedRef.current?.(all);
      })
      .catch(() => {
        /* IndexedDB 不可用 → 降级无持久,聊天仍可用 */
      })
      .finally(() => {
        clearTimeout(hydrationTimer);
        releaseHydration();
      });

    const onHide = () => flushAll();
    const onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") flushAll();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      clearTimeout(hydrationTimer);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
      // teardown 仅发生在登出/换号（enabled/userId 变）：先 final flush（wipe 后 dead→no-op），
      // 再清内存会话（隐私收尾，防换号后旧会话残留单例），最后关 store。
      flushAll();
      socket.resetSessions();
      store.close();
      if (storeRef.current === store) storeRef.current = null;
      sigRef.current = new Map();
      setHydrationDone(false);
    };
  }, [enabled, userId, socket]);

  // 流式期尾沿 debounce 落盘（高频 delta 不每帧写 IDB）；签名去重避免无谓写。
  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    const t = setTimeout(() => {
      for (const [id] of socket.sessions) {
        const stored = socket.toStored(id);
        if (!stored) continue;
        const sig = persistSignature(stored);
        if (sigRef.current.get(id) === sig) continue;
        sigRef.current.set(id, sig);
        void store.putSession(stored);
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [snap.version, socket]);

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
  const ensureServerSession = useCallback<UseChatSocket["ensureServerSession"]>(
    (sessId, agentId, title) => socket.ensureServerSession(sessId, agentId, title),
    [socket],
  );
  const removeSession = useCallback((sessId: string) => socket.removeSession(sessId), [socket]);
  const renameSession = useCallback(
    (sessId: string, title: string) => socket.renameSession(sessId, title),
    [socket],
  );
  const setSessionModel = useCallback(
    (sessId: string, modelId: string) => socket.setSessionModel(sessId, modelId),
    [socket],
  );
  const switchAgent = useCallback((sessId: string, agentId: string) => socket.switchAgent(sessId, agentId), [socket]);
  const send = useCallback<UseChatSocket["send"]>((p) => socket.sendMessage(p), [socket]);
  const stop = useCallback((sessId: string) => socket.stopTurn(sessId), [socket]);
  const retryMessage = useCallback<UseChatSocket["retryMessage"]>((p) => socket.retryMessage(p), [socket]);
  const setActiveSession = useCallback((sessId: string | undefined) => socket.setActiveSession(sessId), [socket]);
  const setGoalState = useCallback<UseChatSocket["setGoalState"]>(
    (sessId, goal) => socket.setGoalState(sessId, goal),
    [socket],
  );
  const getTransientNotice = useCallback(
    (sessId: string | undefined) => {
      void snap.version; // 随快照版本触发重算（transient 提示 set/clear 都 scheduleNotify）
      return sessId ? socket.getTransientNotice(sessId) : null;
    },
    [snap, socket],
  );
  const respondPermission = useCallback<UseChatSocket["respondPermission"]>(
    (p) => socket.respondPermission(p),
    [socket],
  );

  const mergeServerHistory = useCallback<UseChatSocket["mergeServerHistory"]>(
    (p) => {
      socket.applyServerMessages(p.sessId, p.agentId, p.messages, p.full, p.maxSeq, {
        archivedThroughSeq: p.archivedThroughSeq,
        archivedCount: p.archivedCount,
        serverUpdatedAt: p.serverUpdatedAt,
        modelId: p.modelId,
      });
      persistRef.current(p.sessId); // 合并后落地（含推进的 _maxSeq 游标 + 归档水位/计数）
    },
    [socket],
  );
  // 归档滚动加载并发闸(同会话在途不重入,防用户连点 / 组件重渲重复拉同一页)。
  const olderHistoryFetchingRef = useRef<Set<string>>(new Set());
  const loadOlderHistory = useCallback<UseChatSocket["loadOlderHistory"]>(
    async (sessId) => {
      const a = authRef.current;
      if (!a || !sessId) return { ok: false, loaded: 0, hasMore: false };
      if (olderHistoryFetchingRef.current.has(sessId)) return { ok: false, loaded: 0, hasMore: false };
      olderHistoryFetchingRef.current.add(sessId);
      try {
        const before = socket.archiveBeforeSeq(sessId);
        const page = await api.getSessionArchive(a, sessId, before);
        const msgs = Array.isArray(page.messages) ? (page.messages as ChatMessage[]) : [];
        if (msgs.length > 0) {
          socket.prependArchivedMessages(sessId, msgs);
          persistRef.current(sessId); // 前插后落地(下次 reload 直接展示已拉回的旧历史)
        }
        return { ok: true, loaded: msgs.length, hasMore: !!page.hasMore };
      } catch {
        return { ok: false, loaded: 0, hasMore: true, error: true }; // 失败:保留"可重试",hasMore 不封死
      } finally {
        olderHistoryFetchingRef.current.delete(sessId);
      }
    },
    [socket],
  );
  // §9 折叠卷展开并发闸(按 sessId::anchorId,同 anchor 在飞不重入)。
  const expandingTapesRef = useRef<Set<string>>(new Set());
  const expandCollapsedTape = useCallback<UseChatSocket["expandCollapsedTape"]>(
    async (sessId, anchorId, tapeId, cursor) => {
      const a = authRef.current;
      if (!a || !sessId || !anchorId || !tapeId) return { ok: false };
      const guardKey = `${sessId}::${anchorId}`;
      if (expandingTapesRef.current.has(guardKey)) return { ok: false, busy: true };
      expandingTapesRef.current.add(guardKey);
      try {
        const page = await api.getTapeRecords(a, sessId, tapeId, cursor ?? null);
        const records = Array.isArray(page.records) ? (page.records as ChatMessage[]) : [];
        const nextCursor = typeof page.nextCursor === "number" ? page.nextCursor : null;
        // applyExpandedTapeRecords 内部已 persistSession + scheduleNotify(展开态随 IndexedDB 往返保留)。
        socket.applyExpandedTapeRecords(sessId, anchorId, records, nextCursor);
        return { ok: true, nextCursor, total: typeof page.total === "number" ? page.total : records.length };
      } catch {
        return { ok: false, error: true }; // 失败:卡片保留"可重试",不封死
      } finally {
        expandingTapesRef.current.delete(guardKey);
      }
    },
    [socket],
  );
  const collapseTape = useCallback<UseChatSocket["collapseTape"]>(
    (sessId, anchorId) => {
      if (!sessId || !anchorId) return;
      socket.collapseTape(sessId, anchorId);
    },
    [socket],
  );
  const fetchTapeRecords = useCallback<UseChatSocket["fetchTapeRecords"]>(
    async (sessId, tapeId, cursor) => {
      const a = authRef.current;
      if (!a || !sessId || !tapeId) return null;
      try {
        const page = await api.getTapeRecords(a, sessId, tapeId, cursor ?? null);
        return {
          records: Array.isArray(page.records) ? (page.records as ChatMessage[]) : [],
          nextCursor: typeof page.nextCursor === "number" ? page.nextCursor : null,
          total: typeof page.total === "number" ? page.total : 0,
        };
      } catch {
        return null;
      }
    },
    [],
  );
  const fetchTapeRecordChunk = useCallback<UseChatSocket["fetchTapeRecordChunk"]>(
    async (sessId, tapeId, recordOrdinal, offset) => {
      const a = authRef.current;
      if (!a || !sessId || !tapeId || !Number.isInteger(recordOrdinal) || recordOrdinal < 0) return null;
      try {
        const r = await api.getTapeRecordChunk(a, sessId, tapeId, recordOrdinal, offset ?? 0);
        return {
          chunk: typeof r.chunk === "string" ? r.chunk : "",
          nextOffset: typeof r.nextOffset === "number" ? r.nextOffset : null,
          totalBytes: typeof r.totalBytes === "number" ? r.totalBytes : 0,
        };
      } catch {
        return null;
      }
    },
    [],
  );
  const storedMaxSeq = useCallback(
    (sessId: string | undefined) => {
      void snap.version;
      return (sessId && snap.sessions.get(sessId)?._maxSeq) || 0;
    },
    [snap],
  );
  const removePersisted = useCallback((sessId: string) => {
    sigRef.current.delete(sessId);
    const st = storeRef.current;
    if (st) void st.deleteSession(sessId);
  }, []);
  const wipePersistence = useCallback(async () => {
    sigRef.current.clear();
    const st = storeRef.current;
    if (st) await st.wipe();
  }, []);
  const sendRepoBind = useCallback(
    (sessId: string, agentId: string, version: number) => socket.sendRepoBind(sessId, agentId, version),
    [socket],
  );
  const sendRepoUnbind = useCallback(
    (sessId: string, version: number) => socket.sendRepoUnbind(sessId, version),
    [socket],
  );

  return useMemo(
    () => ({
      status: snap.status,
      provisioning: snap.provisioning,
      browserOnline: snap.browserOnline,
      version: snap.version,
      getMessages,
      getSession,
      isSending,
      ensureSession,
      ensureServerSession,
      removeSession,
      renameSession,
      setSessionModel,
      switchAgent,
      send,
      stop,
      retryMessage,
      setActiveSession,
      setGoalState,
      getTransientNotice,
      respondPermission,
      mergeServerHistory,
      storedMaxSeq,
      loadOlderHistory,
      expandCollapsedTape,
      collapseTape,
      fetchTapeRecords,
      fetchTapeRecordChunk,
      removePersisted,
      wipePersistence,
      sendRepoBind,
      sendRepoUnbind,
    }),
    [
      snap,
      getMessages,
      getSession,
      isSending,
      ensureSession,
      ensureServerSession,
      removeSession,
      renameSession,
      setSessionModel,
      switchAgent,
      send,
      stop,
      retryMessage,
      setActiveSession,
      setGoalState,
      getTransientNotice,
      respondPermission,
      mergeServerHistory,
      storedMaxSeq,
      loadOlderHistory,
      expandCollapsedTape,
      collapseTape,
      fetchTapeRecords,
      fetchTapeRecordChunk,
      removePersisted,
      wipePersistence,
      sendRepoBind,
      sendRepoUnbind,
    ],
  );
}

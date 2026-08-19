import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/ui";
import { ApiError, api } from "../lib/api";
import type { ChatMessage } from "../lib/chat/model";
import { DEMO_SESSIONS } from "../lib/demo";
import type { StoredSession } from "../lib/persist";
import type { AuthSession, Session, SessionLastOutcome, SessionMeta, User } from "../lib/types";
import type { UseChatSocket } from "./useChatSocket";

/** 历史重拉冷却（S2）：同会话此窗口内只拉一次；过后允许增量重拉（sinceSeq + server-wins 幂等）。*/
const HISTORY_REFETCH_COOLDOWN_MS = 5000;

/** WS 会话 id（peer.id）：须匹配后端 `[A-Za-z0-9_-]{8,50}`。*/
export function genWsSessionId(): string {
  return `web${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function makeLocalSession(title: string, ownerUserId: string): Session {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || "新对话",
    ownerUserId,
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    pinned: false,
    projectId: null,
    runState: "idle",
    lastOutcome: null,
  };
}

/** IndexedDB 注水的 StoredSession → 侧栏 Session（updatedAt 统一 ISO 串，便于排序展示）。*/
function storedToSession(s: StoredSession, ownerUserId: string): Session {
  return {
    id: s.id,
    title: s.title || "新对话",
    ownerUserId,
    updatedAt: new Date(s.updatedAt ?? s.lastAt ?? Date.now()).toISOString(),
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    // modelId 无值时不落键:upsertSessions 的 spread 合并按"键缺席=不表态"保留另一侧的值。
    ...(s._selectedModelId ? { modelId: s._selectedModelId } : {}),
  };
}

/** server canonical SessionMeta（gateway listSessions）→ 侧栏 Session。*/
function metaToSession(m: SessionMeta, ownerUserId: string): Session {
  return {
    id: m.id,
    title: m.title || "新对话",
    ownerUserId,
    updatedAt: new Date(m.updatedAt ?? m.lastAt ?? Date.now()).toISOString(),
    messageCount: m.messageCount ?? 0,
    pinned: m.pinned === true,
    projectId: m.projectId ?? null,
    runState: m.runState === "running" ? "running" : "idle",
    lastOutcome: m.lastOutcome ?? null,
    lastErrorCode: m.lastErrorCode ?? null,
    // 服务端无值(该会话从未显式选过/PATCH 尚未落地)= 键缺席,server-wins 合并不清掉本地意图。
    ...(m.modelId ? { modelId: m.modelId } : {}),
    ...(m.agentId ? { agentId: m.agentId } : {}),
  };
}

/**
 * 合并侧栏会话：union by id，按 updatedAt 倒序。`incomingWins` 决定重叠项谁覆盖元数据
 * （listSessions=server-wins=true；IndexedDB 注水=本地不覆盖既有=false）。
 */
function upsertSessions(cur: Session[], incoming: Session[], incomingWins: boolean): Session[] {
  const map = new Map<string, Session>();
  for (const s of cur) map.set(s.id, s);
  for (const s of incoming) {
    const prev = map.get(s.id);
    map.set(s.id, prev ? (incomingWins ? { ...prev, ...s } : { ...s, ...prev }) : s);
  }
  return [...map.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

export type UseSessionListOptions = {
  demo: boolean;
  auth: AuthSession | null;
  /** AuthSession 稳定引用（= App authRef.current，整个生命周期同一对象）：异步/事件回调用。 */
  authSession: AuthSession;
  user: User | null;
  /** 当前选中 agent id（loadHistory 里 detail.agentId 缺省时的回落归属）。 */
  agentId: string;
  /** WS 引擎稳定句柄（App 在 useChatSocket 调用后回填；经 ref 读最新，避免依赖每帧重建的 chat）。 */
  sockRef: React.MutableRefObject<UseChatSocket | null>;
  /** Aurora 确认/输入对话框（Promise 式，App 的 useConfirm/usePrompt 注入 —— 数据层不持有 UI）。 */
  confirmDialog: (opts: {
    title: string;
    body?: React.ReactNode;
    confirmText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  promptText: (opts: { title: string; initial?: string }) => Promise<string | null>;
  /** 清除对话错误横幅（切换/新建会话时）。 */
  clearChatError: () => void;
  /** demo：切会话时换本地 fixture 消息。 */
  onDemoSelect?: (id: string) => void;
  /** 新建会话前的收尾：停 demo 流式回放 + 清空展示消息 + 清错误。 */
  onNewSessionReset: () => void;
  /** 删除会话时的 App 侧存储收尾（demo localStore）。 */
  onDeleteSession?: (id: string) => void;
  /** 删除的是当前活动会话：App 清展示消息 + 错误。 */
  onActiveSessionDeleted: () => void;
  /**
   * URL 会话深链恢复未决（P7 路由）：true 时暂停"自动选中上次会话"——URL 指定 > 最近会话。
   * 深链 resolve/放弃后置 false，自动选中恢复正常判定。
   */
  holdAutoSelect?: boolean;
};

export type UseSessionList = {
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  activeId: string | undefined;
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
  selectSession: (id: string) => void;
  newSession: () => void;
  /** 会话模型显式选择的服务端同步入口(App.selectModel 调):选择即挂 per-session
   *  pending 意图 + 单飞串行合并 PATCH。pending 存续期 + 已同步水位之下的 list/detail
   *  载荷,其 modelId 一律视为陈旧不应用 —— 同时拦「旧响应迟到盖回」与「连续快选
   *  PATCH 倒序落库」两类竞态(Codex 审 MAJOR ×2)。失败解除 pending(本地意图保留,
   *  服务端有旧值则 server-wins 盖回可重选)。*/
  queueModelPatch: (sessId: string, modelId: string) => void;
  /** IndexedDB 注水回调（喂给 useChatSocket.onHydrated）。 */
  onHydrated: (stored: StoredSession[]) => void;
  renameSessionPrompt: (s: Session) => Promise<void>;
  deleteSessionConfirm: (s: Session) => Promise<void>;
  togglePinSession: (s: Session) => Promise<void>;
  moveSessionToProject: (s: Session, projectId: string | null) => Promise<void>;
  applySessionTerminal: (
    sessId: string,
    terminal: { lastOutcome: SessionLastOutcome; lastErrorCode: string | null } | null,
  ) => void;
  /** 登出/登录时的整体重置：清列表与选中、清已拉历史标记、允许重新自动选中最近会话。 */
  reset: () => void;
  /** listSessions 已落定（成功或失败）：URL 深链恢复据此判定"会话确实不存在"。 */
  serverListSettled: boolean;
  /** 当前活动会话的 canonical history 请求仍在途。用于避免慢响应期间误显空会话。 */
  historyLoading: boolean;
  /** GET 失败且按 sessionId+token 隔离。404 不算失败。 */
  historyError: { sessionId: string; token: number; message: string } | null;
  /** 直接重拉当前会话历史，不走 selectSession（同 activeId 会提前返回）。 */
  retryHistory: (id: string) => void;
  loadHistory: (id: string, opts?: { force?: boolean }) => Promise<void>;
};

/**
 * 侧栏会话列表域（从 App.tsx 整体收口，语义逐条保留）：
 * - 列表权威合并：IndexedDB 注水（本地不覆盖既有）+ listSessions（server-wins）；
 * - 按需拉取单会话 server 历史合并进 WS service（防并发 + 短时去重，冷却过后允许增量重拉）；
 * - 登录后自动选中"上次会话"仅做一次（autoSelectedRef）；
 * - rename/delete 一次收口三个持有方（App state + WS service/IndexedDB + 服务端）。
 * UI（确认/输入对话框）与 chat 展示态（demo messages/chatError）经回调注入，
 * 本 hook 不反向依赖渲染层。
 */
export function useSessionList(opts: UseSessionListOptions): UseSessionList {
  const { demo, auth, user, agentId, holdAutoSelect = false } = opts;
  // 回调/句柄经 ref 镜像：App 每渲染可能传新闭包，这里始终读最新版本而不进 useCallback
  // 依赖（保持 selectSession/newSession 依赖面与拆分前一致；useChatSocket persistRef 同款）。
  const cbRef = useRef(opts);
  cbRef.current = opts;
  const toast = useToast();

  const [sessions, setSessions] = useState<Session[]>(demo ? DEMO_SESSIONS : []);
  const [activeId, setActiveId] = useState<string | undefined>(
    demo ? DEMO_SESSIONS[0].id : undefined,
  );
  // 历史拉取守卫（S2）：语义从"整页生命周期只拉一次"改为"只防并发 + 短时重复"。
  //  - historyFetchingRef：正在拉取的会话（防并发重入）；
  //  - historyFetchedAtRef：上次拉取时刻，HISTORY_REFETCH_COOLDOWN_MS 内不重拉。
  // 冷却过后允许重拉：sinceSeq 增量 + server-wins 合并幂等、重拉无副作用，这样切回前台/
  // 重连后重新选中会话能增量补齐（旧的永久守卫会让锁屏后再选中的会话拿不到新内容）。
  const historyFetchingRef = useRef<Map<string, number>>(new Map());
  const historyRequestTokenRef = useRef(0);
  const [historyLoadingTokens, setHistoryLoadingTokens] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [historyErrorBySession, setHistoryErrorBySession] = useState<
    Map<string, { token: number; message: string }>
  >(() => new Map());
  const historyFetchedAtRef = useRef<Map<string, number>>(new Map());
  // 登录后是否已自动选中"上次会话"（仅做一次：避免覆盖用户随后的显式新建/切换/删除）。
  const autoSelectedRef = useRef(false);
  // 当前登录 user id 的实时镜像：异步历史请求 await 后比对，防登出/换号后 stale 响应
  // 把上一个用户的历史污染进单例 WS service / 写进新用户的 IndexedDB 命名空间（隐私）。
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  // 会话模型显式选择的同步状态(sessId → {floor, pending, inflight}),见 queueModelPatch 注释:
  //  - floor:已确认落库的 PATCH 返回 updatedAt(取 max)。低于它的载荷 modelId 视为陈旧。
  //  - pending:最新未落库的显式选择。存续期内一切载荷 modelId 不应用(本地意图优先);
  //    也是"连选合并"的载体 —— 单飞循环每轮取最新 pending,旧值绝不出网,写天然串行无倒序。
  //  - inflight:单飞闸(同会话同时至多一个 PATCH 在途)。
  const modelSyncRef = useRef<Map<string, { floor: number; pending?: string; inflight: boolean }>>(
    new Map(),
  );
  /** 载荷里的 modelId 是否应被应用(false=pending 存续或低于已确认水位 → 陈旧/被本地意图压制)。*/
  const modelPayloadFresh = useCallback((sessId: string, payloadUpdatedAt: number): boolean => {
    const st = modelSyncRef.current.get(sessId);
    if (!st) return true;
    if (st.pending !== undefined) return false;
    return payloadUpdatedAt >= st.floor;
  }, []);
  const queueModelPatch = useCallback((sessId: string, modelId: string) => {
    let st = modelSyncRef.current.get(sessId);
    if (!st) {
      st = { floor: 0, inflight: false };
      modelSyncRef.current.set(sessId, st);
    }
    st.pending = modelId; // 选择即挂意图:从此刻起载荷 modelId 被压制,无窗口
    if (st.inflight) return; // 在途 PATCH 完成后单飞循环会取走最新 pending
    st.inflight = true;
    void (async () => {
      try {
        while (st.pending !== undefined) {
          const v = st.pending;
          try {
            const r = await api.patchSessionModel(cbRef.current.authSession, sessId, v);
            if (r.updatedAt > st.floor) st.floor = r.updatedAt;
            if (st.pending === v) st.pending = undefined; // 期间无更新选择 → 收敛
          } catch {
            // 失败(404 行未建/网络/5xx):
            //  - pending 仍是本值 → 解除并退出(本地意图仍在侧栏/socket/IndexedDB;服务端有
            //    旧值则下次 list server-wins 盖回可重选,行未建则由建行 PUT/收敛 PATCH 落地);
            //  - pending 已被更新(失败期间用户又选了新值)→ **继续循环把最新意图发出去**,
            //    绝不 break —— 否则新 pending 永不出网且永久压制服务端载荷(Codex 审 MAJOR)。
            if (st.pending === v) {
              st.pending = undefined;
              break;
            }
          }
        }
      } finally {
        st.inflight = false;
      }
    })();
  }, []);

  // IndexedDB 注水回调：把本地会话填进侧栏（本地优先；随后 listSessions server-wins 覆盖元数据）。
  const onHydrated = useCallback(
    (stored: StoredSession[]) => {
      const owner = user?.id;
      if (!owner || stored.length === 0) return;
      const local = stored.map((s) => storedToSession(s, owner));
      setSessions((cur) => upsertSessions(cur, local, false));
    },
    [user],
  );

  // 按需拉取单会话 server canonical 历史并合并进 WS service（server-wins / id 幂等）。
  // 经稳定 sockRef 调用历史方法，避免依赖每帧重建的 chat 引用。
  const loadHistory = useCallback(
    async (id: string, opts?: { force?: boolean }) => {
      const owner = userIdRef.current;
      if (!auth || !owner) return;
      if (!opts?.force && historyFetchingRef.current.has(id)) return; // 并发中：不重入
      const lastAt = historyFetchedAtRef.current.get(id) ?? 0;
      if (!opts?.force && Date.now() - lastAt < HISTORY_REFETCH_COOLDOWN_MS) return; // 短时重复：不重拉
      if (opts?.force && historyFetchingRef.current.has(id)) return;
      const requestToken = ++historyRequestTokenRef.current;
      historyFetchingRef.current.set(id, requestToken);
      setHistoryLoadingTokens((current) => {
        const next = new Map(current);
        next.set(id, requestToken);
        return next;
      });
      try {
        const sinceSeq = cbRef.current.sockRef.current?.storedMaxSeq(id) ?? 0;
        const sinceHistoryRevision = cbRef.current.sockRef.current?.storedHistoryRevision(id);
        const detail = await api.getSession(
          cbRef.current.authSession,
          id,
          sinceSeq,
          sinceHistoryRevision,
        );
        // await 期间换号、reset 或删除会话 → 丢弃旧响应，绝不污染当前会话/IndexedDB。
        if (
          userIdRef.current !== owner ||
          historyFetchingRef.current.get(id) !== requestToken
        ) return;
        const msgs = Array.isArray(detail.messages) ? (detail.messages as ChatMessage[]) : [];
        // 会话模型陈旧载荷拦截:pending 意图存续/低于已确认写水位的 detail,其 modelId
        // 不应用(消息合并照常 —— socket 有自己的版本护栏)。
        const freshModelId =
          typeof detail.updatedAt === "number" && modelPayloadFresh(id, detail.updatedAt)
            ? detail.modelId
            : undefined;
        cbRef.current.sockRef.current?.mergeServerHistory({
          sessId: id,
          agentId: detail.agentId || agentId,
          messages: msgs,
          full: !detail.isPartial,
          maxSeq: detail.maxSeq,
          // 热尾巴:server 可能只回 `_seq > archivedThroughSeq` 的一截;透传水位/计数,
          // full 合并才不丢本地已归档旧行,并记录归档计数供 UI 展示。
          archivedThroughSeq: detail.archivedThroughSeq,
          archivedCount: detail.archivedCount,
          serverUpdatedAt: detail.updatedAt,
          modelId: freshModelId,
          historyRevision: detail.historyRevision,
          timelineGeneration: detail.timelineGeneration,
          timelineCursor: detail.timelineCursor,
          timelineHasMore: detail.timelineHasMore,
          timelineSnapshotMaxSeq: detail.timelineSnapshotMaxSeq,
          invalidateHistoryCache: detail._historyRevisionUnsupported === true,
          openDispatch: detail.openDispatch,
        });
        // Canonical GET is enough to dismiss the history skeleton. Journal
        // hydrate is a background fill — awaiting it used to pin
        // 「正在加载会话内容…」for as long as live-frames hung.
        if (historyFetchingRef.current.get(id) === requestToken) {
          setHistoryLoadingTokens((current) => {
            if (current.get(id) !== requestToken) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }
        const liveSocket = cbRef.current.sockRef.current;
        if (liveSocket?.hydrateDurableLiveFrameJournal) {
          void liveSocket.hydrateDurableLiveFrameJournal(
            id,
            (after) => api.getSessionLiveFrames(
              cbRef.current.authSession,
              id,
              after,
              500,
            ),
            async () => {
              const tapeDetail = await api.getSession(cbRef.current.authSession, id, 0);
              liveSocket.mergeServerHistory({
                sessId: id,
                agentId: tapeDetail.agentId || agentId,
                messages: Array.isArray(tapeDetail.messages) ? tapeDetail.messages as ChatMessage[] : [],
                full: !tapeDetail.isPartial,
                maxSeq: tapeDetail.maxSeq,
                archivedThroughSeq: tapeDetail.archivedThroughSeq,
                archivedCount: tapeDetail.archivedCount,
                serverUpdatedAt: tapeDetail.updatedAt,
                modelId: tapeDetail.modelId,
                historyRevision: tapeDetail.historyRevision,
                timelineGeneration: tapeDetail.timelineGeneration,
                timelineCursor: tapeDetail.timelineCursor,
                timelineHasMore: tapeDetail.timelineHasMore,
                timelineSnapshotMaxSeq: tapeDetail.timelineSnapshotMaxSeq,
                invalidateHistoryCache: tapeDetail._historyRevisionUnsupported === true,
              });
            },
          ).catch(() => {
            /* hydrate degrades internally; a thrown first page must not resurrect the skeleton */
          });
        }
        // 会话级模型选择的侧栏回填:detail 比 boot 时的 listSessions 新(他设备刚改过),
        // 不回填则 App 恢复选择器仍读侧栏旧值。server-wins,detail 无值不清本地
        // (服务端 NULL 只表示"从未显式选择",不存在"清除"流,缺席=不表态)。
        if (freshModelId) {
          setSessions((c) =>
            c.map((s) => (s.id === id && s.modelId !== freshModelId ? { ...s, modelId: freshModelId } : s)),
          );
        }
        historyFetchedAtRef.current.set(id, Date.now());
        setHistoryErrorBySession((current) => {
          const existing = current.get(id);
          if (!existing || existing.token > requestToken) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      } catch (e) {
        // 404 = 本地新建/未同步会话，无 server 历史（正常）：打冷却戳，避免每次重选都空打 404，
        // 但仍非永久（会话后续被 server 持久化后，冷却过去可正常增量拉到）。其他错误不打戳 →
        // 允许下次重选立即重试。
        if (
          e instanceof ApiError &&
          e.status === 404 &&
          historyFetchingRef.current.get(id) === requestToken
        ) {
          historyFetchedAtRef.current.set(id, Date.now());
          setHistoryErrorBySession((current) => {
            const existing = current.get(id);
            if (!existing || existing.token > requestToken) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        } else if (historyFetchingRef.current.get(id) === requestToken) {
          const message = e instanceof ApiError
            ? (e.message || `加载失败 (${e.status})`)
            : e instanceof Error ? e.message : "加载失败";
          setHistoryErrorBySession((current) => {
            const next = new Map(current);
            next.set(id, { token: requestToken, message });
            return next;
          });
        }
      } finally {
        if (historyFetchingRef.current.get(id) === requestToken) {
          historyFetchingRef.current.delete(id);
        }
        setHistoryLoadingTokens((current) => {
          if (current.get(id) !== requestToken) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    },
    // modelPayloadFresh 为稳定 useCallback([]),入 deps 仅为满足 lint,不改重建时机。
    [auth, agentId, modelPayloadFresh],
  );

  const retryHistory = useCallback(
    (id: string) => {
      historyFetchedAtRef.current.delete(id);
      void loadHistory(id, { force: true });
    },
    [loadHistory],
  );

  const selectSession = useCallback(
    (id: string) => {
      if (id === activeId) return;
      cbRef.current.clearChatError();
      setActiveId(id);
      if (demo) {
        cbRef.current.onDemoSelect?.(id);
        return;
      }
      // 非 demo：消息来自 WS service 快照；选中后按需拉 server 历史合并（本地已注水的直接展示）。
      void loadHistory(id);
    },
    [activeId, demo, loadHistory],
  );

  const newSession = useCallback(() => {
    cbRef.current.onNewSessionReset();
    if (demo) {
      const s = makeLocalSession("新对话", "demo");
      setSessions((c) => [s, ...c]);
      setActiveId(s.id);
      return;
    }
    if (!user) return;
    // 非 demo：新建按钮只进入一个空白草稿态。真正会话由 App 首次发送时一次性创建，
    // 避免连续点击在侧栏堆出多个没有消息、标题都叫「新对话」的假会话。
    // 先封住迟到的 listSessions 自动选中，再清 activeId；否则历史列表会抢回空白态。
    autoSelectedRef.current = true;
    setActiveId(undefined);
  }, [demo, user]);

  // listSessions 是否已落定（成功或失败都算）：URL 深链恢复用它判定"等无可等"。
  const [serverListSettled, setServerListSettled] = useState(false);

  // 历史会话列表：登录后用 listSessions 填侧栏（server canonical 元数据 server-wins）。
  // 失败保留本地（IndexedDB 注水）会话，不阻断。
  useEffect(() => {
    if (demo || !auth || !user) return;
    let cancelled = false;
    api
      .listSessions(cbRef.current.authSession)
      .then((metas) => {
        if (cancelled) return;
        const server = metas.map((m) => {
          const s = metaToSession(m, user.id);
          // 会话模型陈旧载荷拦截(与 loadHistory 同款):pending 意图存续/低于已确认写水位
          // → 剥掉其 modelId 键(键缺席=不表态,合并保留本地新选择),其余元数据照常 server-wins。
          if (s.modelId !== undefined && !modelPayloadFresh(m.id, m.updatedAt)) {
            const { modelId: _stale, ...rest } = s;
            return rest;
          }
          return s;
        });
        setSessions((cur) => upsertSessions(cur, server, true));
      })
      .catch(() => {
        /* 列表失败：保留本地会话，不打断工作区 */
      })
      .finally(() => {
        if (!cancelled) setServerListSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, auth, user, modelPayloadFresh]);

  // 登录后自动恢复"上次会话"：侧栏（IndexedDB 注水 / listSessions）填好且用户尚未选任何会话时，
  // 选中最近一条（sessions 已按 updatedAt 倒序，[0]=最近）。仅做一次（autoSelectedRef）——
  // 之后用户的新建/切换/删除都不被覆盖。修复"每次登录都默认开新会话"。
  useEffect(() => {
    if (demo || !auth) return;
    // URL 深链恢复未决（P7 路由）：暂停自动选中 —— URL 指定 > 最近会话。
    if (holdAutoSelect) return;
    if (autoSelectedRef.current) return;
    if (activeId !== undefined) {
      autoSelectedRef.current = true; // 用户已自行选中 → 标记完成，不再自动接管
      return;
    }
    if (sessions.length === 0) return;
    autoSelectedRef.current = true;
    selectSession(sessions[0].id);
  }, [demo, auth, holdAutoSelect, activeId, sessions, selectSession]);

  // rename 一次收口三个持有方:App state(侧栏)+ WS service/IndexedDB + 服务端 canonical。
  // 此前只改 App state → listSessions server-wins 下次直接盖回旧标题(纯本地幻觉)。
  const renameSessionPrompt = async (s: Session) => {
    const t = (await cbRef.current.promptText({ title: "重命名会话", initial: s.title }))?.trim();
    if (!t || t === s.title) return;
    setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, title: t } : x)));
    if (!demo) {
      cbRef.current.sockRef.current?.renameSession(s.id, t);
      void api.patchSessionTitle(cbRef.current.authSession, s.id, t).catch(() => {
        /* 服务端失败:本地已改,下次 listSessions server-wins 盖回旧值,用户可重试;不打断 */
      });
    }
  };

  const deleteSessionConfirm = async (s: Session) => {
    const ok = await cbRef.current.confirmDialog({
      title: "删除该会话?",
      body: `「${s.title || "新对话"}」的本地与云端记录都将删除,不可恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    cbRef.current.onDeleteSession?.(s.id);
    historyFetchedAtRef.current.delete(s.id);
    historyFetchingRef.current.delete(s.id);
    setHistoryLoadingTokens((current) => {
      if (!current.has(s.id)) return current;
      const next = new Map(current);
      next.delete(s.id);
      return next;
    });
    modelSyncRef.current.delete(s.id);
    if (!demo) {
      cbRef.current.sockRef.current?.removeSession(s.id);
      cbRef.current.sockRef.current?.removePersisted(s.id); // 清 IndexedDB 本地副本
      // 服务端删除（幂等，best-effort）：否则 reload 后会从 listSessions 复活。
      void api.deleteSession(cbRef.current.authSession, s.id).catch(() => {});
    }
    setSessions((c) => c.filter((x) => x.id !== s.id));
    if (s.id === activeId) {
      setActiveId(undefined);
      cbRef.current.onActiveSessionDeleted();
    }
  };

  const patchSessionMetaOptimistic = async (
    s: Session,
    patch: { pinned?: boolean; projectId?: string | null },
    next: Session,
  ) => {
    setSessions((c) => c.map((x) => (x.id === s.id ? next : x)));
    if (demo) return;
    try {
      await api.patchSessionMeta(cbRef.current.authSession, s.id, patch);
    } catch (e) {
      setSessions((c) => c.map((x) => (x.id === s.id ? s : x)));
      console.warn("patchSessionMeta failed", e);
      toast("操作失败，已恢复", "error");
    }
  };

  const togglePinSession = async (s: Session) => {
    const pinned = !s.pinned;
    await patchSessionMetaOptimistic(s, { pinned }, { ...s, pinned });
  };

  const moveSessionToProject = async (s: Session, projectId: string | null) => {
    if ((s.projectId ?? null) === projectId) return;
    await patchSessionMetaOptimistic(s, { projectId }, { ...s, projectId });
  };

  const applySessionTerminal = useCallback(
    (
      sessId: string,
      terminal: { lastOutcome: SessionLastOutcome; lastErrorCode: string | null } | null,
    ) => {
      setSessions((c) =>
        c.map((x) => {
          if (x.id !== sessId) return x;
          const nextOutcome = terminal ? terminal.lastOutcome : x.lastOutcome;
          const nextCode = terminal ? terminal.lastErrorCode : x.lastErrorCode;
          if (x.runState === "idle" && x.lastOutcome === nextOutcome && x.lastErrorCode === nextCode) {
            return x;
          }
          return {
            ...x,
            runState: "idle" as const,
            ...(terminal
              ? { lastOutcome: terminal.lastOutcome, lastErrorCode: terminal.lastErrorCode }
              : {}),
          };
        }),
      );
    },
    [],
  );

  // 登出/登录时的整体重置（App 的 useAuth onClearAuth/onLoginSuccess 经 ref 回填调用）。
  const reset = useCallback(() => {
    historyFetchedAtRef.current.clear();
    historyFetchingRef.current.clear();
    setHistoryLoadingTokens(new Map());
    setHistoryErrorBySession(new Map());
    modelSyncRef.current.clear();
    autoSelectedRef.current = false; // 下次登录重新自动选中最近会话
    setSessions([]);
    setActiveId(undefined);
    setServerListSettled(false); // 重新登录后 listSessions 重新落定
  }, []);

  return {
    sessions,
    setSessions,
    activeId,
    setActiveId,
    selectSession,
    newSession,
    queueModelPatch,
    onHydrated,
    renameSessionPrompt,
    deleteSessionConfirm,
    togglePinSession,
    moveSessionToProject,
    applySessionTerminal,
    reset,
    serverListSettled,
    historyLoading: activeId !== undefined && historyLoadingTokens.has(activeId),
    historyError: activeId
      ? (() => {
          const row = historyErrorBySession.get(activeId);
          if (!row) return null;
          const loadingToken = historyLoadingTokens.get(activeId);
          if (loadingToken !== undefined && loadingToken > row.token) return null;
          return { sessionId: activeId, token: row.token, message: row.message };
        })()
      : null,
    retryHistory,
    loadHistory,
  };
}

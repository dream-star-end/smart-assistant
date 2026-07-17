import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import type { ChatMessage } from "../lib/chat/model";
import { DEMO_SESSIONS } from "../lib/demo";
import type { StoredSession } from "../lib/persist";
import type { AuthSession, Session, SessionMeta, User } from "../lib/types";
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
  /** IndexedDB 注水回调（喂给 useChatSocket.onHydrated）。 */
  onHydrated: (stored: StoredSession[]) => void;
  renameSessionPrompt: (s: Session) => Promise<void>;
  deleteSessionConfirm: (s: Session) => Promise<void>;
  /** 登出/登录时的整体重置：清列表与选中、清已拉历史标记、允许重新自动选中最近会话。 */
  reset: () => void;
  /** listSessions 已落定（成功或失败）：URL 深链恢复据此判定"会话确实不存在"。 */
  serverListSettled: boolean;
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

  const [sessions, setSessions] = useState<Session[]>(demo ? DEMO_SESSIONS : []);
  const [activeId, setActiveId] = useState<string | undefined>(
    demo ? DEMO_SESSIONS[0].id : undefined,
  );
  // 历史拉取守卫（S2）：语义从"整页生命周期只拉一次"改为"只防并发 + 短时重复"。
  //  - historyFetchingRef：正在拉取的会话（防并发重入）；
  //  - historyFetchedAtRef：上次拉取时刻，HISTORY_REFETCH_COOLDOWN_MS 内不重拉。
  // 冷却过后允许重拉：sinceSeq 增量 + server-wins 合并幂等、重拉无副作用，这样切回前台/
  // 重连后重新选中会话能增量补齐（旧的永久守卫会让锁屏后再选中的会话拿不到新内容）。
  const historyFetchingRef = useRef<Set<string>>(new Set());
  const historyFetchedAtRef = useRef<Map<string, number>>(new Map());
  // 登录后是否已自动选中"上次会话"（仅做一次：避免覆盖用户随后的显式新建/切换/删除）。
  const autoSelectedRef = useRef(false);
  // 当前登录 user id 的实时镜像：异步历史请求 await 后比对，防登出/换号后 stale 响应
  // 把上一个用户的历史污染进单例 WS service / 写进新用户的 IndexedDB 命名空间（隐私）。
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;

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
    async (id: string) => {
      const owner = userIdRef.current;
      if (!auth || !owner) return;
      if (historyFetchingRef.current.has(id)) return; // 并发中：不重入
      const lastAt = historyFetchedAtRef.current.get(id) ?? 0;
      if (Date.now() - lastAt < HISTORY_REFETCH_COOLDOWN_MS) return; // 短时重复：不重拉
      historyFetchingRef.current.add(id);
      try {
        const sinceSeq = cbRef.current.sockRef.current?.storedMaxSeq(id) ?? 0;
        const detail = await api.getSession(cbRef.current.authSession, id, sinceSeq);
        // 登出/换号守卫：await 期间用户已变 → 丢弃，绝不污染当前会话/新用户 IndexedDB。
        if (userIdRef.current !== owner) return;
        const msgs = Array.isArray(detail.messages) ? (detail.messages as ChatMessage[]) : [];
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
        });
        historyFetchedAtRef.current.set(id, Date.now());
      } catch (e) {
        // 404 = 本地新建/未同步会话，无 server 历史（正常）：打冷却戳，避免每次重选都空打 404，
        // 但仍非永久（会话后续被 server 持久化后，冷却过去可正常增量拉到）。其他错误不打戳 →
        // 允许下次重选立即重试。
        if (e instanceof ApiError && e.status === 404) historyFetchedAtRef.current.set(id, Date.now());
      } finally {
        historyFetchingRef.current.delete(id);
      }
    },
    [auth, agentId],
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
    // 非 demo：新建一个 WS 会话占位（peer.id 用真实 id），socket 侧在首次 send 时
    // 惰性 ensureSession —— 空会话不必提前占用 service 槽位。
    const id = genWsSessionId();
    const s: Session = {
      id,
      title: "新对话",
      ownerUserId: user.id,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    setSessions((c) => [s, ...c]);
    setActiveId(id);
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
        const server = metas.map((m) => metaToSession(m, user.id));
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
  }, [demo, auth, user]);

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

  // 登出/登录时的整体重置（App 的 useAuth onClearAuth/onLoginSuccess 经 ref 回填调用）。
  const reset = useCallback(() => {
    historyFetchedAtRef.current.clear();
    historyFetchingRef.current.clear();
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
    onHydrated,
    renameSessionPrompt,
    deleteSessionConfirm,
    reset,
    serverListSettled,
  };
}

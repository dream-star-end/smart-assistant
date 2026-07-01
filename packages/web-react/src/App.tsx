import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentGate } from "./components/AgentGate";
import { AgentPicker } from "./components/AgentPicker";
import { AuthGate, type AuthMode } from "./components/AuthGate";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { extractLatestTodos, PinnedTaskTracker } from "./components/chat/PinnedTaskTracker";
import { EmptyState } from "./components/EmptyState";
import { type ChatError, ErrorBanner } from "./components/ErrorBanner";
import { GithubRepoModal } from "./components/github/GithubRepoModal";
import { RepoStatusBanner } from "./components/github/RepoStatusBanner";
import { InboxDialog } from "./components/InboxDialog";
import { Landing } from "./components/Landing";
import { ManageCenter, type ManageTab } from "./components/ManageCenter";
import {
  MarketplaceCenter,
  type MarketplaceKind,
  type MarketplaceTab,
} from "./components/MarketplaceCenter";
import { AssistantMessage, UserMessage } from "./components/Message";
import { MessageList } from "./components/MessageRenderer";
import type { CardCallbacks } from "./components/chat/cards";
import { MediaSignProvider } from "./components/chat/media";
import { ToolCardActionsContext } from "./components/tool/context";
import { modelLabel } from "./components/ModelSelector";
import { SettingsCenter } from "./components/SettingsCenter";
import { Sidebar } from "./components/Sidebar";
import { Alert, Sheet } from "./components/ui";
import { useAgentGate } from "./hooks/useAgentGate";
import { type UseChatSocket, useChatSocket } from "./hooks/useChatSocket";
import { useInbox } from "./hooks/useInbox";
import { useRepoBinding } from "./hooks/useRepoBinding";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./components/ui";
import { githubErrorText } from "./lib/github";
import type { RepoBindErrorWire, RepoStatusWire } from "./lib/chat/frames";
import type { MediaRef } from "./lib/chat/frames";
import type { ChatMessage } from "./lib/chat/model";
import { CONTINUE_PROMPT } from "./lib/chat/render";
import { TeamManager } from "./components/team/TeamManager";
import { DEFAULT_AGENT } from "./lib/agents";
import { ApiError, api } from "./lib/api";
import type { StoredSession } from "./lib/persist";
import { DEMO_MESSAGES, DEMO_MODELS, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type {
  AuthSession,
  Message,
  PublicConfig,
  PublicModel,
  Session,
  SessionMeta,
  ToolCard,
  User,
} from "./lib/types";

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

const EMPTY_WS_MESSAGES: ChatMessage[] = [];

/** WS 会话 id（peer.id）：须匹配后端 `[A-Za-z0-9_-]{8,50}`。*/
function genWsSessionId(): string {
  return `web${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function App() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo") === "1";
  // 密码重置邮件链接：/reset-password?token=…（gateway SPA fallback 对无扩展名路径回退
  // index.html，故 SPA 能接住）。启动即检测 → 直接进入 AuthGate 的 reset 模式。
  const resetToken =
    !demo && location.pathname === "/reset-password"
      ? params.get("token") || undefined
      : undefined;
  // access token 仅存内存，刷新即丢失，所以启动一律落到首页/登录（无自动登录）。
  const [view, setView] = useState<"home" | "app">(resetToken ? "app" : "home");
  // AuthGate 初始模式：「登录」入口=login，「免费开始」入口=register，重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme();

  // access token 仅存内存：放在 ref 里作为唯一权威源，AuthSession.getToken/setToken 读写它，
  // 静默刷新成功后 api 层直接回写 ref，下一次鉴权请求即拿到新 token（无 stale 闭包）。
  const tokenRef = useRef<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState<User | null>(demo ? DEMO_USER : null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // 公开配置（Turnstile bypass / site key）：登录页驱动 AuthGate 是否渲染真 widget。
  const [publicCfg, setPublicCfg] = useState<PublicConfig | null>(null);

  const [sessions, setSessions] = useState<Session[]>(demo ? DEMO_SESSIONS : []);
  const [activeId, setActiveId] = useState<string | undefined>(demo ? DEMO_SESSIONS[0].id : undefined);
  const [messages, setMessages] = useState<Message[]>(demo ? DEMO_MESSAGES : []);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolCards] = useState<ToolCard[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agent, setAgent] = useState(DEFAULT_AGENT);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 对话模型：唯一权威源是后端 GET /api/public/models（v5 仅 claude/glm-5.2/deepseek/minimax）。
  // demo 用本地 fixture 仅作离线视觉，不发请求。选中的 modelId 由 P4 的 WS inbound.message 顶层发送。
  const [models, setModels] = useState<PublicModel[]>(demo ? DEMO_MODELS : []);
  const [modelId, setModelId] = useState<string | undefined>(demo ? DEMO_MODELS[0]?.id : undefined);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [manageTab, setManageTab] = useState<ManageTab>("memory");
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>("browse");
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>("skill");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);
  // 稳定句柄：让早于 useChatSocket 声明的 send/regenerate 回调引用 WS 引擎，避免
  // “块级变量在声明前使用” 的 TDZ（hook 在下方调用后回填 sockRef.current）。
  const sockRef = useRef<UseChatSocket | null>(null);
  const toast = useToast();
  // GitHub 仓库绑定帧处理器的稳定间接：useChatSocket 在 useRepoBinding 之前声明，故经 ref
  // 透传（与 sockRef 同样的 TDZ 规避；handler 本身是 useRepoBinding 的稳定 useCallback）。
  const repoStatusHandlerRef = useRef<(f: RepoStatusWire) => void>(() => {});
  const repoBindErrorHandlerRef = useRef<(f: RepoBindErrorWire) => void>(() => {});

  // 本地会话消息存储（脚手架，仅 demo 路径用）：activeId → 消息数组。非 demo 走 WS + IndexedDB。
  const localStore = useRef<Map<string, Message[]>>(new Map());
  // 已拉过 server 历史的会话 id（防 selectSession 每次都重拉；404 的本地会话也记入）。
  const historyFetchedRef = useRef<Set<string>>(new Set());
  // 登录后是否已自动选中"上次会话"（仅做一次：避免覆盖用户随后的显式新建/切换/删除）。
  const autoSelectedRef = useRef(false);
  // 当前登录 user id 的实时镜像：异步历史请求 await 后比对，防登出/换号后 stale 响应
  // 把上一个用户的历史污染进单例 WS service / 写进新用户的 IndexedDB 命名空间（隐私）。
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;

  // 清空全部鉴权 + 会话状态，回到登录/首页（静默刷新失败或主动登出都走这里）。
  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    localStore.current.clear();
    historyFetchedRef.current.clear();
    autoSelectedRef.current = false; // 下次登录重新自动选中最近会话
    setAuthed(false);
    setUser(null);
    setSessions([]);
    setMessages([]);
    setActiveId(undefined);
    setChatError(null);
    setSettingsOpen(false);
    setView("home");
  }, []);

  // AuthSession：access token 的唯一权威源（仅存内存）。整个生命周期复用同一引用，
  // 传给 api.* 的鉴权请求；命中 401 时 api 内部透明刷新并 setToken 回写本 ref。
  // onExpired 在刷新失败时触发 → clearAuth 把用户带回登录页（绝不循环重试）。
  const authRef = useRef<AuthSession>({
    getToken: () => tokenRef.current ?? "",
    setToken: (t) => {
      tokenRef.current = t;
    },
    onExpired: () => clearAuth(),
  });
  // clearAuth 每次渲染可能是新引用；让 session.onExpired 始终指向最新版本。
  authRef.current.onExpired = clearAuth;
  // 仅当已认证时把 session 暴露给业务逻辑；未认证时为 null。P3/P4 的 REST/WS 调用消费它。
  const auth = authed ? authRef.current : null;

  const interrupt = useCallback(() => {
    stopRef.current = true;
    setBusy(false);
    setStreamText("");
    setChatError(null);
  }, []);

  const login = useCallback(async (email: string, password: string, turnstileToken: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      // 服务端 /api/auth/login schema 必填 turnstile_token。turnstileToken 由 AuthGate 给出：
      // canary（turnstile_bypass:true）发占位 'bypass'（服务端接受任意串）；生产（bypass 关闭）
      // 为真实 Cloudflare Turnstile widget 的 onSuccess token。canary 登录行为不变。
      // 登录拿到内存态 accessToken + 用户信息；token 只写进 tokenRef（内存），绝不落地。
      // refresh token 由后端通过 HttpOnly cookie 下发（api.login credentials:'include'）。
      const { accessToken, user: me } = await api.login(email, password, turnstileToken);
      tokenRef.current = accessToken;
      setAuthed(true);
      setUser(me);
      // 不在此预载会话：登录后由 useChatSocket 从 IndexedDB 注水（onHydrated）+ listSessions
      // 合并 server canonical 列表填侧栏；selectSession 再按需拉取单会话历史。
      setSessions([]);
      setActiveId(undefined);
      setMessages([]);
    } catch (e) {
      setAuthError((e as Error).message || "登录失败");
    } finally {
      setAuthLoading(false);
    }
  }, []);

  // 注册 / 邮箱验证 / 找回密码：透传到 api（错误为带友好中文 message 的 ApiError，AuthGate 自捕展示）。
  const register = useCallback(
    (input: { email: string; password: string; displayName?: string; turnstileToken: string }) =>
      api
        .register({
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          turnstileToken: input.turnstileToken,
        })
        .then((r) => ({ verifyEmailSent: r.verifyEmailSent })),
    [],
  );
  const verifyEmail = useCallback(
    (email: string, code: string) => api.verifyEmail(email, code).then(() => undefined),
    [],
  );
  const resendVerification = useCallback(
    (email: string) => api.resendVerification(email).then(() => undefined),
    [],
  );
  const requestReset = useCallback(
    (email: string, token: string) => api.requestPasswordReset(email, token).then(() => undefined),
    [],
  );
  const confirmReset = useCallback(
    (token: string, newPassword: string) =>
      api.confirmPasswordReset(token, newPassword).then(() => undefined),
    [],
  );

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
      if (historyFetchedRef.current.has(id)) return;
      historyFetchedRef.current.add(id);
      try {
        const sinceSeq = sockRef.current?.storedMaxSeq(id) ?? 0;
        const detail = await api.getSession(authRef.current, id, sinceSeq);
        // 登出/换号守卫：await 期间用户已变 → 丢弃，绝不污染当前会话/新用户 IndexedDB。
        if (userIdRef.current !== owner) return;
        const msgs = Array.isArray(detail.messages) ? (detail.messages as ChatMessage[]) : [];
        sockRef.current?.mergeServerHistory({
          sessId: id,
          agentId: detail.agentId || agent.id,
          messages: msgs,
          full: !detail.isPartial,
          maxSeq: detail.maxSeq,
        });
      } catch (e) {
        // 404 = 本地新建/未同步会话，无 server 历史（正常）；其他错误允许下次重选重试。
        if (!(e instanceof ApiError && e.status === 404)) historyFetchedRef.current.delete(id);
      }
    },
    [auth, agent.id],
  );

  const selectSession = useCallback(
    (id: string) => {
      if (id === activeId) return;
      setChatError(null);
      setActiveId(id);
      if (demo) {
        setMessages(id === DEMO_SESSIONS[0].id ? DEMO_MESSAGES : []);
        return;
      }
      // 非 demo：消息来自 WS service 快照；选中后按需拉 server 历史合并（本地已注水的直接展示）。
      void loadHistory(id);
    },
    [activeId, demo, loadHistory],
  );

  const newSession = useCallback(() => {
    interrupt();
    setMessages([]);
    setChatError(null);
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
  }, [demo, user, interrupt]);

  const send = useCallback(
    async (text: string, media?: MediaRef[]) => {
      setChatError(null);

      // demo：本地流式回放（无网络），仅用于离线预览设计。
      if (demo) {
        const userMsg: Message = {
          id: `tmp-${Date.now()}`,
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        };
        setMessages((m) => [...m, userMsg]);
        setBusy(true);
        setStreamText("");
        stopRef.current = false;
        const full = demoReply(text);
        for (let i = 0; i < full.length && !stopRef.current; i += 3) {
          setStreamText(full.slice(0, i + 3));
          await new Promise((r) => setTimeout(r, 12));
        }
        setMessages((m) => [
          ...m,
          { id: `a-${Date.now()}`, role: "assistant", content: full, createdAt: new Date().toISOString() },
        ]);
        setStreamText("");
        setBusy(false);
        return;
      }

      if (!user) return;
      // 非 demo：经真实 WS 引擎发送（inbound.message）。确保有会话承载本轮（peer.id）。
      let sessionId = activeId;
      let createdSession: Session | null = null;
      if (!sessionId) {
        sessionId = genWsSessionId();
        createdSession = {
          id: sessionId,
          title: text.slice(0, 24) || "新对话",
          ownerUserId: user.id,
          updatedAt: new Date().toISOString(),
          messageCount: 0,
        };
        setSessions((c) => [createdSession!, ...c]);
        setActiveId(sessionId);
      }
      sockRef.current?.ensureSession(sessionId, agent.id, text.slice(0, 24));
      // model：选中的真实模型 id（顶层字段，非 content 内）。effortLevel 本期不接（P5/后续）。
      // media：已上传附件（图片/文件等），随 inbound.message.content.media 发送。
      sockRef.current?.send({ sessId: sessionId, agentId: agent.id, text, model: modelId, media });
      // 侧栏：提到顶 + 更新标题/时间/计数（计数仅作排序提示，权威消息在 WS service）。
      setSessions((c) => {
        const sid = sessionId!;
        const found = c.find((s) => s.id === sid);
        const base: Session =
          found ?? createdSession ?? { id: sid, title: text.slice(0, 24) || "新对话", ownerUserId: user.id, updatedAt: "", messageCount: 0 };
        const updated: Session = {
          ...base,
          id: sid,
          title: found?.title && found.messageCount > 0 ? found.title : text.slice(0, 24) || "新对话",
          updatedAt: new Date().toISOString(),
          messageCount: (found?.messageCount ?? 0) + 1,
        };
        return [updated, ...c.filter((s) => s.id !== sid)];
      });
    },
    [activeId, demo, user, agent, modelId],
  );

  // 上传单文件 → MediaRef（kind 以服务端 mimeType 为准，退回 file.type）。供 Composer 附件。
  const uploadMedia = useCallback(async (file: File): Promise<MediaRef> => {
    const r = await api.uploadFile(authRef.current, file);
    const mime = r.mimeType || file.type || "";
    const kind: MediaRef["kind"] = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : mime.startsWith("video/")
          ? "video"
          : "file";
    return { kind, url: r.url, mimeType: mime || undefined, filename: file.name };
  }, []);

  const regenerate = useCallback(() => {
    // demo 用本地 messages；非 demo 找 WS 末条 user 重发。
    const src: Array<{ role: string; content?: string; text?: string }> = demo
      ? messages
      : (sockRef.current?.getMessages(activeId) ?? []);
    for (let i = src.length - 1; i >= 0; i--) {
      if (src[i].role === "user") {
        send((src[i].content ?? src[i].text ?? "") as string);
        return;
      }
    }
  }, [demo, messages, activeId, send]);

  const logout = useCallback(() => {
    // 先请求后端吊销 refresh cookie（错误已在 api 层吞掉），并清本 user 的 IndexedDB
    // 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效），再清空内存态回到首页。
    if (!demo) {
      void api.logout();
      void sockRef.current?.wipePersistence();
    }
    clearAuth();
  }, [demo, clearAuth]);

  // 刷新账户余额（GET /api/me）：充值到账 / 打开计费面板后调用，让顶栏 balance-pill
  // 与账户分区拿到权威 credits（字符串大数，原样存进 user）。失败静默（401 会触发 onExpired）。
  const refreshMe = useCallback(async () => {
    if (demo || !authed) return;
    try {
      const me = await api.getMe(authRef.current);
      setUser(me);
    } catch {
      /* 刷新失败静默：余额停留在上次已知值，不打断当前操作 */
    }
  }, [demo, authed]);

  // 打开设置中心并顺带刷新余额（顶栏 pill / 侧栏 / AgentGate 充值入口统一走此）。
  const openSettings = useCallback(() => {
    void refreshMe();
    setSettingsOpen(true);
  }, [refreshMe]);

  // 打开管理中心到指定分区（侧栏入口 + 工具卡「打开记忆/技能/定时」按钮统一走此）。
  const openManage = useCallback((tab: ManageTab) => {
    setManageTab(tab);
    setManageOpen(true);
  }, []);

  // 打开 AI 市场到指定分区（侧栏入口 / 「从市场添加智能体」)。
  const openMarketplace = useCallback((tab: MarketplaceTab, kind: MarketplaceKind = "skill") => {
    setMarketplaceTab(tab);
    setMarketplaceBrowseKind(kind);
    setMarketplaceOpen(true);
  }, []);

  // 键盘快捷键：⌘/Ctrl+K 新会话；Esc 停止当前（demo）流式。仅在进入工作区后生效。
  const inWorkspace = demo || (view === "app" && !!auth && !!user);

  // 站内信未读轮询（铃铛红点）。demo / 未登录不发请求。
  const inbox = useInbox(auth, inWorkspace && !demo);

  // GitHub OAuth 回调返回：URL 带 ?github_linked / ?github_error → toast + 清 query（仅一次，
  // 对齐 v3 handleBootGithubParams）。redirect 回 /?github_linked=1，全局 toast 即时反馈。
  const githubReturnHandledRef = useRef(false);
  useEffect(() => {
    if (demo || githubReturnHandledRef.current) return;
    githubReturnHandledRef.current = true;
    const sp = new URLSearchParams(window.location.search);
    let touched = false;
    if (sp.has("github_linked")) {
      toast("GitHub 账号已连接", "success");
      sp.delete("github_linked");
      touched = true;
    }
    if (sp.has("github_error")) {
      toast(`GitHub 连接失败：${githubErrorText(sp.get("github_error"))}`, "error");
      sp.delete("github_error");
      touched = true;
    }
    if (touched) {
      const q = sp.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (q ? `?${q}` : "") + window.location.hash,
      );
    }
  }, [demo, toast]);

  // 进入登录页（view=app 且未认证）时拉一次公开配置：决定 AuthGate 是否渲染真 Turnstile
  // widget。停在首页（home）/demo/已登录均不拉，避免无谓请求（与无网络测试用例兼容）。
  useEffect(() => {
    if (demo || authed || view !== "app") return;
    let cancelled = false;
    api
      .getPublicConfig()
      .then((c) => {
        if (!cancelled) setPublicCfg(c);
      })
      .catch(() => {
        /* 拿不到 config：publicCfg 维持 null → AuthGate fail-closed（bypass 未知，禁用登录，
         * 绝不发占位 token）。生产（bypass 关闭）下 config 拉取失败时不会用假 token 蒙混登录。 */
      });
    return () => {
      cancelled = true;
    };
  }, [demo, authed, view]);

  // 进入工作区后拉取模型列表（公开端点；登录态带 Bearer 走 grants 视图）。失败不阻断
  // 对话前置——选择器降级为「暂无可用模型」，对话仍可在订阅就绪后进行。
  useEffect(() => {
    if (demo || !auth) return;
    let cancelled = false;
    setModelsLoading(true);
    api
      .getPublicModels(auth)
      .then((ms) => {
        if (cancelled) return;
        setModels(ms);
        // 保留用户已选（若仍在列表内），否则落到列表首项。
        setModelId((cur) => (cur && ms.some((m) => m.id === cur) ? cur : ms[0]?.id));
      })
      .catch(() => {
        /* 公开端点失败：保持空列表，选择器禁用，不弹错误打断前置流程 */
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, auth]);

  // 对话前置态机：检查订阅/容器、引导开通、轮询容器至就绪。gate.access=false 时由
  // AgentGate 面板占据对话区并禁用 Composer；gate.ready 是 P4 useChatSocket 连接的硬前置。
  const gate = useAgentGate(auth, inWorkspace && !demo);

  // P4 真实 WS 对话引擎。gate.ready（容器 running）是连接硬前置；refreshMe 供
  // cost_charged / 余额不足时刷新顶栏余额。demo 不连真实 WS。
  const chat = useChatSocket({
    auth,
    ready: gate.ready,
    enabled: inWorkspace && !demo,
    defaultAgentId: "main",
    refreshBalance: refreshMe,
    // 持久按 user 命名空间（隐私隔离）；onHydrated 把 IndexedDB 本地会话填进侧栏。
    userId: demo ? null : (user?.id ?? null),
    onHydrated,
    // GitHub 仓库绑定状态/错误帧 → useRepoBinding（经 ref，见 repoStatusHandlerRef）。
    onRepoStatus: (f) => repoStatusHandlerRef.current(f),
    onRepoBindError: (f) => repoBindErrorHandlerRef.current(f),
  });
  sockRef.current = chat; // 回填稳定句柄（供上方 send/regenerate/历史方法引用）。

  // GitHub 仓库绑定：当前活动会话的 selection + 克隆进度 + 版本门控（v5 版 github.js）。
  const repo = useRepoBinding({
    auth,
    activeId,
    agentId: agent.id,
    enabled: inWorkspace && !demo,
    sendRepoBind: chat.sendRepoBind,
    sendRepoUnbind: chat.sendRepoUnbind,
    toast,
  });
  // 回填帧处理器（稳定 useCallback；render 期赋值幂等，与 useChatSocket persistRef 同模式）。
  repoStatusHandlerRef.current = repo.onRepoStatus;
  repoBindErrorHandlerRef.current = repo.onRepoBindError;

  // 历史会话列表：登录后用 listSessions 填侧栏（server canonical 元数据 server-wins）。
  // 失败保留本地（IndexedDB 注水）会话，不阻断。
  useEffect(() => {
    if (demo || !auth || !user) return;
    let cancelled = false;
    api
      .listSessions(authRef.current)
      .then((metas) => {
        if (cancelled) return;
        const server = metas.map((m) => metaToSession(m, user.id));
        setSessions((cur) => upsertSessions(cur, server, true));
      })
      .catch(() => {
        /* 列表失败：保留本地会话，不打断工作区 */
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
    if (autoSelectedRef.current) return;
    if (activeId !== undefined) {
      autoSelectedRef.current = true; // 用户已自行选中 → 标记完成，不再自动接管
      return;
    }
    if (sessions.length === 0) return;
    autoSelectedRef.current = true;
    selectSession(sessions[0].id);
  }, [demo, auth, activeId, sessions, selectSession]);
  // 非 demo：展示的消息来自 WS service 快照（就地 mutation + version 触发重渲）。
  const wsMessages = !demo && activeId ? chat.getMessages(activeId) : EMPTY_WS_MESSAGES;
  const wsSending = !demo && chat.isSending(activeId);
  // 统一“本轮进行中”信号：demo 用本地 busy，非 demo 用 WS in-flight。
  const sending = demo ? busy : wsSending;
  // 停止当前轮：demo 本地停回放；非 demo 发 inbound.control.stop 并本地收尾。
  const stopTurn = useCallback(() => {
    if (demo) {
      stopRef.current = true;
      setBusy(false);
      setStreamText("");
    } else if (activeId) {
      chat.stop(activeId);
    }
    setChatError(null);
  }, [demo, activeId, chat]);

  // ── P5 渲染层接线 ──────────────────────────────────────────────────────
  // 媒体签名单一权威：把 api.mediaSign 注入渲染树（demo 无网络 → null）。容器内路径
  // 经此换签名 URL，图片/视频/音频才不停在占位。
  const signMedia = useCallback(
    (paths: string[]) => api.mediaSign(authRef.current, paths).then((r) => r.urls),
    [],
  );
  // 权限审批回送：绑定当前会话，桥接 useChatSocket.respondPermission。
  // 走稳定 sockRef（非 chat），避免依赖每帧重建的 chat 引用 —— 否则该回调每个流式帧
  // 都换新引用，会击穿 MessageRenderer 的 memo（防闪失效，全列表逐帧重渲）。
  const onRespondPermission = useCallback(
    (p: { requestId: string; behavior: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> }) => {
      if (!activeId) return;
      sockRef.current?.respondPermission({ sessId: activeId, ...p });
    },
    [activeId],
  );
  // 逐条反馈（P6 反馈弹窗的占位接线）：暂以复制诊断串兜底（请求ID + 关联键），
  // 让用户/运维能立即把可追溯上下文交出去；P6 落地后替换为带上下文的反馈弹窗。
  const onFeedback = useCallback(
    (ctx: { traceId: string | null; messageId: string; role: string; errorCode: string | null }) => {
      const diag = [
        ctx.traceId ? `请求ID: ${ctx.traceId}` : null,
        `消息: ${ctx.messageId}`,
        activeId ? `会话: ${activeId}` : null,
        ctx.errorCode ? `错误码: ${ctx.errorCode}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      void navigator.clipboard?.writeText(diag).catch(() => {});
    },
    [activeId],
  );
  // 工具卡上下文动作（记忆/技能/定时任务卡上的「打开…」按钮）。稳定引用经 context 注入，
  // 不污染 ToolCard 数据契约。demo 无网络 → 不提供（按钮自动隐藏）。
  const toolActions = useMemo(
    () =>
      demo
        ? {}
        : {
            onOpenMemory: () => openManage("memory"),
            onOpenSkills: () => openManage("skills"),
            onOpenTasks: () => openManage("cron"),
          },
    [demo, openManage],
  );

  // 卡片回调集（稳定引用：作为 MessageRenderer memo 比较键之一，避免无谓重渲）。
  const cardCallbacks: CardCallbacks = useMemo(
    () => ({
      onRegenerate: regenerate,
      onContinue: () => send(CONTINUE_PROMPT),
      onTopUp: demo ? undefined : openSettings,
      onFeedback,
    }),
    [regenerate, send, demo, openSettings, onFeedback],
  );

  // autoscroll（demo: messages/streamText；非 demo: WS 消息流 + in-flight）
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText, wsMessages, wsSending]);

  useEffect(() => {
    if (!inWorkspace) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        newSession();
      } else if (e.key === "Escape" && sending) {
        e.preventDefault();
        stopTurn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inWorkspace, sending, newSession, stopTurn]);

  if (!demo && view === "home") {
    return (
      <Landing
        onStart={() => {
          setAuthMode("register");
          setView("app");
        }}
        onLogin={() => {
          setAuthMode("login");
          setView("app");
        }}
        theme={theme}
        onCycleTheme={cycle}
      />
    );
  }
  if (!demo && (!auth || !user)) {
    return (
      <AuthGate
        onLogin={login}
        onRegister={register}
        onVerifyEmail={verifyEmail}
        onResendVerification={resendVerification}
        onRequestReset={requestReset}
        onConfirmReset={confirmReset}
        loading={authLoading}
        error={authError}
        onBack={() => {
          setAuthMode("login");
          setView("home");
        }}
        theme={theme}
        onCycleTheme={cycle}
        turnstileBypass={publicCfg?.turnstileBypass}
        turnstileSiteKey={publicCfg?.turnstileSiteKey}
        allowRegistration={publicCfg?.allowRegistration ?? true}
        requireEmailVerified={publicCfg?.requireEmailVerified ?? false}
        initialMode={authMode}
        resetToken={resetToken}
      />
    );
  }

  const showEmpty = demo ? messages.length === 0 && !busy : wsMessages.length === 0 && !wsSending;
  // 对话前置门：非 demo 且尚无访问权（容器未就绪/未订阅/出错等）→ 由 AgentGate 占据对话区
  // 并禁用 Composer。demo 与已就绪（ready|dormant）放行正常对话。
  const gated = !demo && !gate.access;
  const selectedModel = models.find((m) => m.id === modelId);
  // Composer 底部展示当前对话模型（真实模型名优先，退回 agent 名仅作占位）。
  const modelFooter = selectedModel ? modelLabel(selectedModel) : agent.name;

  // 侧栏公共 props：桌面内联与移动抽屉两处复用。余额（balanceCents）本期不展示（P3.5 计费中心）。
  const renameSessionPrompt = (s: Session) => {
    const t = prompt("重命名会话", s.title);
    if (t) setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, title: t } : x)));
  };
  const deleteSessionConfirm = (s: Session) => {
    if (!confirm("删除该会话？")) return;
    localStore.current.delete(s.id);
    historyFetchedRef.current.delete(s.id);
    if (!demo) {
      chat.removeSession(s.id);
      chat.removePersisted(s.id); // 清 IndexedDB 本地副本
      // 服务端删除（幂等，best-effort）：否则 reload 后会从 listSessions 复活。
      void api.deleteSession(authRef.current, s.id).catch(() => {});
    }
    setSessions((c) => c.filter((x) => x.id !== s.id));
    if (s.id === activeId) {
      setActiveId(undefined);
      setMessages([]);
      setChatError(null);
    }
  };
  const sidebarProps = {
    sessions,
    activeId,
    user,
    credits: user?.credits ?? null,
    onOpenAccount: demo ? undefined : openSettings,
    onNew: newSession,
    onRename: renameSessionPrompt,
    onDelete: deleteSessionConfirm,
    onLogout: demo ? undefined : logout,
    onOpenManage: demo ? undefined : () => openManage("memory"),
    onOpenTeam: demo ? undefined : () => setTeamOpen(true),
    onOpenMarketplace: demo ? undefined : () => openMarketplace("browse"),
  };

  return (
    <MediaSignProvider sign={demo ? null : signMedia} authKey={user?.id ?? "anon"}>
    <ToolCardActionsContext.Provider value={toolActions}>
    {/* safe-px:横屏侧刘海安全区(竖屏为 0) */}
    <div className="flex h-full overflow-hidden bg-bg text-fg safe-px">
      {/* 桌面：内联侧栏（可折叠）。窄屏隐藏，改用抽屉。 */}
      {!collapsed && (
        <div className="hidden md:contents">
          <Sidebar {...sidebarProps} onSelect={selectSession} onCollapse={() => setCollapsed(true)} />
        </div>
      )}

      {/* 移动：侧栏抽屉。Sheet 原语提供遮罩/Escape/焦点陷阱。 */}
      <Sheet
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        side="left"
        srTitle="会话导航"
        className="w-[268px] max-w-[82vw] md:hidden"
        overlayClassName="md:hidden"
      >
        <Sidebar
          {...sidebarProps}
          onSelect={(id) => {
            selectSession(id);
            setMobileNavOpen(false);
          }}
          onNew={() => {
            newSession();
            setMobileNavOpen(false);
          }}
          onCollapse={() => setMobileNavOpen(false)}
        />
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          agent={agent}
          onAgentClick={() => setPickerOpen(true)}
          models={models}
          selectedModelId={modelId}
          onSelectModel={setModelId}
          modelsLoading={modelsLoading}
          credits={demo ? null : (user?.credits ?? null)}
          onOpenBilling={demo ? undefined : openSettings}
          sidebarCollapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNew={newSession}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenInbox={demo ? undefined : () => setInboxOpen(true)}
          unreadCount={inbox.unreadCount}
          repoSelection={repo.selection}
          onOpenRepo={demo ? undefined : () => setRepoModalOpen(true)}
          theme={theme}
          onCycleTheme={cycle}
        />

        {!demo && repo.showBanner && repo.selection?.selected && (
          <RepoStatusBanner
            selection={repo.selection}
            progressPct={repo.progressPct}
            onDismiss={repo.dismissBanner}
          />
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          {gated ? (
            <AgentGate
              phase={gate.phase}
              onOpen={gate.open}
              onRetry={gate.check}
              onTopUp={openSettings}
            />
          ) : showEmpty ? (
            <EmptyState agent={agent} onPick={send} onChangeAgent={() => setPickerOpen(true)} />
          ) : demo ? (
            <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <UserMessage key={m.id} content={m.content} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    message={m}
                    toolCards={[]}
                    onRegenerate={i === messages.length - 1 && !busy ? regenerate : undefined}
                  />
                ),
              )}
              {busy && (
                <AssistantMessage
                  message={{
                    id: "streaming",
                    role: "assistant",
                    content: streamText,
                    createdAt: new Date().toISOString(),
                  }}
                  streaming
                  toolCards={toolCards}
                />
              )}
            </div>
          ) : (
            // 非 demo：真实 WS 消息流 → P5 九类 Aurora 富卡（MessageList 按 role 分派、
            // 签名 memo 防闪；tool 委托 ToolCardSlot；权限审批经 onRespondPermission）。
            <MessageList
              messages={wsMessages}
              sending={wsSending}
              cb={cardCallbacks}
              onRespondPermission={onRespondPermission}
            />
          )}
        </div>

        {/* composer-safe-b:底部 Home 指示条安全区(叠在原 pb-3 上),否则发送区被遮 */}
        <div className="shrink-0 composer-safe-b">
          {/* 任务列表 HUD:钉在输入框上方,始终可见(取代会滚走的 inline TodoWrite 卡)。
              初始展开全部 → ~3s 自动折叠成「正在执行的一条」;无任务时组件自渲染 null。 */}
          {!demo && !gated && <PinnedTaskTracker todos={extractLatestTodos(wsMessages)} />}
          {!demo && gate.phase.kind === "dormant" && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone="info">容器已休眠，发送消息后将自动唤醒。</Alert>
            </div>
          )}
          {/* WS 连接状态条（连接中/重连/补发离线消息/容器初始化等）。仅非 demo。*/}
          {!demo && !gated && chat.status.cls !== "connected" && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone={chat.status.cls === "disconnected" ? "warning" : "info"}>{chat.status.label}</Alert>
            </div>
          )}
          {chatError && (
            <ErrorBanner
              error={chatError}
              onRetry={() => {
                const t = chatError.retryText;
                setChatError(null);
                send(t);
              }}
              onDismiss={() => setChatError(null)}
            />
          )}
          <Composer
            onSend={send}
            busy={sending}
            onStop={stopTurn}
            model={modelFooter}
            disabled={gated}
            placeholder={`和「${agent.name}」对话…`}
            onUpload={demo ? undefined : uploadMedia}
            getVoiceToken={demo ? undefined : () => authRef.current.getToken()}
          />
        </div>
      </main>

      <AgentPicker
        open={pickerOpen}
        current={agent}
        auth={demo ? null : auth}
        onAddFromMarket={
          demo
            ? undefined
            : () => {
                setPickerOpen(false);
                openMarketplace("browse", "agent");
              }
        }
        onClose={() => setPickerOpen(false)}
        onPick={(a) => {
          // 切 agent：若当前会话已在 WS service 注册，打跨-agent 污染守卫戳（§11），
          // 让旧 agent 的 late frames 被 drop、stop/hello 默认 agent 跟新选一致。
          if (!demo && activeId && a.id !== agent.id) chat.switchAgent(activeId, a.id);
          setAgent(a);
          setPickerOpen(false);
          setChatError(null);
        }}
      />

      <SettingsCenter
        open={settingsOpen}
        auth={auth}
        user={user}
        theme={theme}
        demo={demo}
        onClose={() => setSettingsOpen(false)}
        onSetTheme={setTheme}
        onRefreshMe={refreshMe}
      />

      <InboxDialog
        open={inboxOpen}
        auth={auth}
        onClose={() => setInboxOpen(false)}
        onUnreadChange={inbox.refreshUnread}
      />

      <GithubRepoModal
        open={repoModalOpen}
        auth={auth}
        sessionId={activeId}
        selection={repo.selection}
        onClose={() => setRepoModalOpen(false)}
        onConfirm={repo.confirm}
        onUnbind={repo.unbind}
        onAccountUnlinked={repo.refresh}
        toast={toast}
      />

      <ManageCenter
        open={manageOpen}
        tab={manageTab}
        auth={auth}
        agentId={agent.id}
        onTabChange={setManageTab}
        onClose={() => setManageOpen(false)}
      />

      <TeamManager open={teamOpen} auth={auth} onClose={() => setTeamOpen(false)} />

      <MarketplaceCenter
        open={marketplaceOpen}
        tab={marketplaceTab}
        auth={auth}
        isAdmin={user?.role === "admin"}
        initialBrowseKind={marketplaceBrowseKind}
        onTabChange={setMarketplaceTab}
        onClose={() => {
          setMarketplaceOpen(false);
          // If the currently-selected market agent was just uninstalled, fall back
          // to 全能助手 so the header/composer don't show a stale agent.
          if (!demo && auth && agent.id !== "main") {
            const a = auth;
            api
              .listMyAgents(a)
              .then((rows) => {
                if (!rows.some((r) => r.id === agent.id)) setAgent(DEFAULT_AGENT);
              })
              .catch(() => {});
          }
        }}
      />
    </div>
    </ToolCardActionsContext.Provider>
    </MediaSignProvider>
  );
}

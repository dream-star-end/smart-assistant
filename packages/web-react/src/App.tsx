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
import { Alert, Sheet, Spinner, useConfirm, usePrompt } from "./components/ui";
import { useAgentGate } from "./hooks/useAgentGate";
import {
  type PanelParam,
  parsePanelParam,
  parseSessionPath,
  useAppRoute,
} from "./hooks/useAppRoute";
import { useAuth } from "./hooks/useAuth";
import { genWsSessionId, useSessionList } from "./hooks/useSessionList";
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
import { DEFAULT_AGENT, agentFromApiRow, type Agent } from "./lib/agents";
import { api } from "./lib/api";
import { DEMO_MESSAGES, DEMO_MODELS, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { Message, PublicConfig, PublicModel, Session, ToolCard } from "./lib/types";

const EMPTY_WS_MESSAGES: ChatMessage[] = [];

export function App() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo") === "1";
  // 密码重置邮件链接：/reset-password?token=…（gateway SPA fallback 对无扩展名路径回退
  // index.html，故 SPA 能接住）。启动即检测 → 直接进入 AuthGate 的 reset 模式。
  const resetToken =
    !demo && location.pathname === "/reset-password"
      ? params.get("token") || undefined
      : undefined;
  // P7 最小路由（无路由库）：demo / reset-password 特判不启用。boot 时一次性解析
  // URL 深链（会话 /s/<id> + 面板 ?panel=），此后 URL 是状态的 replaceState 单向镜像。
  const routingEnabled = !demo && !resetToken;
  const bootPanel = routingEnabled ? parsePanelParam(params) : null;
  // 会话深链恢复未决标记：resolve 前 useSessionList 暂停"自动选中上次会话"
  // （URL 指定 > 最近会话）；resolve/放弃后置 null。
  const [pendingRouteSession, setPendingRouteSession] = useState<string | null>(() =>
    routingEnabled ? parseSessionPath(location.pathname) : null,
  );
  // 视图态：home=营销首页,app=登录页/工作区。启动静默续期成功（useAuth onBootAuthed）
  // 直接置 app,失败停在 home。
  const [view, setView] = useState<"home" | "app">(resetToken ? "app" : "home");
  // AuthGate 初始模式：「登录」入口=login，「免费开始」入口=register，重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme();

  // 公开配置（Turnstile bypass / site key）：登录页驱动 AuthGate 是否渲染真 widget。
  const [publicCfg, setPublicCfg] = useState<PublicConfig | null>(null);

  // demo 展示消息（本地 fixture 流式回放用；非 demo 的消息权威在 WS service）。
  const [messages, setMessages] = useState<Message[]>(demo ? DEMO_MESSAGES : []);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolCards] = useState<ToolCard[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agent, setAgent] = useState(DEFAULT_AGENT);
  // 已装智能体目录(agent 归属解析用):登录后拉一次,市场关闭时刷新;AgentPicker 打开时
  // 自行拉最新,两者互不依赖。ref 镜像供 effect 读最新值而不进依赖。
  const [myAgents, setMyAgents] = useState<Agent[]>([DEFAULT_AGENT]);
  const myAgentsRef = useRef(myAgents);
  myAgentsRef.current = myAgents;
  const [pickerOpen, setPickerOpen] = useState(false);
  // 团队模式(v5 轻量组队):turn 级开关,只对「全能助手」(main)生效——开启后发消息时后端
  // 给 main 队长注入组队引导,由它按任务自主 delegate_task 组已安装 agent 成队。换 agent 不清,
  // 但只在 agent.id==='main' 时随消息发送(见 send)。开关 UI 挂在 AgentPicker 的 main 卡片。
  const [teamMode, setTeamMode] = useState(false);
  // 对话模型：唯一权威源是后端 GET /api/public/models（v5 仅 claude/glm-5.2/deepseek/minimax）。
  // demo 用本地 fixture 仅作离线视觉，不发请求。选中的 modelId 由 P4 的 WS inbound.message 顶层发送。
  const [models, setModels] = useState<PublicModel[]>(demo ? DEMO_MODELS : []);
  const [modelId, setModelId] = useState<string | undefined>(demo ? DEMO_MODELS[0]?.id : undefined);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  // 面板深链：boot 读到 ?panel= 即以打开态初始化（工作区渲染后即呈现；未登录深链则
  // 登录后呈现）。打开/关闭经 useAppRoute 同步回 query。
  const [settingsOpen, setSettingsOpen] = useState(bootPanel === "settings");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(bootPanel === "manage");
  const [manageTab, setManageTab] = useState<ManageTab>("memory");
  const [marketplaceOpen, setMarketplaceOpen] = useState(bootPanel === "market");
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>("browse");
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>("skill");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);
  // 稳定句柄：让早于 useChatSocket 声明的 send/regenerate 回调引用 WS 引擎，避免
  // “块级变量在声明前使用” 的 TDZ（hook 在下方调用后回填 sockRef.current）。
  const sockRef = useRef<UseChatSocket | null>(null);
  const toast = useToast();
  // Aurora 风格确认/输入对话框(Promise 式),取代原生 window.confirm/prompt。
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const [promptText, promptTextEl] = usePrompt();
  // GitHub 仓库绑定帧处理器的稳定间接：useChatSocket 在 useRepoBinding 之前声明，故经 ref
  // 透传（与 sockRef 同样的 TDZ 规避；handler 本身是 useRepoBinding 的稳定 useCallback）。
  const repoStatusHandlerRef = useRef<(f: RepoStatusWire) => void>(() => {});
  const repoBindErrorHandlerRef = useRef<(f: RepoBindErrorWire) => void>(() => {});

  // 本地会话消息存储（脚手架，仅 demo 路径用）：activeId → 消息数组。非 demo 走 WS + IndexedDB。
  const localStore = useRef<Map<string, Message[]>>(new Map());
  // 会话列表域整体重置的稳定间接：useSessionList 在 useAuth 之后调用（需要 auth/user），
  // clearAuth/登录成功的会话收尾经本 ref 回填（与 sockRef 同款 TDZ 规避）。
  const sessionsResetRef = useRef<() => void>(() => {});
  // 鉴权状态机整体收口在 useAuth（access token 内存唯一权威源 / 启动静默续期 / 登录·注册·
  // 找回密码 / 登出 / refreshMe）。chat 域收尾经回调注入 —— auth 域不反向依赖 chat 域；
  // 回调在 hook 内经 ref 镜像读最新版本,此处传每渲染新闭包不影响其内部引用稳定性。
  const {
    auth,
    authRef: authSessionRef,
    authed,
    user,
    authLoading,
    authError,
    booting,
    login,
    register,
    verifyEmail,
    resendVerification,
    requestReset,
    confirmReset,
    logout,
    refreshMe,
  } = useAuth({
    demo,
    resetToken,
    initialUser: demo ? DEMO_USER : null,
    // auth 清空（静默刷新失败或主动登出）→ 清会话/消息/面板态,回首页。
    onClearAuth: () => {
      localStore.current.clear();
      sessionsResetRef.current(); // 清列表/选中/已拉历史标记,允许下次登录重新自动选中
      setMessages([]);
      setChatError(null);
      setSettingsOpen(false);
      setView("home");
    },
    // 登出前清本 user 的 IndexedDB 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效）。
    onLogout: () => void sockRef.current?.wipePersistence(),
    // 启动静默续期成功 → 直接恢复工作区。
    onBootAuthed: () => setView("app"),
    // 登录成功不预载会话：由 useChatSocket IndexedDB 注水（onHydrated）+ listSessions
    // 合并 server canonical 列表填侧栏；selectSession 再按需拉取单会话历史。
    onLoginSuccess: () => {
      sessionsResetRef.current();
      setMessages([]);
    },
  });

  // AuthSession 整个生命周期是同一引用（见 useAuth：useRef 初始化后仅就地改 onExpired）。
  // 经本地 useRef 再持有一次以保留 biome 的稳定 ref 推断 —— 直接使用 hook 返回的 ref 会在
  // 多处 useCallback/useEffect 误报 useExhaustiveDependencies（lint 只认本地 useRef 为稳定）。
  const authRef = useRef(authSessionRef.current);

  const interrupt = useCallback(() => {
    stopRef.current = true;
    setBusy(false);
    setStreamText("");
    setChatError(null);
  }, []);

  // 侧栏会话列表域整体收口在 useSessionList（列表权威合并 / 按需拉历史 / 自动选中上次会话 /
  // rename·delete 三持有方收口）。UI 对话框与 chat 展示态经回调注入（hook 内 ref 镜像读最新，
  // 此处传每渲染新闭包不影响其 selectSession/newSession 的依赖面）。
  const {
    sessions,
    setSessions,
    activeId,
    setActiveId,
    selectSession,
    newSession,
    onHydrated,
    renameSessionPrompt,
    deleteSessionConfirm,
    reset: resetSessionList,
    serverListSettled,
  } = useSessionList({
    demo,
    auth,
    authSession: authRef.current,
    user,
    agentId: agent.id,
    sockRef,
    confirmDialog,
    promptText,
    clearChatError: () => setChatError(null),
    // demo：切会话时换本地 fixture 消息。
    onDemoSelect: (id) => setMessages(id === DEMO_SESSIONS[0].id ? DEMO_MESSAGES : []),
    // 新建会话：停 demo 流式回放 + 清空展示消息 + 清错误（原 newSession 前置收尾）。
    onNewSessionReset: () => {
      interrupt();
      setMessages([]);
      setChatError(null);
    },
    onDeleteSession: (id) => localStore.current.delete(id),
    onActiveSessionDeleted: () => {
      setMessages([]);
      setChatError(null);
    },
    // URL 深链恢复未决：暂停自动选中（URL 指定 > 最近会话）。
    holdAutoSelect: pendingRouteSession !== null,
  });
  // 回填给 useAuth 的 chat 域收尾（onClearAuth/onLoginSuccess 经 sessionsResetRef 调用）。
  sessionsResetRef.current = resetSessionList;

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
      // teamMode 只对 main 队长生效(其它 agent 无委派语义),故非 main 恒 false。
      sockRef.current?.send({
        sessId: sessionId,
        agentId: agent.id,
        text,
        model: modelId,
        media,
        teamMode: agent.id === "main" ? teamMode : false,
      });
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
    // teamMode 必须在依赖里:否则 memoized send 闭包捕获初始 false,用户开开关后仍发 false(Codex 审)。
    // setSessions/setActiveId 是 useSessionList 透传的 useState dispatcher(恒稳定),入 deps
    // 仅为满足 lint(跨 hook 返回值 biome 不再推断稳定性),不改变 send 的重建时机。
    [activeId, demo, user, agent, modelId, teamMode, setSessions, setActiveId],
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
    if (demo) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          send(messages[i].content ?? "");
          return;
        }
      }
      return;
    }
    // 保真重发:_modelText 是"含附件的完整模型可见文本"(权威,regen 专用字段),text 只是
    // 显示文案;media 一并透传 —— 此前只回发显示文本,带附件的提问 regen 后附件全丢。
    const src = sockRef.current?.getMessages(activeId) ?? [];
    for (let i = src.length - 1; i >= 0; i--) {
      const m = src[i];
      // 跳过 auto-continue/auto-retry 行:那是系统续跑文案,不是用户的真实提问。
      if (m.role === "user" && !m._isAutoRetry) {
        send(m._modelText ?? m.text ?? "", m._media);
        return;
      }
    }
  }, [demo, messages, activeId, send]);

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

  // 已装智能体目录:登录后拉一次(会话 agent 归属解析用;失败留默认,解析回落 stub 不阻断)。
  useEffect(() => {
    if (demo || !auth) return;
    let cancelled = false;
    api
      .listMyAgents(authRef.current)
      .then((rows) => {
        if (!cancelled) setMyAgents(rows.map(agentFromApiRow));
      })
      .catch(() => {});
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

  // agent 归属单一权威 = 活动会话的 sess.agentId。此前"当前 agent"是独立全局态,切会话
  // 不 reconcile → 在会话 A 切到编程助手后选中旧会话 B(agentId=main),header/send 显示
  // 编程助手而 sess.agentId 仍是 main:stopTurn/hello 续传游标用错 agent(停止停不掉本轮)、
  // §11 跨 agent 污染守卫也未打戳。收口:切会话/历史合并后把 App.agent 同步为会话归属。
  const activeSessAgentId = !demo && activeId ? chat.getSession(activeId)?.agentId : undefined;
  useEffect(() => {
    if (!activeSessAgentId || activeSessAgentId === agent.id) return;
    const resolved =
      activeSessAgentId === DEFAULT_AGENT.id
        ? DEFAULT_AGENT
        : (myAgentsRef.current.find((a) => a.id === activeSessAgentId) ?? {
            // 已卸载/目录未含的 agent:退化 stub(id 直显),仍保证 send/stop 归属一致。
            id: activeSessAgentId,
            name: activeSessAgentId,
            avatarEmoji: "🤖",
            grad: "from-violet-500 to-fuchsia-600",
            description: "",
          });
    setAgent(resolved);
  }, [activeSessAgentId, agent.id]);

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

  // autoscroll 根治(两个对称 bug 一次收口):
  //  1. 旧依赖 [wsMessages] 是就地 mutation 的同一数组引用 → 流式期间 deps 恒等,effect
  //     只在 turn 边界跑一次,回复长出视口后不再跟随。变更的权威信号是 chat.version
  //     (快照单调版本号,与本仓"version 才是变更权威"的约定一致)。
  //  2. 旧实现无条件劫持:用户上翻回看历史也被拽回底部。改为 near-bottom 粘滞 ——
  //     只有用户本就贴底(<80px)时才跟随;上翻即解除,拉回底部自动恢复。
  const stickToBottomRef = useRef(true);
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  // 切会话:重置粘滞并瞬时跳底(历史回看从底部开始)。
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);
  // 内容变更跟随:demo 走 messages/streamText,真实路径走 version/wsSending。
  // 流式期间高频触发,用瞬时赋值而非 smooth(60fps 下排队的平滑动画反而卡顿)。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, chat.version, wsSending]);

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

  // ── P7 最小路由接线：URL 单向镜像（会话路径 + 面板 query）/ popstate / 深链恢复 ──
  // 面板深链单选优先级：settings > market > manage（同时开多个时 URL 反映最先者）。
  const activePanel: PanelParam | null = settingsOpen
    ? "settings"
    : marketplaceOpen
      ? "market"
      : manageOpen
        ? "manage"
        : null;
  useAppRoute({
    enabled: routingEnabled,
    inWorkspace,
    activeId,
    sessions,
    serverListSettled,
    pendingSessionId: pendingRouteSession,
    clearPendingSession: () => setPendingRouteSession(null),
    selectSession,
    // popstate 回 "/"：清选中回空会话态（与删除当前会话的展示收尾一致）。
    onPopToRoot: () => {
      setActiveId(undefined);
      setMessages([]);
      setChatError(null);
    },
    activePanel,
  });

  // 启动续期检查中:极简 splash(避免"闪一下首页又跳工作区"的割裂;通常 <300ms)。
  if (!demo && booting) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        <Spinner size={22} />
      </div>
    );
  }
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
  // rename/delete 的数据收口（三持有方）在 useSessionList。
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

        <div ref={scrollRef} onScroll={onChatScroll} className="flex-1 overflow-y-auto overflow-x-hidden">
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
        teamMode={teamMode}
        onToggleTeamMode={demo ? undefined : setTeamMode}
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

      <MarketplaceCenter
        open={marketplaceOpen}
        tab={marketplaceTab}
        auth={auth}
        isAdmin={user?.role === "admin"}
        initialBrowseKind={marketplaceBrowseKind}
        onTabChange={setMarketplaceTab}
        onClose={() => {
          setMarketplaceOpen(false);
          // 市场关闭后刷新已装目录(装/卸都会变);若当前选中的市场 agent 刚被卸载,
          // 回落全能助手,header/composer 不显示 stale agent。
          if (!demo && auth) {
            const a = auth;
            api
              .listMyAgents(a)
              .then((rows) => {
                setMyAgents(rows.map(agentFromApiRow));
                if (agent.id !== "main" && !rows.some((r) => r.id === agent.id)) {
                  setAgent(DEFAULT_AGENT);
                }
              })
              .catch(() => {});
          }
        }}
      />
      {confirmDialogEl}
      {promptTextEl}
    </div>
    </ToolCardActionsContext.Provider>
    </MediaSignProvider>
  );
}

import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isCodexEngineModel } from "@openclaude/protocol";
import { AgentGate } from "./components/AgentGate";
import { LazyBoundary } from "./components/ChunkErrorBoundary";
import { AgentPicker } from "./components/AgentPicker";
import { AuthGate, type AuthMode } from "./components/AuthGate";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import {
  ImageAnnotationEditor,
  type ImageAnnotationExport,
  type ImageAnnotationSource,
} from "./components/ImageAnnotationEditor";
import { extractLatestTodos, PinnedTaskTracker } from "./components/chat/PinnedTaskTracker";
import { deriveActivePlanStep, type TurnActivityInfo } from "./components/chat/TurnActivity";
import { EmptyState } from "./components/EmptyState";
import { type ChatError, ErrorBanner } from "./components/ErrorBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { GithubRepoModal } from "./components/github/GithubRepoModal";
import { RepoStatusBanner } from "./components/github/RepoStatusBanner";
import { InboxDialog } from "./components/InboxDialog";
import { CHAT_CREATE_TEMPLATES } from "./lib/chatCreateTemplates";
import type { ManageTab } from "./components/ManageCenter";
import type { MarketplaceKind, MarketplaceTab } from "./components/MarketplaceCenter";
import { AssistantMessage, UserMessage } from "./components/Message";
import { MessageList, type MessageListArchive } from "./components/MessageRenderer";
import { MessageListSkeleton, shouldShowHistorySkeleton } from "./components/chat/HistorySkeleton";
import { correctedScrollTop } from "./components/chat/archivePaging";
import type { CardCallbacks } from "./components/chat/cards";
import {
  type RatingEntry,
  type ResponseRatingCtx,
  ResponseRatingProvider,
} from "./components/chat/ResponseRating";
import { MediaSignProvider } from "./components/chat/media";
import { ChatInteractionContext, ToolCardActionsContext } from "./components/tool/context";
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
import type { InboundMessage, MediaRef } from "./lib/chat/frames";
import type { ChatMessage } from "./lib/chat/model";
import { CONTINUE_PROMPT } from "./lib/chat/render";
import { deriveConnBanner } from "./lib/chat/pure";
import {
  clearTeamModeForSession,
  readTeamModeForSession,
  writeTeamMode,
} from "./lib/teamMode";
import { DEFAULT_AGENT, agentFromApiRow, type Agent } from "./lib/agents";
import { api } from "./lib/api";
import {
  effectiveEffortModelId,
  effortForModel,
  extractPrefs,
  initialModelFromPreferences,
  type PreferenceEffort,
  type PrefsView,
} from "./lib/modelPreferences";
import { DEMO_MESSAGES, DEMO_MODELS, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { Message, PublicConfig, PublicModel, Session, ToolCard } from "./lib/types";

// 首屏瘦身:四大中心（营销首页 + 三个全屏对话框）改按需异步加载,移出 entry chunk。
// 命名导出 → default 适配。渲染点各自套 LazyBoundary（= chunk 加载失败兜底 + Suspense：
// 对话框仅在 open 时挂载 → 首屏零下载,首次打开拉块时短暂显 loading；React.lazy 解析后模块
// 常驻,再次打开无回退闪烁。发新版后旧标签页拉不到旧 chunk 时由 ChunkErrorBoundary 兜底,
// 提示刷新而非白屏——见 components/ChunkErrorBoundary）。
const Landing = lazy(() => import("./components/Landing").then((m) => ({ default: m.Landing })));
const SettingsCenter = lazy(() =>
  import("./components/SettingsCenter").then((m) => ({ default: m.SettingsCenter })),
);
const ManageCenter = lazy(() => import("./components/ManageCenter").then((m) => ({ default: m.ManageCenter })));
const MarketplaceCenter = lazy(() =>
  import("./components/MarketplaceCenter").then((m) => ({ default: m.MarketplaceCenter })),
);
// 企业版(P3.1)第四中心。仅 org owner/admin 有入口(成员在设置·账户页只读展示)。
const OrgCenter = lazy(() => import("./components/OrgCenter").then((m) => ({ default: m.OrgCenter })));

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取四个懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    void import("./components/Landing").catch(() => {});
    void import("./components/SettingsCenter").catch(() => {});
    void import("./components/ManageCenter").catch(() => {});
    void import("./components/MarketplaceCenter").catch(() => {});
    void import("./components/OrgCenter").catch(() => {});
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch, { timeout: 8000 });
  } else {
    setTimeout(prefetch, 3000);
  }
}

/** 全屏懒块加载态（营销首页 chunk 下载期）——与启动续期 splash 同视觉,不割裂。*/
function SplashFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-muted">
      <Spinner size={22} />
    </div>
  );
}
/** 对话框懒块加载态——铺一层与 Dialog.Overlay 同款的半透明遮罩 + 居中 spinner,
 *  首次打开拉块的短暂空窗内给出「正在打开」的视觉,避免点击后无反馈。*/
function DialogFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <Spinner size={22} />
    </div>
  );
}

const EMPTY_WS_MESSAGES: ChatMessage[] = [];

// 冷会话骨架屏窗口（见 HistorySkeleton.shouldShowHistorySkeleton）：
//  - GRACE：meta 未知（深链/列表未落定）时的兜底窗，过后放行 EmptyState。
//  - CAP：确知有历史但迟迟不到（getSession 慢/失败）的安全封顶，防骨架永停。
const HISTORY_SKELETON_GRACE_MS = 800;
const HISTORY_SKELETON_CAP_MS = 8000;

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
  // 自行拉最新,两者互不依赖。目录**必须**参与会话归属解析的依赖(见下方 effect 注释)。
  const [myAgents, setMyAgents] = useState<Agent[]>([DEFAULT_AGENT]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 对话模型/默认思考深度:模型能力来自 GET /api/public/models；用户默认来自
  // /api/me/preferences。两者同批 hydrate 后才决定初始值,避免迟到偏好覆盖人工选择。
  const [models, setModels] = useState<PublicModel[]>(demo ? DEMO_MODELS : []);
  const [modelId, setModelId] = useState<string | undefined>(demo ? DEMO_MODELS[0]?.id : undefined);
  const [preferenceEffort, setPreferenceEffort] = useState<PreferenceEffort | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [imageAnnotationSource, setImageAnnotationSource] = useState<ImageAnnotationSource | null>(null);
  // 面板深链：boot 读到 ?panel= 即以打开态初始化（工作区渲染后即呈现；未登录深链则
  // 登录后呈现）。打开/关闭经 useAppRoute 同步回 query。
  const [settingsOpen, setSettingsOpen] = useState(bootPanel === "settings");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(bootPanel === "manage");
  const [manageTab, setManageTab] = useState<ManageTab>("memory");
  const [marketplaceOpen, setMarketplaceOpen] = useState(bootPanel === "market");
  const [orgOpen, setOrgOpen] = useState(bootPanel === "org");
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>("browse");
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>("skill");
  // 「在对话中创建」技能/智能体:关市场 → 新会话 → Composer 预填引导模板(用户改后发送)。
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  // 归档「从云端加载更早历史」按钮子态(§4:加载中 / 失败可重试)。切会话时重置(见下)。
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 归档前插视口锚点:点击加载前记录 scrollHeight/scrollTop,前插渲染后按高度差校正 scrollTop(见下)。
  const archiveScrollAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
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
      setOrgOpen(false);
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
    onDeleteSession: (id) => {
      localStore.current.delete(id);
      clearTeamModeForSession(id); // 顺手清该会话的团队模式 per-session 键(不留孤儿键)
    },
    onActiveSessionDeleted: () => {
      setMessages([]);
      setChatError(null);
    },
    // URL 深链恢复未决：暂停自动选中（URL 指定 > 最近会话）。
    holdAutoSelect: pendingRouteSession !== null,
  });
  // 回填给 useAuth 的 chat 域收尾（onClearAuth/onLoginSuccess 经 sessionsResetRef 调用）。
  sessionsResetRef.current = resetSessionList;

  // 团队模式(v5 轻量组队):**会话级**开关(清「设备级粘滞开关」债)。每个会话独立记忆,
  // per-session 键 `oc_v5_team_mode:<sessionId>` 承载;新会话继承全局偏好默认值
  // (`oc_v5_team_mode`,镜像用户最近一次选择——老用户习惯不变:上次开着新会话也开着)。
  // 切会话按 activeId 重读(下方 effect);开关切换同时写 per-session + 全局默认
  // (见 lib/teamMode)。语义仍为 turn 级 flag,只对「全能助手」(main)生效,只在
  // agent.id==='main' 时随消息发送(见 send)。开关 UI 挂在 AgentPicker 的 main 卡片。
  // 声明在 useSessionList 之后:setTeamMode/重读 effect 需要 activeId 定位当前会话。
  const [teamMode, setTeamModeState] = useState(() => readTeamModeForSession(activeId));
  const setTeamMode = useCallback(
    (enabled: boolean) => {
      setTeamModeState(enabled);
      writeTeamMode(activeId, enabled);
    },
    [activeId],
  );
  // 切会话:按目标会话的 per-session 键重读(缺失回退全局默认)。activeId 为空(空会话态)
  // 读全局默认;首条消息在 send 里把当前 intent 落地为该会话的 per-session 键。
  useEffect(() => {
    setTeamModeState(readTeamModeForSession(activeId));
  }, [activeId]);

  const send = useCallback(
    async (text: string, media?: MediaRef[], imageEdit?: InboundMessage["content"]["imageEdit"]) => {
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
        // 空会话态用户可能已在全能助手卡上开/关了团队模式;把当前 intent 落地为新会话的
        // per-session 键 —— 否则该会话只靠全局默认,会被其它会话的开关翻动(切走再回来变样)。
        writeTeamMode(sessionId, teamMode);
      }
      sockRef.current?.ensureSession(sessionId, agent.id, text.slice(0, 24));
      // model / effortLevel 都是 inbound.message 顶层路由字段。用户未设置 effort 或
      // 当前模型不支持时省略,让模型沿用自身默认。
      // media：已上传附件（图片/文件等），随 inbound.message.content.media 发送。
      // teamMode 只对 main 队长生效(其它 agent 无委派语义),故非 main 恒 false。
      const teamLeaderTurn = agent.id === "main" && teamMode;
      sockRef.current?.send({
        sessId: sessionId,
        agentId: agent.id,
        text,
        model: modelId,
        effortLevel: effortForModel(
          models,
          effectiveEffortModelId(modelId, teamLeaderTurn),
          preferenceEffort,
        ),
        media,
        imageEdit,
        teamMode: teamLeaderTurn,
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
    [
      activeId,
      demo,
      user,
      agent,
      modelId,
      models,
      preferenceEffort,
      teamMode,
      setSessions,
      setActiveId,
    ],
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

  const submitImageAnnotation = useCallback(
    async (value: ImageAnnotationExport) => {
      const [sourceMedia, maskMedia, guideMedia] = await Promise.all([
        uploadMedia(value.source),
        uploadMedia(value.mask),
        uploadMedia(value.guide),
      ]);
      const media: MediaRef[] = [
        { ...sourceMedia, hidden: true },
        { ...maskMedia, hidden: true },
        guideMedia,
      ];
      await send(value.prompt, media, {
        clientJobId: value.clientJobId,
        sourceIndex: 0,
        maskIndex: 1,
        guideIndex: 2,
        width: value.width,
        height: value.height,
      });
      toast("已提交精确修改，成功生成后扣 50 积分", "success");
    },
    [send, toast, uploadMedia],
  );

  // 会话物化:GitHub 绑定是 per-session,新会话未发首条消息前 activeId 为空 → 绑定确定钮
  // 恒禁用(!sessionId)。需要绑定时先物化一个会话占位(与「+新对话」同款:仅生成 peer.id +
  // 入侧栏 + 选中,不提前 ensureSession/持久化——空会话不占 service 槽位)。sessionId 立即可用;
  // 真绑定时 sendRepoBind 内部会自行 ensureSession+hello 注册 peer;首条消息也复用该会话。
  const ensureActiveSession = useCallback((): string | undefined => {
    if (demo || !user) return activeId;
    if (activeId) return activeId;
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
    return id;
  }, [demo, user, activeId, setSessions, setActiveId]);

  // 打开 GitHub 绑定 modal:先确保有承载会话,否则「确认绑定」因 !sessionId 恒禁用
  // (输入框底部入口 → 发消息前即可绑定)。
  const openRepo = useCallback(() => {
    ensureActiveSession();
    setRepoModalOpen(true);
  }, [ensureActiveSession]);

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

  const applyConversationPreferences = useCallback(
    (prefs: PrefsView, patch?: Record<string, unknown>) => {
      setPreferenceEffort(prefs.default_effort);
      if (
        patch &&
        Object.prototype.hasOwnProperty.call(patch, "default_model")
      ) {
        setModelId(initialModelFromPreferences(models, prefs));
      }
    },
    [models],
  );

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

  // 打开组织中心(企业版第四中心;仅 owner/admin 有入口)。顺带刷新余额/归属。
  const openOrg = useCallback(() => {
    void refreshMe();
    setOrgOpen(true);
  }, [refreshMe]);

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

  // 组织邀请接受流:URL 带 ?orgInvite=<token>。已登录 → 确认弹层 → accept → 刷新 /api/me;
  // 未登录 → token 留在 URL(不清),先走 AuthGate 登录/注册,进工作区后本 effect 再触发续接。
  const orgInviteTokenRef = useRef<string | null>(
    !demo && routingEnabled ? new URLSearchParams(location.search).get("orgInvite") : null,
  );
  const orgInviteHandledRef = useRef(false);
  useEffect(() => {
    if (demo || orgInviteHandledRef.current) return;
    const token = orgInviteTokenRef.current;
    if (!token) return;
    // 未进工作区(未登录)→ 保留 token,等登录完成后再处理(effect 依赖变化会重跑)。
    if (!inWorkspace || !auth || !user) return;
    orgInviteHandledRef.current = true;
    const a = auth;
    void (async () => {
      const ok = await confirmDialog({
        title: "接受组织邀请?",
        body: "你被邀请加入一个组织。接受后你的对话用量将可计入该组织钱包。",
        confirmText: "接受邀请",
      });
      // 无论接受与否都清掉 query,避免刷新重复弹层。
      const sp = new URLSearchParams(window.location.search);
      sp.delete("orgInvite");
      const q = sp.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
      if (!ok) return;
      try {
        await api.acceptOrgInvitation(a, token);
        await refreshMe();
        toast("已加入组织", "success");
      } catch (e) {
        toast(`接受邀请失败：${(e as Error).message}`, "error");
      }
    })();
  }, [demo, inWorkspace, auth, user, confirmDialog, refreshMe, toast]);

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
    Promise.all([
      api.getPublicModels(auth),
      api.getPreferences(auth).then(extractPrefs).catch(() => ({} as PrefsView)),
    ])
      .then(([ms, prefs]) => {
        if (cancelled) return;
        setModels(ms);
        setModelId(initialModelFromPreferences(ms, prefs));
        setPreferenceEffort(prefs.default_effort);
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
    if (!activeSessAgentId) return;
    const resolved =
      activeSessAgentId === DEFAULT_AGENT.id
        ? DEFAULT_AGENT
        : (myAgents.find((a) => a.id === activeSessAgentId) ?? DEFAULT_AGENT);
    if (resolved.id === DEFAULT_AGENT.id && activeSessAgentId !== DEFAULT_AGENT.id && activeId) {
      chat.switchAgent(activeId, DEFAULT_AGENT.id);
    }
    // myAgents 必须进依赖:刷新/重开会话时目录常晚于会话解析到达,若只看 id 相等就
    // early-return,stub(裸 slug 如 research-assistant)会永久卡在 header,目录到了
    // 也不重算。按展示字段判等:id/名字/头像任一不同才 set(stub→真名会触发,恒等
    // 时不 set,防 set→重渲→effect 的循环)。
    if (
      resolved.id !== agent.id ||
      resolved.name !== agent.name ||
      resolved.avatarEmoji !== agent.avatarEmoji
    ) {
      setAgent(resolved);
    }
  }, [activeSessAgentId, activeId, agent.id, agent.name, agent.avatarEmoji, myAgents, chat]);

  // 非 demo：展示的消息来自 WS service 快照（就地 mutation + version 触发重渲）。
  const wsMessages = !demo && activeId ? chat.getMessages(activeId) : EMPTY_WS_MESSAGES;
  const wsSending = !demo && chat.isSending(activeId);
  // 统一“本轮进行中”信号：demo 用本地 busy，非 demo 用 WS in-flight。
  const sending = demo ? busy : wsSending;

  // 当前选中会话（对账/本轮活动指示的数据源）。告知 WS service 供 S1 对账无条件优先拉它。
  const activeSess = !demo && activeId ? chat.getSession(activeId) : undefined;
  useEffect(() => {
    if (demo) return;
    sockRef.current?.setActiveSession(activeId);
  }, [demo, activeId]);

  // 本轮活动快照（喂给 MessageList → TurnActivity）：模型慢时把阶段反馈显性化，取代裸三个点。
  // 团队模式额外带队长当前 plan step（消息区常长时间纯空白时用它填充等待文案）。
  const teamLeaderActive = !demo && teamMode && agent.id === "main";
  const turnActivity = useMemo<TurnActivityInfo | null>(() => {
    if (demo || !activeSess || !activeSess._sendingInFlight) return null;
    return {
      startedAt: activeSess._turnStartedAt ?? null,
      lastFrameAt: activeSess._lastFrameAt,
      turnStatus: activeSess._turnStatus ?? null,
      coldStart: !!activeSess._isFirstTurnAfterReady,
      agentName: agent.name || "助手",
      leaderStep: teamLeaderActive ? deriveActivePlanStep(extractLatestTodos(wsMessages)) : null,
    };
    // chat.version 是就地 mutation 会话的变更权威信号（同引用，须显式入依赖才随帧刷新）。
  }, [demo, activeSess, teamLeaderActive, agent.name, wsMessages, chat.version]);

  // ── 冷会话加载骨架屏窗口计时 ──────────────────────────────────────────
  // activeId 变化即重置两个截止标记；GRACE 用于 meta 未知（深链）分支，CAP 是安全封顶。
  // 骨架本身随 wsMessages 到达（cachedCount>0）立即隐藏，计时器只做「永不停」兜底。
  const [historyGraceExpired, setHistoryGraceExpired] = useState(false);
  const [historyCapExpired, setHistoryCapExpired] = useState(false);
  useEffect(() => {
    setHistoryGraceExpired(false);
    setHistoryCapExpired(false);
    if (demo || !activeId) return;
    const t1 = setTimeout(() => setHistoryGraceExpired(true), HISTORY_SKELETON_GRACE_MS);
    const t2 = setTimeout(() => setHistoryCapExpired(true), HISTORY_SKELETON_CAP_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [demo, activeId]);

  // 会话级 transient 软提示（"较长时间未收到新内容…"）：非消息卡片、不落库；随快照读回。
  const transientNotice = !demo && activeId ? chat.getTransientNotice(activeId) : null;
  // 弱网/重连状态条三态分流（离线 / 环境启动中 / 服务端重连中）。文案与 tone 收口在
  // deriveConnBanner（纯函数，单测锁定）；返回 null 时不显条。demo 恒不显（本地回放无 WS）。
  const connBanner = demo
    ? null
    : deriveConnBanner({
        cls: chat.status.cls,
        label: chat.status.label,
        browserOnline: chat.browserOnline,
        provisioning: chat.provisioning,
      });
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
  // 逐条响应评价（👍/👎 + 可选标签/评论）。单一权威 = 本 Map（含乐观态），经 Context 下发给
  // 每条 AssistantCard 底部的 ResponseRatingCard。切会话/加载后由 GET 回读已评态填充（见下方
  // effect）；提交时乐观同步更新 + 静默 POST（维护期 503 / 限流 / 网络失败一律吞，不打断）。
  const [sessionRatings, setSessionRatings] = useState<Map<string, RatingEntry>>(() => new Map());
  const onRateResponse = useCallback(
    (input: {
      messageId: string;
      rating: "up" | "down";
      traceId?: string | null;
      tags?: string[];
      comment?: string;
    }) => {
      if (demo || !activeId || !user) return;
      // 乐观更新:bare thumb(无 tags)时,同 thumb 沿用旧标签、切 thumb 清空;带 tags 直接覆盖。
      setSessionRatings((prev) => {
        const next = new Map(prev);
        const prevEntry = next.get(input.messageId);
        const tags = input.tags ?? (prevEntry?.rating === input.rating ? prevEntry.tags : []);
        next.set(input.messageId, { rating: input.rating, tags });
        return next;
      });
      void api
        .submitResponseRating(authRef.current, {
          messageId: input.messageId,
          rating: input.rating,
          sessionId: activeId,
          traceId: input.traceId ?? undefined,
          model: modelId,
          tags: input.tags,
          comment: input.comment,
        })
        .catch(() => {
          /* 静默:503 维护 / 429 限流 / 网络失败——保留乐观态,刷新后由 GET 对账。*/
        });
    },
    [demo, activeId, user, modelId],
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

  // 对话交互(```options 选择卡片等):点选即替用户发送。demo 不给发送能力(纯展示)。
  const chatInteraction = useMemo(
    () => (demo ? {} : { sendUserText: (t: string) => send(t), busy: sending }),
    [demo, send, sending],
  );

  // 发送失败重试：复用原消息 payload（含附件引用）走 WS service 既有发送收口原地重发；
  // model/teamMode/effort 由 socket 复用失败首发的 routing 快照,不读取当前偏好。
  const retrySend = useCallback(
    (msg: ChatMessage) => {
      if (demo || !activeId) return;
      sockRef.current?.retryMessage({
        sessId: activeId,
        msgId: msg.id,
        agentId: agent.id,
      });
    },
    [demo, activeId, agent.id],
  );

  // 卡片回调集（稳定引用：作为 MessageRenderer memo 比较键之一，避免无谓重渲）。
  const cardCallbacks: CardCallbacks = useMemo(
    () => ({
      onRegenerate: regenerate,
      onContinue: () => send(CONTINUE_PROMPT),
      onTopUp: demo ? undefined : openSettings,
      onFeedback,
      onRetrySend: demo ? undefined : retrySend,
    }),
    [regenerate, send, demo, openSettings, onFeedback, retrySend],
  );

  // 已评回读：切会话/登录后拉一次 GET，填充已评态（重开会话时高亮 👍/👎、避免重复采集）。
  // 依赖用**派生布尔**（非 user 对象，refreshMe 换引用不误触发清空）+ activeId。切会话先清
  // 旧 Map（防串态），再异步注水；cancelled 守卫防慢响应覆盖新会话。demo/未登录不拉。
  const ratingsEnabled = !demo && !!user;
  useEffect(() => {
    setSessionRatings(new Map());
    if (!ratingsEnabled || !activeId) return;
    let cancelled = false;
    api
      .getSessionRatings(authRef.current, activeId)
      .then((map) => {
        if (cancelled) return;
        const next = new Map<string, RatingEntry>();
        for (const [mid, v] of Object.entries(map)) {
          if (v && (v.rating === "up" || v.rating === "down")) {
            next.set(mid, { rating: v.rating, tags: Array.isArray(v.tags) ? v.tags : [] });
          }
        }
        setSessionRatings(next);
      })
      .catch(() => {
        /* 静默:503 维护 / 网络失败——无已评高亮,不影响新评。*/
      });
    return () => {
      cancelled = true;
    };
  }, [ratingsEnabled, activeId]);

  // 评价 Context 载荷:demo/未登录 → null（ResponseRatingCard 自渲 null，天然隐藏）。
  const ratingCtx: ResponseRatingCtx | null = useMemo(
    () => (ratingsEnabled ? { ratings: sessionRatings, submit: onRateResponse } : null),
    [ratingsEnabled, sessionRatings, onRateResponse],
  );

  // autoscroll 根治(两个对称 bug 一次收口):
  //  1. 旧依赖 [wsMessages] 是就地 mutation 的同一数组引用 → 流式期间 deps 恒等,effect
  //     只在 turn 边界跑一次,回复长出视口后不再跟随。变更的权威信号是 chat.version
  //     (快照单调版本号,与本仓"version 才是变更权威"的约定一致)。
  //  2. 旧实现无条件劫持:用户上翻回看历史也被拽回底部。改为 near-bottom 粘滞 ——
  //     只有用户本就贴底(<80px)时才跟随;上翻即解除,拉回底部自动恢复。
  const stickToBottomRef = useRef(true);
  const scrollToChatBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  // 切会话:重置粘滞并瞬时跳底(历史回看从底部开始);同时清归档按钮子态与视口锚点。
  useEffect(() => {
    stickToBottomRef.current = true;
    scrollToChatBottom();
    setArchiveLoading(false);
    setArchiveError(false);
    archiveScrollAnchorRef.current = null;
  }, [activeId, scrollToChatBottom]);
  // 内容变更跟随:demo 走 messages/streamText,真实路径走 version/wsSending。
  // 流式期间高频触发,用瞬时赋值而非 smooth(60fps 下排队的平滑动画反而卡顿)。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToChatBottom();
  }, [messages, streamText, chat.version, wsSending, scrollToChatBottom]);

  // 归档「从云端加载更早历史」:前插旧消息会顶开视口,记录插入前 scrollHeight/scrollTop,
  // 前插渲染后按高度差把 scrollTop 顶回去 → 用户视口锚定在原来那条消息,不跳。
  const onLoadOlderHistory = useCallback(async () => {
    if (demo || !activeId) return;
    const el = scrollRef.current;
    if (el) archiveScrollAnchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
    setArchiveError(false);
    setArchiveLoading(true);
    try {
      // loadOlderHistory 是非抛出式契约:失败以 {ok:false} 返回(hasMore 不封死,可重试)。
      const res = await chat.loadOlderHistory(activeId);
      if (!res.ok) {
        setArchiveError(true);
        archiveScrollAnchorRef.current = null;
      }
    } catch {
      setArchiveError(true);
      archiveScrollAnchorRef.current = null;
    } finally {
      setArchiveLoading(false);
    }
  }, [demo, activeId, chat]);
  // 前插行渲染后(paint 前)校正 scrollTop;仅当内容真正变高才应用,避免其它 version bump
  // (流式等)误触发。useLayoutEffect 先于 stick-to-bottom 的 useEffect,且此刻用户在顶部
  // (stick=false)故不会被拽回底部。
  useLayoutEffect(() => {
    const anchor = archiveScrollAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) {
      archiveScrollAnchorRef.current = null;
      return;
    }
    if (el.scrollHeight > anchor.prevHeight) {
      el.scrollTop = correctedScrollTop(anchor.prevHeight, el.scrollHeight, anchor.prevTop);
      archiveScrollAnchorRef.current = null;
    }
  }, [chat.version]);

  // iOS Safari 的地址栏/底栏/截图/输入键盘会触发 visualViewport 高度与 offset 抖动。
  // CSS dvh 仍可能短暂大于真实可视区；键盘弹起时 Safari 还会 pan visual viewport,
  // 让 fixed root 的 top:0 看起来被顶到屏幕上方。这里把实测 height + offsetTop
  // 写入 CSS var；若用户本就在底部或本轮正在生成，下一帧重新贴底。
  useEffect(() => {
    if (!inWorkspace) return;
    let raf: number | null = null;
    const setVisualViewportVars = () => {
      const vv = window.visualViewport;
      const h = vv?.height || window.innerHeight;
      if (Number.isFinite(h) && h > 0) {
        document.documentElement.style.setProperty("--oc-visual-height", `${Math.round(h)}px`);
      }
      const top = vv?.offsetTop || 0;
      if (Number.isFinite(top)) {
        document.documentElement.style.setProperty("--oc-visual-offset-top", `${Math.max(0, Math.round(top))}px`);
      }
    };
    const realign = () => {
      setVisualViewportVars();
      if (!stickToBottomRef.current && !sending) return;
      if (typeof requestAnimationFrame === "function") {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = null;
          scrollToChatBottom();
        });
      } else {
        scrollToChatBottom();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") realign();
    };
    realign();
    window.visualViewport?.addEventListener("resize", realign);
    window.visualViewport?.addEventListener("scroll", realign);
    window.addEventListener("resize", realign);
    window.addEventListener("pageshow", realign);
    window.addEventListener("focus", realign);
    document.addEventListener("focusin", realign);
    document.addEventListener("focusout", realign);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", realign);
      window.visualViewport?.removeEventListener("scroll", realign);
      window.removeEventListener("resize", realign);
      window.removeEventListener("pageshow", realign);
      window.removeEventListener("focus", realign);
      document.removeEventListener("focusin", realign);
      document.removeEventListener("focusout", realign);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.style.removeProperty("--oc-visual-height");
      document.documentElement.style.removeProperty("--oc-visual-offset-top");
    };
  }, [inWorkspace, sending, scrollToChatBottom]);

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
        : orgOpen
          ? "org"
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
      <LazyBoundary fallback={<SplashFallback />}>
        <Landing
          onStart={() => {
            setAuthMode("register");
            setView("app");
          }}
          onLogin={() => {
            setAuthMode("login");
            setView("app");
          }}
          onCreateOrg={() => {
            // 「创建组织」深链(/?panel=org 等价):置 org 打开态 → 进 app。
            // 未登录 → AuthGate(login 模式,与深链默认一致);登录后工作区渲染即呈现
            // OrgCenter(无 org→向导 / 有 org→正常视图);useAppRoute 会把 orgOpen 镜像回
            // ?panel=org。已登录用户不经此路径(booted authed 已在 app 视图)。
            setAuthMode("login");
            setOrgOpen(true);
            setView("app");
          }}
          theme={theme}
          onCycleTheme={cycle}
        />
      </LazyBoundary>
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

  // 冷会话加载骨架：切换/深链到本地无缓存会话、getSession 拉取期间显示消息形骨架，
  // 取代「空白 → 突然填满」。meta（messageCount）取自侧栏当前选中会话，metaKnown
  // 需 listSessions 已落定且命中列表（否则视为深链未决走 800ms 兜底窗）。
  const activeMeta = !demo && activeId ? sessions.find((s) => s.id === activeId) : undefined;
  const loadingHistory =
    !demo &&
    shouldShowHistorySkeleton({
      selected: !!activeId,
      gated,
      cachedCount: wsMessages.length,
      sending: wsSending,
      knownMessageCount: activeMeta?.messageCount ?? 0,
      metaKnown: serverListSettled && !!activeMeta,
      graceExpired: historyGraceExpired,
      capExpired: historyCapExpired,
    });

  // 归档分页上下文(§4):归档水位/计数从会话读(ChatSession._archived*),loading/error 与加载动作在本层。
  // demo / 无选中会话时不下发(MessageList 退化为纯本地翻页)。
  const messageListArchive: MessageListArchive | undefined =
    !demo && activeId
      ? {
          archivedCount: activeSess?._archivedCount ?? 0,
          archivedThroughSeq: activeSess?._archivedThroughSeq ?? 0,
          loading: archiveLoading,
          error: archiveError,
          onLoadOlder: onLoadOlderHistory,
        }
      : undefined;

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
    // 管理后台入口:仅平台超管(user.role === 'admin')可见,导航到 React 管理后台
    // (web-react 第二 Vite 入口 /admin.html)。非 admin / demo 一律不渲染。
    showAdmin: !demo && user?.role === "admin",
    // 组织入口:仅 org owner/admin 可见(成员无管理面,只在设置·账户页只读展示归属)。
    onOpenOrg:
      demo || !(user?.org && (user.org.role === "owner" || user.org.role === "admin"))
        ? undefined
        : openOrg,
  };
  const image2Available =
    !demo && publicCfg?.featureImage2 === true && isCodexEngineModel(modelId ?? "");

  return (
    <MediaSignProvider
      sign={demo ? null : signMedia}
      authKey={user?.id ?? "anon"}
      onAnnotate={image2Available ? setImageAnnotationSource : undefined}
    >
    <ToolCardActionsContext.Provider value={toolActions}>
    <ChatInteractionContext.Provider value={chatInteraction}>
    {/* safe-px:横屏侧刘海安全区(竖屏为 0) */}
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-fg safe-px">
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

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          agent={agent}
          onAgentClick={() => setPickerOpen(true)}
          models={models}
          selectedModelId={modelId}
          onSelectModel={setModelId}
          modelsLoading={modelsLoading}
          // 团队模式知情指示:与 send 的生效条件同构(teamMode 只对 main 生效,
          // 见上方 send 的 agent.id === "main" 判定)——顶栏所见 = 实际所发。
          teamModeActive={!demo && teamMode && agent.id === "main"}
          onDisableTeamMode={() => setTeamMode(false)}
          credits={demo ? null : (user?.credits ?? null)}
          onOpenBilling={demo ? undefined : openSettings}
          sidebarCollapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNew={newSession}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenInbox={demo ? undefined : () => setInboxOpen(true)}
          unreadCount={inbox.unreadCount}
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

        <div ref={scrollRef} onScroll={onChatScroll} className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {gated ? (
            <AgentGate
              phase={gate.phase}
              onOpen={gate.open}
              onRetry={gate.check}
              onTopUp={openSettings}
            />
          ) : loadingHistory ? (
            // 冷会话历史拉取期：消息形骨架占位，避免「空白 → 突然填满」的突变。
            <MessageListSkeleton />
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
            // ResponseRatingProvider 下发逐条评价态：AssistantCard 内的评价卡作为 Context
            // 消费者，随 ratings 变更穿透 MessageRenderer 的 sig-memo 重渲（无需改渲染签名）。
            <ResponseRatingProvider value={ratingCtx}>
              <MessageList
                messages={wsMessages}
                sending={wsSending}
                turnActivity={turnActivity}
                transientNotice={transientNotice}
                archive={messageListArchive}
                cb={cardCallbacks}
                onRespondPermission={onRespondPermission}
              />
            </ResponseRatingProvider>
          )}
        </div>

        {/* composer-safe-b:底部 Home 指示条安全区(叠在原 pb-3 上),否则发送区被遮 */}
        <div className="shrink-0 composer-safe-b">
          {/* 任务列表 HUD:钉在输入框上方,始终可见(取代会滚走的 inline TodoWrite 卡)。
              初始展开全部 → ~3s 自动折叠成「正在执行的一条」;无任务时组件自渲染 null。 */}
          {!demo && !gated && <PinnedTaskTracker todos={extractLatestTodos(wsMessages)} active={wsSending} />}
          {!demo && gate.phase.kind === "dormant" && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone="info">容器已休眠，发送消息后将自动唤醒。</Alert>
            </div>
          )}
          {/* WS 连接状态条三态（离线 / 环境启动中 / 服务端重连中，见 deriveConnBanner）。仅非 demo。*/}
          {!gated && connBanner && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone={connBanner.tone}>{connBanner.text}</Alert>
            </div>
          )}
          {/* 版本更新横幅:仅 governor 判定不能自动软刷时出现(自动刷成功的用户无感)。*/}
          {!demo && <UpdateBanner />}
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
            disabled={gated}
            placeholder={`和「${agent.name}」对话…`}
            onUpload={demo ? undefined : uploadMedia}
            getVoiceToken={demo ? undefined : () => authRef.current.getToken()}
            prefill={composerPrefill}
            repoSelection={demo ? null : repo.selection}
            onOpenRepo={demo ? undefined : openRepo}
            onAnnotateImage={image2Available ? setImageAnnotationSource : undefined}
            image2UnavailableReason={
              image2Available
                ? undefined
                : publicCfg?.featureImage2 !== true
                  ? "Image 2 暂未开放或正在维护"
                  : "当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型"
            }
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

      {/* 仅在打开时挂载 → 懒块首屏零下载;Dialog 无 exit 动画(仅 data-[state=open]),
          即时卸载无视觉回退。tab 等状态由 App 持有或组件 open 时自 resync,卸载安全。*/}
      {settingsOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <SettingsCenter
            open={settingsOpen}
            auth={auth}
            user={user}
            theme={theme}
            demo={demo}
            onClose={() => setSettingsOpen(false)}
            onSetTheme={setTheme}
            onRefreshMe={refreshMe}
            onPreferencesChange={applyConversationPreferences}
          />
        </LazyBoundary>
      )}

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

      {manageOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ManageCenter
            open={manageOpen}
            tab={manageTab}
            auth={auth}
            agentId={agent.id}
            agents={myAgents}
            onTabChange={setManageTab}
            onClose={() => setManageOpen(false)}
          />
        </LazyBoundary>
      )}

      {marketplaceOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <MarketplaceCenter
            open={marketplaceOpen}
            tab={marketplaceTab}
            auth={auth}
            isAdmin={user?.role === "admin"}
            initialBrowseKind={marketplaceBrowseKind}
            onCreateInChat={(kind) => {
              setMarketplaceOpen(false);
              newSession();
              setComposerPrefill({ text: CHAT_CREATE_TEMPLATES[kind], nonce: Date.now() });
            }}
            onAskAiInChat={(text) => {
              // AI 导购入口(批3):与 onCreateInChat 同构——关市场 → 新会话 → 预填输入框。
              // text 已由 lib/marketplace 纯函数拼好(找并装好 / 在对话中试用);不 autoSend。
              setMarketplaceOpen(false);
              newSession();
              setComposerPrefill({ text, nonce: Date.now() });
            }}
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
        </LazyBoundary>
      )}

      {orgOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <OrgCenter
            open={orgOpen}
            auth={auth}
            user={user}
            onClose={() => setOrgOpen(false)}
            onRefreshMe={refreshMe}
          />
        </LazyBoundary>
      )}
      {confirmDialogEl}
      {promptTextEl}
      <ImageAnnotationEditor
        source={imageAnnotationSource}
        open={!!imageAnnotationSource}
        onOpenChange={(next) => !next && setImageAnnotationSource(null)}
        onSubmit={submitImageAnnotation}
      />
    </div>
    </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>
    </MediaSignProvider>
  );
}

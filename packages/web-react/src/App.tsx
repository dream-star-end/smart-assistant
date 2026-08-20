import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isCodexEngineModel,
  normalizeMessageReplyQuote,
  type MessageReplyQuote,
} from "@openclaude/protocol";
import { AgentGate } from "./components/AgentGate";
import { LazyBoundary } from "./components/ChunkErrorBoundary";
import { AgentPicker } from "./components/AgentPicker";
import { AuthGate, type AuthMode } from "./components/AuthGate";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import {
  ImageAnnotationEditor,
  type ImageAnnotationSource,
} from "./components/ImageAnnotationEditor";
import {
  type ImageCommentSubmit,
  type ImageEditActions,
  ImageEditActionsContext,
  type ImageEditSubmit,
} from "./components/chat/imageEditActions";
import { extractLatestTodos, PinnedTaskTracker } from "./components/chat/PinnedTaskTracker";
import { deriveActivePlanStep, type TurnActivityInfo } from "./components/chat/TurnActivity";
import { EmptyState } from "./components/EmptyState";
import { type ChatError, ErrorBanner } from "./components/ErrorBanner";
import { SessionTimelineBoundary } from "./components/SessionTimelineBoundary";
import { sessionHistorySurface } from "./lib/chat/historyLoadState";
import { UpdateBanner } from "./components/UpdateBanner";
import { GithubRepoModal } from "./components/github/GithubRepoModal";
import { RepoStatusBanner } from "./components/github/RepoStatusBanner";
import { InboxDialog } from "./components/InboxDialog";
import { PendingPaymentRecovery } from "./components/payment/PendingPaymentRecovery";
import { CHAT_CREATE_TEMPLATES } from "./lib/chatCreateTemplates";
import { sessionTitleFromText } from "./lib/sessionTitle";
// 分区注册表在 lib（不是 ManageCenter）：ManageCenter 是 lazy chunk，从组件里取值会把
// 六个面板一起拖进主包。默认落地页 = 注册表首位，两处不再各写各的。
import { DEFAULT_MANAGE_TAB, type ManageTab } from "./lib/manageTabs";
import type { SettingsSection } from "./components/SettingsCenter";
import type { OrgSection } from "./components/OrgCenter";
import type { MarketplaceKind, MarketplaceTab } from "./components/MarketplaceCenter";
import { AssistantMessage, UserMessage } from "./components/Message";
import { MessageList, type MessageListArchive } from "./components/MessageRenderer";
import { MessageListSkeleton, shouldShowHistorySkeleton } from "./components/chat/HistorySkeleton";
import { TurnCostReminder } from "./components/chat/TurnCostReminder";
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
  type VisibleVirtualRowAnchor,
} from "./components/chat/archivePaging";
import { turnFinalAssistantFlags } from "./components/chat/turnSegment";
import type { CardCallbacks, FeedbackContext } from "./components/chat/cards";
import { MessageFeedbackDialog } from "./components/chat/MessageFeedbackDialog";
import {
  type RatingEntry,
  type ResponseRatingCtx,
  ResponseRatingProvider,
} from "./components/chat/ResponseRating";
import { MediaSignProvider } from "./components/chat/media";
import { ChatInteractionContext, ToolCardActionsContext } from "./components/tool/context";
import { Sidebar } from "./components/Sidebar";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { Alert, Sheet, Spinner, useConfirm, usePrompt } from "./components/ui";
import { useAgentGate } from "./hooks/useAgentGate";
import {
  type BoardViewParam,
  type PanelParam,
  parseBoardView,
  parseBoardTicket,
  parseBoardTicketType,
  parsePanelParam,
  parseSessionPath,
  parseTutorialCase,
  parseTutorialTopic,
  useAppRoute,
} from "./hooks/useAppRoute";
import { useAuth } from "./hooks/useAuth";
import { genWsSessionId, useSessionList } from "./hooks/useSessionList";
import { useChatProjects } from "./hooks/useChatProjects";
import { useUnreadSessions } from "./hooks/useUnreadSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { type UseChatSocket, useChatSocket } from "./hooks/useChatSocket";
import { useInbox } from "./hooks/useInbox";
import { useOptimizerPending } from "./hooks/useOptimizerPending";
import { useRepoBinding } from "./hooks/useRepoBinding";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./components/ui";
import { githubErrorText } from "./lib/github";
import { connectorErrorText } from "./lib/connectors";
import { imageByteCache } from "./lib/chat/imageBytes";
import { containerPreviewHrefFromTarget } from "./lib/containerPreview";
import type { RepoBindErrorWire, RepoStatusWire } from "./lib/chat/frames";
import type { MediaJobWire } from "./lib/chat/frames";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import type { InboundMessage, MediaRef } from "./lib/chat/frames";
import type { ChatMessage } from "./lib/chat/model";
import {
  exactUserReplayPayload,
  interruptedContinuationTarget,
  preciseRetryEligible,
} from "./lib/chat/socket";
import {
  findRewriteTarget,
  findStopTarget,
  type ImplicitTarget,
  isExpensiveTurn,
} from "./lib/implicitFeedback";
import { CONTINUE_PROMPT } from "./lib/chat/render";
import { deriveLiveTerminalFromMessages } from "./lib/sessionStatus";
import { deriveConnBanner } from "./lib/chat/pure";
import { useDelayedConnBanner } from "./hooks/useDelayedConnBanner";
import { incidentStore } from "./lib/incidentStore";
import {
  clearTeamModeForSession,
  readTeamModeForSession,
  writeTeamMode,
} from "./lib/teamMode";
import {
  clearSessionEffort,
  readSessionEffort,
  writeSessionEffort,
} from "./lib/sessionEffort";
import { DEFAULT_AGENT, agentFromApiRow, type Agent } from "./lib/agents";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "./lib/productCapabilities";
import { resolveTutorialAction } from "./lib/tutorialActions";
import type { TutorialCase, TutorialCaseId } from "./lib/tutorialCaseCatalog";
import { api, apiErrorMessage } from "./lib/api";
import {
  effectiveEffortModelId,
  effortForModel,
  extractPrefs,
  type PreferenceEffort,
  type PrefsView,
  resolveSessionModel,
} from "./lib/modelPreferences";
import { DEMO_MESSAGES, DEMO_MODELS, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { ChatProject, Message, PublicConfig, PublicModel, Session, SessionLastOutcome, ToolCard } from "./lib/types";
import { modelSwitchCompactionReason } from "./lib/modelSwitch";

// 首屏瘦身:营销首页 + 设置/管理/市场/组织/教程中心按需异步加载,移出 entry chunk。
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
const TutorialCenter = lazy(() =>
  import("./components/TutorialCenter").then((m) => ({ default: m.TutorialCenter })),
);
const ContainerWebPreview = lazy(() =>
  import("./components/ContainerWebPreview").then((m) => ({ default: m.ContainerWebPreview })),
);
const MediaTaskCenter = lazy(() =>
  import("./components/MediaTaskCenter").then((m) => ({ default: m.MediaTaskCenter })),
);
const TaskboardView = lazy(() =>
  import("./components/taskboard/TaskboardView").then((m) => ({ default: m.TaskboardView })),
);

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取这些懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    void import("./components/Landing").catch(() => {});
    void import("./components/SettingsCenter").catch(() => {});
    void import("./components/ManageCenter").catch(() => {});
    void import("./components/MarketplaceCenter").catch(() => {});
    void import("./components/OrgCenter").catch(() => {});
    void import("./components/TutorialCenter").catch(() => {});
    void import("./components/MediaTaskCenter").catch(() => {});
    void import("./components/taskboard/TaskboardView").catch(() => {});
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

function replyQuoteText(message: ChatMessage): string {
  if (message.text.trim()) return message.text;
  const media = message._media ?? [];
  if (media.some((item) => item.kind === "image")) return media.length > 1 ? `[${media.length} 张图片]` : "[图片]";
  const first = media[0];
  if (first?.filename) return `[文件：${first.filename}]`;
  return media.length > 0 ? "[附件]" : "";
}

/** 隐式负反馈的成因标签（随 implicit down 一并上报，仅供后端归因，用户不可见）。 */
type ImplicitReason = "中途打断" | "改写重发";

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
  const bootTutorialCase = routingEnabled ? parseTutorialCase(params) : null;
  const bootTutorialTopic = routingEnabled && !bootTutorialCase
    ? parseTutorialTopic(params)
    : null;
  // 会话深链恢复未决标记：resolve 前 useSessionList 暂停"自动选中上次会话"
  // （URL 指定 > 最近会话）；resolve/放弃后置 null。
  const [pendingRouteSession, setPendingRouteSession] = useState<string | null>(() =>
    routingEnabled ? parseSessionPath(location.pathname) : null,
  );
  // 任务面板是并列工作区（整段替换 <main>），不是管理中心 Tab。boot 自 /board。
  const [boardOpen, setBoardOpen] = useState(
    () => routingEnabled && location.pathname === "/board",
  );
  const [boardView, setBoardView] = useState<BoardViewParam>(() =>
    routingEnabled ? parseBoardView(params) : "board",
  );
  const [boardTicketId, setBoardTicketId] = useState<string | null>(() =>
    routingEnabled ? parseBoardTicket(params) : null,
  );
  const [boardTicketType, setBoardTicketType] = useState(() =>
    routingEnabled ? parseBoardTicketType(params) : null,
  );
  // 视图态：home=营销首页,app=登录页/工作区。启动静默续期成功（useAuth onBootAuthed）
  // 直接置 app,失败停在 home。
  const [view, setView] = useState<"home" | "app">(resetToken ? "app" : "home");
  // AuthGate 初始模式：「登录」与「免费开始」入口均=login（登录页自带「立即注册」链接，
  // 新用户不受阻），重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme();

  // 公开配置（Turnstile bypass / site key）：登录页驱动 AuthGate 是否渲染真 widget。
  const [publicCfg, setPublicCfg] = useState<PublicConfig | null>(null);
  const [publicCfgRetryNonce, setPublicCfgRetryNonce] = useState(0);

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
  // 最近一次 preferences 快照(default_model 解析用):per-session 模型恢复的回落基准。
  // 写入点 = models 装载批 + SettingsCenter onPreferencesChange;下方 resolver effect 消费。
  const [modelPrefs, setModelPrefs] = useState<PrefsView>({});
  const [preferenceEffort, setPreferenceEffort] = useState<PreferenceEffort | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSwitchPreparing, setModelSwitchPreparing] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [imageAnnotationSource, setImageAnnotationSource] = useState<ImageAnnotationSource | null>(null);
  const [containerPreviewUrl, setContainerPreviewUrl] = useState<string | null>(null);
  // 面板深链：boot 读到 ?panel= 即以打开态初始化（工作区渲染后即呈现；未登录深链则
  // 登录后呈现）。打开/关闭经 useAppRoute 同步回 query。
  const [settingsOpen, setSettingsOpen] = useState(bootPanel === "settings");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [messageFeedback, setMessageFeedback] = useState<FeedbackContext | null>(null);
  const messageFeedbackTriggerRef = useRef<HTMLElement | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [mediaTasksOpen, setMediaTasksOpen] = useState(false);
  const [liveMediaJob, setLiveMediaJob] = useState<MediaGenerationJob | null>(null);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(bootPanel === "manage");
  const [manageTab, setManageTab] = useState<ManageTab>(DEFAULT_MANAGE_TAB);
  const [manageAutoAuthorizePluginSlug, setManageAutoAuthorizePluginSlug] = useState<
    string | null
  >(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(bootPanel === "market");
  const [orgOpen, setOrgOpen] = useState(bootPanel === "org");
  const [orgSection, setOrgSection] = useState<OrgSection>("overview");
  const [tutorialOpen, setTutorialOpen] = useState(bootPanel === "help");
  const [tutorialTopic, setTutorialTopic] = useState<ProductFeatureId | null>(bootTutorialTopic);
  const [tutorialCase, setTutorialCase] = useState<TutorialCaseId | null>(bootTutorialCase);
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>("browse");
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>("skill");
  // 「在对话中创建」技能/智能体:关市场 → 新会话 → Composer 预填引导模板(用户改后发送)。
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [messageReplyTarget, setMessageReplyTarget] = useState<{
    sessionId: string;
    quote: MessageReplyQuote;
  } | null>(null);
  // 归档「查看更早历史记录」按钮子态(加载中 / 失败可重试)。切会话时重置(见下)。
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [chatScrollParent, setChatScrollParent] = useState<HTMLDivElement | null>(null);
  const bindChatScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setChatScrollParent((current) => current === node ? current : node);
  }, []);
  // 归档前插视口锚点:只有对应请求已返回后才允许消费，避免期间其它内容增长冒领锚点。
  const archiveScrollAnchorRef = useRef<{
    token: number;
    capturedScrollTop: number;
    timelineGeneration: number | undefined;
    row: VisibleVirtualRowAnchor | null;
    ready: boolean;
    cancelled: boolean;
    restoring: boolean;
    settle: () => void;
  } | null>(null);
  const archiveRequestTokenRef = useRef(0);
  const settleArchiveAnchor = useCallback((token?: number) => {
    const anchor = archiveScrollAnchorRef.current;
    if (!anchor || (token !== undefined && anchor.token !== token)) return;
    archiveScrollAnchorRef.current = null;
    anchor.settle();
  }, []);
  const stopRef = useRef(false);
  // 稳定句柄：让早于 useChatSocket 声明的 send/regenerate 回调引用 WS 引擎，避免
  // “块级变量在声明前使用” 的 TDZ（hook 在下方调用后回填 sockRef.current）。
  const sockRef = useRef<UseChatSocket | null>(null);
  const toast = useToast();
  // 只有 userNoticeApproval 完整门禁后的 approved_recovery 才进入一次性 success toast。
  // 内部 incident 的 open/resolved 均由 store 静默忽略，不展示负面运维状态。
  useEffect(
    () =>
      incidentStore.onResolved((e) => {
        const msg = e.message?.trim() ? e.message : `${e.title}已恢复`;
        toast(msg, "success");
      }),
    [toast],
  );
  // Aurora 风格确认/输入对话框(Promise 式),取代原生 window.confirm/prompt。
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const [promptText, promptTextEl] = usePrompt();
  // GitHub 仓库绑定帧处理器的稳定间接：useChatSocket 在 useRepoBinding 之前声明，故经 ref
  // 透传（与 sockRef 同样的 TDZ 规避；handler 本身是 useRepoBinding 的稳定 useCallback）。
  const repoStatusHandlerRef = useRef<(f: RepoStatusWire) => void>(() => {});
  const repoBindErrorHandlerRef = useRef<(f: RepoBindErrorWire) => void>(() => {});
  // 隐式负反馈上报入口的稳定间接（与 sockRef 同款 TDZ 规避）：send/stopTurn 在
  // sendImplicitRating 声明之前就要引用它，故经 ref 回填；回调本体在下方 useCallback 定义。
  // 走 ref 而非直接入 deps → send/stopTurn 引用保持稳定（不被评价态/模型切换牵动重建）。
  const sendImplicitRatingRef = useRef<
    ((target: ImplicitTarget, opts: { reason: ImplicitReason }) => void) | null
  >(null);
  // 用户主动 Stop 的轮不做完成脉冲高亮：stopTurn 置位，sending 沿的 nudge effect 消费后清。
  const stoppedTurnRef = useRef(false);

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
    authRecoveryAvailable,
    retryBoot,
    clearAuth,
    booting,
    laneReady,
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
    // auth 清空（静默刷新失败或主动登出）→ 清会话/消息/私有面板态,回首页。
    // help 是公开内容：若 URL 明确携带案例/功能深链，静默续期发现未登录时仍应保留。
    onClearAuth: () => {
      // signPath 只在单一租户内唯一；鉴权身份退出/过期时必须丢弃内存图片字节，避免
      // 同一 SPA 随后登录另一账号后以相同容器路径命中上一账号的 Blob。
      imageByteCache.clear();
      localStore.current.clear();
      sessionsResetRef.current(); // 清列表/选中/已拉历史标记,允许下次登录重新自动选中
      setMessages([]);
      setChatError(null);
      setContainerPreviewUrl(null);
      setSettingsOpen(false);
      setMediaTasksOpen(false);
      setLiveMediaJob(null);
      setManageAutoAuthorizePluginSlug(null);
      setOrgOpen(false);
      const publicQuery = new URLSearchParams(location.search);
      const keepPublicTutorial = routingEnabled && parsePanelParam(publicQuery) === "help";
      setTutorialOpen(keepPublicTutorial);
      setTutorialCase(keepPublicTutorial ? parseTutorialCase(publicQuery) : null);
      setTutorialTopic(keepPublicTutorial ? parseTutorialTopic(publicQuery) : null);
      setView("home");
    },
    // 登出前清本 user 的 IndexedDB 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效）。
    onLogout: () => void sockRef.current?.wipePersistence(),
    // 启动静默续期成功 → 直接恢复工作区。
    onBootAuthed: () => {
      imageByteCache.clear();
      setView("app");
    },
    // 登录成功不预载会话：由 useChatSocket IndexedDB 注水（onHydrated）+ listSessions
    // 合并 server canonical 列表填侧栏；selectSession 再按需拉取单会话历史。
    onLoginSuccess: () => {
      imageByteCache.clear();
      sessionsResetRef.current();
      setMessages([]);
    },
  });

  // AuthSession 整个生命周期是同一引用；token + epoch 在对象内部原子推进。
  // 经本地 useRef 再持有一次以保留 biome 的稳定 ref 推断 —— 直接使用 hook 返回的 ref 会在
  // 多处 useCallback/useEffect 误报 useExhaustiveDependencies（lint 只认本地 useRef 为稳定）。
  const authRef = useRef(authSessionRef.current);

  // Assistant/tool markdown often exposes a dev-server URL such as
  // http://localhost:3000. That address belongs to the user's container, not
  // the viewer's phone or PC. Capture only explicit, validated loopback links
  // and route them into the authenticated isolated-Chromium preview.
  useEffect(() => {
    if (demo || !authed) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const previewUrl = containerPreviewHrefFromTarget(event.target);
      if (!previewUrl) return;
      event.preventDefault();
      event.stopPropagation();
      setContainerPreviewUrl(previewUrl);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [authed, demo]);

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
    queueModelPatch,
    onHydrated,
    renameSessionPrompt,
    deleteSessionConfirm,
    togglePinSession,
    moveSessionToProject,
    toggleArchiveSession,
    batchUpdateSessions,
    loadMoreSessions,
    hasMoreSessions,
    loadingMoreSessions,
    loadArchivedSessions,
    loadingArchived,
    searchSessionMessages,
    applySessionTerminal,
    reset: resetSessionList,
    serverListSettled,
    historyLoading,
    historyError,
    retryHistory,
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
      setPendingRouteSession(null);
    },
    onDeleteSession: (id) => {
      localStore.current.delete(id);
      clearTeamModeForSession(id); // 顺手清该会话的团队模式 per-session 键(不留孤儿键)
      clearSessionEffort(id); // 同上:思考档位 per-session 键
    },
    onActiveSessionDeleted: () => {
      setMessages([]);
      setChatError(null);
    },
    // URL 深链恢复未决：暂停自动选中（URL 指定 > 最近会话）。
    holdAutoSelect: pendingRouteSession !== null,
  });

  const {
    projects,
    collapsedIds: collapsedProjectIds,
    toggleCollapsed: toggleProjectCollapsed,
    createProjectPrompt,
    renameProjectPrompt,
    deleteProjectConfirm,
    updateProject,
    reorderProjects,
  } = useChatProjects({
    demo,
    auth,
    authSession: authRef.current,
    userId: user?.id,
    promptText,
    confirmDialog,
    onUngroupProjectSessions: (projectId) => {
      let moved: string[] = [];
      setSessions((c) => {
        moved = c.filter((s) => s.projectId === projectId).map((s) => s.id);
        return c.map((s) => (s.projectId === projectId ? { ...s, projectId: null } : s));
      });
      return moved;
    },
    onRestoreProjectSessions: (projectId, sessionIds) => {
      const ids = new Set(sessionIds);
      setSessions((c) => c.map((s) => (ids.has(s.id) ? { ...s, projectId } : s)));
    },
  });

  const unreadSessions = useUnreadSessions({
    sessions,
    activeId: activeId ?? null,
    userId: user?.id ?? null,
  });
  const sidebarWidth = useSidebarWidth();
  const [projectSettings, setProjectSettings] = useState<ChatProject | null>(null);

  // ── per-session 模型选择(会话间互不影响,持久化恢复)────────────────────────
  //
  // 选择器的值 = 活动会话的有效模型:会话自己的持久化选择优先(须仍可见且健康,
  // 否则回落),其次 default_model 偏好,再回落首个健康模型(resolveSessionModel)。
  // 数据流:侧栏 Session.modelId(IndexedDB 注水 + listSessions server-wins + 选择写通)
  // 是本 effect 的读源;显式选择经 selectModel 写通三持有方(侧栏 + WS service/IndexedDB +
  // 服务端 PATCH,与 rename 同款收口)。空会话态(无 activeId)解析结果 = 纯默认,作为
  // "下一个新会话"的初始意图;空态显式选择只改 modelId state,不进本 effect 依赖,不被覆盖。
  const activeSessionModelId =
    !demo && activeId ? sessions.find((s) => s.id === activeId)?.modelId : undefined;
  useEffect(() => {
    // 活动会话解析:切会话/会话模型到达(注水·listSessions·detail 回填)/偏好变更时恢复。
    // activeId 必须进依赖:A(有模型)→B(无模型)切换时 activeSessionModelId 可能不变,
    // 仅 activeId 变,不重跑就会把 A 的模型粘给 B。
    if (demo || models.length === 0 || !activeId) return;
    setModelId(resolveSessionModel(models, activeSessionModelId, modelPrefs));
  }, [demo, models, activeId, activeSessionModelId, modelPrefs]);
  useEffect(() => {
    // 空会话态默认:boot 初值与 default_model 变更传导(= 下一个新会话的初始意图)。
    // 空态的显式选择(selectModel 只 setModelId)不改本 effect 依赖,不会被覆盖。
    if (demo || models.length === 0 || activeId !== undefined) return;
    setModelId(resolveSessionModel(models, undefined, modelPrefs));
  }, [demo, models, activeId, modelPrefs]);

  // 显式选择模型:活动会话存在则写通三持有方(服务端经 queueModelPatch:选择即挂 pending
  // 意图压制一切在途旧载荷 + 单飞串行合并 PATCH,同时消掉「旧响应迟到盖回」与「连选
  // PATCH 倒序落库」两类竞态)。失败契约:服务端存有**旧值**时下次 listSessions
  // server-wins 盖回,重选即重试;服务端从未有值(NULL=从未显式选择,无"清除"流)则缺席
  // 不表态,本地意图保留 —— 两种失败面都可自愈。新会话行未建 404 同吞,由建行 PUT/建行后
  // 收敛 PATCH 落地。无活动会话(空会话态)仅更新选择器,作为下一会话意图。
  const activeModelSwitchSessionRef = useRef(activeId);
  activeModelSwitchSessionRef.current = activeId;
  const selectModel = useCallback(
    async (id: string) => {
      if (id === modelId || modelSwitchPreparing) return;
      const sid = activeId;
      const commit = (modelSwitchId?: string) => {
        if (activeModelSwitchSessionRef.current === sid) setModelId(id);
        if (demo) return;
        if (!sid) return;
        setSessions((c) => c.map((s) => (s.id === sid ? { ...s, modelId: id } : s)));
        sockRef.current?.setSessionModel(sid, id, modelSwitchId);
        queueModelPatch(sid, id);
      };
      if (demo || !activeId) {
        commit();
        return;
      }
      const currentMessages = sockRef.current?.getMessages(activeId) ?? [];
      const hasContent = (sessions.find((session) => session.id === activeId)?.messageCount ?? 0) > 0 ||
        currentMessages.some((message) =>
          message.role === "user" || message.role === "assistant" ||
          message.role === "tool" || message.role === "agent-group");
      const reason = modelSwitchCompactionReason(models, modelId, id, hasContent);
      if (!reason || !modelId) {
        commit();
        return;
      }
      const details = [
        reason.visionDowngrade
          ? "目标模型不支持当前会话的多模态上下文，图片等内容将转换为文字交接。"
          : null,
        reason.contextDowngrade
          ? "目标模型的上下文窗口更短，需要先压缩当前会话。"
          : null,
      ].filter((detail): detail is string => detail !== null);
      const confirmed = await confirmDialog({
        title: "压缩上下文后切换模型？",
        body: <div className="space-y-2 text-sm text-muted">
          {details.map((detail) => <p key={detail}>{detail}</p>)}
          <p>系统会使用当前模型的原生压缩能力生成交接内容；原始会话记录不会删除。</p>
        </div>,
        confirmText: "压缩并切换",
      });
      if (!confirmed) return;
      setModelSwitchPreparing(true);
      try {
        const switchId = await sockRef.current?.prepareModelSwitch(activeId, modelId, id);
        if (!switchId) throw new Error("模型切换准备失败");
        commit(switchId);
      } catch (error) {
        toast(error instanceof Error ? error.message : "上下文压缩失败，仍保留原模型", "error");
      } finally {
        setModelSwitchPreparing(false);
      }
    },
    [demo, activeId, modelId, modelSwitchPreparing, models, sessions, setSessions, queueModelPatch, confirmDialog, toast],
  );
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

  // 思考档位的会话级记忆(语义见 lib/sessionEffort):undefined = 未选择(继承
  // preferences.default_effort);null = 显式跟随模型默认;档位 = 显式选择。
  // 与 teamMode 同款 per-session 键;首条消息创建会话后同样落地当前 intent。
  const [sessionEffort, setSessionEffortState] = useState<PreferenceEffort | null | undefined>(() =>
    readSessionEffort(activeId),
  );
  const setSessionEffort = useCallback(
    (value: PreferenceEffort | null) => {
      setSessionEffortState(value);
      writeSessionEffort(activeId, value);
    },
    [activeId],
  );
  useEffect(() => {
    setSessionEffortState(readSessionEffort(activeId));
  }, [activeId]);

  const send = useCallback(
    async (
      text: string,
      media?: MediaRef[],
      imageEdit?: InboundMessage["content"]["imageEdit"],
      displayText?: string,
      replyTo?: MessageReplyQuote,
    ) => {
      setChatError(null);
      const visibleText = displayText ?? text;
      const sessionTitle = sessionTitleFromText(visibleText);

      // demo：本地流式回放（无网络），仅用于离线预览设计。
      if (demo) {
        const userMsg: Message = {
          id: `tmp-${Date.now()}`,
          role: "user",
          content: visibleText,
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
      // 隐式负反馈（改写重发）：发送前用**当前会话**的现有消息判定「5min 内高相似改写」——
      // 命中即对被改写轮的末条 assistant 静默记 implicit down（空会话无历史 → 命中不了）。
      // 现场取消息（sockRef.current === chat，稳定句柄）而非捕获每帧刷新的 wsMessages。
      {
        const rewriteTarget = findRewriteTarget(
          sockRef.current?.getMessages(activeId) ?? [],
          visibleText,
          Date.now(),
        );
        if (rewriteTarget) sendImplicitRatingRef.current?.(rewriteTarget, { reason: "改写重发" });
      }
      // 非 demo：经真实 WS 引擎发送（inbound.message）。确保有会话承载本轮（peer.id）。
      let sessionId = activeId;
      let createdSession: Session | null = null;
      if (!sessionId) {
        sessionId = genWsSessionId();
        createdSession = {
          id: sessionId,
          title: sessionTitle,
          ownerUserId: user.id,
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          // 首发定格会话模型:当前有效模型(含空态显式选择)落为该会话的 per-session 选择,
          // 之后 default_model 变更/其它会话换模都不影响它(与 teamMode 的会话级落地同理)。
          ...(modelId ? { modelId } : {}),
        };
        setSessions((c) => [createdSession!, ...c]);
        setActiveId(sessionId);
        // 空会话态用户可能已在全能助手卡上开/关了团队模式;把当前 intent 落地为新会话的
        // per-session 键 —— 否则该会话只靠全局默认,会被其它会话的开关翻动(切走再回来变样)。
        writeTeamMode(sessionId, teamMode);
        // 显式档位选择存在才落地(未选择 = 继续继承全局偏好,不写键)。
        if (sessionEffort !== undefined) writeSessionEffort(sessionId, sessionEffort);
      }
      const materializedDraft =
        !createdSession && sessions.some((session) => session.id === sessionId && session.messageCount === 0);
      sockRef.current?.ensureSession(sessionId, agent.id, sessionTitle);
      if (materializedDraft) {
        // Goal/GitHub 可在首条消息前物化服务端行。首发时须同步收敛真正标题；否则
        // 后端幂等 INSERT 不更新既有行，刷新后 listSessions 会把「新对话」盖回来。
        sockRef.current?.renameSession(sessionId, sessionTitle);
        void api.patchSessionTitle(authRef.current, sessionId, sessionTitle).catch(() => {
          // 行尚未建时 PATCH 可 404；随后 send 的幂等 PUT 会使用上面已更新的 socket 标题。
        });
      }
      // model / effortLevel 都是 inbound.message 顶层路由字段。用户未设置 effort 或
      // 当前模型不支持时省略(null=显式清除回模型默认),让模型沿用自身默认。
      // effort 来源:本会话显式选择(sessionEffort,聊天头档位选择器)优先,缺省回落
      // 用户全局偏好(preferences.default_effort);effortForModel 负责按当前执行模型
      // 的支持集过滤(不支持 → null 发送,不硬塞)。
      // media：已上传附件（图片/文件等），随 inbound.message.content.media 发送。
      // teamMode 只对 main 队长生效(其它 agent 无委派语义),故非 main 恒 false。
      const teamLeaderTurn = agent.id === "main" && teamMode;
      sockRef.current?.send({
        sessId: sessionId,
        agentId: agent.id,
        text,
        ...(displayText !== undefined && displayText !== text ? { displayText } : {}),
        model: modelId,
        effortLevel: effortForModel(
          models,
          effectiveEffortModelId(modelId, teamLeaderTurn),
          sessionEffort !== undefined ? sessionEffort : preferenceEffort,
        ),
        media,
        imageEdit,
        replyTo,
        teamMode: teamLeaderTurn,
      });
      // 侧栏：提到顶 + 更新标题/时间/计数（计数仅作排序提示，权威消息在 WS service）。
      setSessions((c) => {
        const sid = sessionId!;
        const found = c.find((s) => s.id === sid);
        const base: Session =
          found ?? createdSession ?? { id: sid, title: sessionTitle, ownerUserId: user.id, updatedAt: "", messageCount: 0 };
        const updated: Session = {
          ...base,
          id: sid,
          title: found?.title && found.messageCount > 0 ? found.title : sessionTitle,
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
      sessionEffort,
      teamMode,
      sessions,
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
    // 乐观本地渲染:上传时 File 字节在手,建 blob URL 让气泡先渲(消除服务端回显/签名前的裂图
    // 窗口)。仅可预览媒体(image/video/audio)需要;file 走下载卡无预览。localSrc 仅本机 UI:
    // socket.sendMessage 出站帧 + 跨设备持久化 + toStored(IndexedDB)都显式剥离,刷新即回落签名管线。
    const localSrc =
      kind !== "file" ? URL.createObjectURL(file) : undefined;
    return {
      kind,
      url: r.url,
      mimeType: mime || undefined,
      filename: file.name,
      ...(localSrc ? { localSrc } : {}),
    };
  }, []);

  // 统一图片编辑提交 handler（需求 B/§5）：编辑/评论/调整大小三态联合 → 进主对话生成。
  // 复用 send()→乐观 user 行 + 生成占位卡（socket 注入）。持久化天然满足（guide 非 hidden、
  // 结果走 recordExternalTurn）。ImageAnnotationEditor.onSubmit（无 mode 的 ImageAnnotationExport）
  // 天然落 annotated 分支，向后兼容。
  const submitImageEdit = useCallback(
    async (value: ImageEditSubmit) => {
      if (value.mode === "resize") {
        // 调整大小（outpaint）：源图（hidden）+ guide（可见），无 mask；带目标比例 targetAspect。
        const [sourceMedia, guideMedia] = await Promise.all([
          uploadMedia(value.source),
          uploadMedia(value.guide),
        ]);
        const media: MediaRef[] = [{ ...sourceMedia, hidden: true }, guideMedia];
        await send(value.prompt, media, {
          mode: "outpaint",
          targetAspect: value.targetAspect,
          clientJobId: value.clientJobId,
          sourceIndex: 0,
          guideIndex: 1,
          width: value.width,
          height: value.height,
        });
        toast("已提交调整大小，成功生成后扣 50 积分", "success");
        return;
      }
      // 编辑/评论（annotated）：源图 + mask（均 hidden）+ guide 三件套（既有链路，逐字保留）。
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
        mode: "annotated",
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

  // 评论模式提交（ChatGPT 同款「模型驱动精确修改」）：不再合成 mask/guide,而是一条**普通对话
  // 消息** —— media=[原图(可见)] + text=固定前导 + 每锚点百分比坐标行。原图能复用持久
  // /api/media 引用就直接复用(reuseUrl),否则用 ImageCommentMode 取到的字节(sourceFile)上传
  // 一次。由 GPT 看图+坐标调它自己的原生 imagegen 完成精确修改。
  const submitImageComment = useCallback(
    async (value: ImageCommentSubmit) => {
      const ref: MediaRef = value.reuseUrl
        ? { kind: "image", url: value.reuseUrl }
        : await uploadMedia(value.sourceFile as File);
      await send(value.text, [ref]);
      toast("已提交标注修改，模型将按坐标精确修改", "success");
    },
    [send, uploadMedia, toast],
  );

  // 图片编辑可用性(image2 门控):image2 特性开放 + 当前模型是 GPT 引擎时才可编辑。
  // **单一权威**:注入 submitImageEdit / annotate 与否即"可否编辑"的唯一判定,聊天缩略图
  // 「编辑」浮钮、全屏查看器动作、composer 附件编辑按钮全部据此显隐/禁用。
  // 可编辑判定的**确定性**收口(image r4 §5b):publicCfg / modelId 都是刷新后 async 加载,
  // 若「未知即不可编辑」,编辑入口会在加载完成的一瞬从无到有——刷新后「编辑按钮时有时无」
  // 的抖动根因。改为:**加载未知期乐观视为可用**(不闪),仅在**确定**关闭时才收起——
  //   · featureOff  = publicCfg 已到且 featureImage2 !== true(平台维护/未开放)
  //   · modelKnownUnsupported = modelId 已到且非 GPT 引擎模型
  // 真实提交仍受下游 image2 门控兜底;错判窗口仅存在于首帧加载的数百 ms,且只影响罕见的
  // 非 GPT 会话(GPT 会话——商业版绝大多数——从首帧起即稳定显示,消除 boss 复现的闪烁)。
  const image2FeatureOff = publicCfg != null && publicCfg.featureImage2 !== true;
  const modelKnownUnsupported = !!modelId && !isCodexEngineModel(modelId);
  const image2Available = !demo && !image2FeatureOff && !modelKnownUnsupported;
  const image2UnavailableReason = image2Available
    ? undefined
    : image2FeatureOff
      ? "Image 2 暂未开放或正在维护"
      : "当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型";
  const imageEditActions = useMemo<ImageEditActions>(
    () => ({
      submitImageEdit: image2Available ? submitImageEdit : undefined,
      submitImageComment: image2Available ? submitImageComment : undefined,
      annotate: image2Available ? setImageAnnotationSource : undefined,
      annotateUnavailableReason: image2UnavailableReason,
    }),
    [image2Available, submitImageEdit, submitImageComment, image2UnavailableReason],
  );

  // 会话物化:新建按钮本身只进入空白草稿态；GitHub 绑定 / 设定目标这类明确依赖
  // per-session 身份的首轮前操作，才在用户确认操作时物化一个会话 id。
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
      ...(modelId ? { modelId } : {}),
    };
    // 首轮前操作会紧接着 ensureServerSession/sendRepoBind；先把空白态显式模型写入
    // ChatSession，确保建行 PUT 与后续首发都携带同一选择，不被 activeId effect 回落默认值。
    sockRef.current?.ensureSession(id, agent.id, "新对话");
    if (modelId) sockRef.current?.setSessionModel(id, modelId);
    setSessions((c) => [s, ...c]);
    setActiveId(id);
    return id;
  }, [demo, user, activeId, agent.id, modelId, setSessions, setActiveId]);

  // 打开 GitHub 绑定 modal:先确保有承载会话,否则「确认绑定」因 !sessionId 恒禁用
  // (输入框底部入口 → 发消息前即可绑定)。
  const openRepo = useCallback(() => {
    ensureActiveSession();
    setRepoModalOpen(true);
  }, [ensureActiveSession]);

  /** Resolve a lazy user locator to its immutable persisted row for one
   * action. The hydrated object stays on the stack; it is never merged into
   * ChatSocket/IndexedDB, so even a huge prompt does not bloat hot history. */
  const loadExactUserMessage = useCallback(
    async (message: ChatMessage): Promise<ChatMessage | null> => {
      if (message._userPayloadDeferred !== true) return message;
      if (!activeId) return null;
      const payloadId = message._userPayloadId ?? message.id;
      const records = await sockRef.current?.fetchUserMessagePayload(activeId, payloadId, {
        recordId: payloadId,
        role: "user",
        ...(message._payloadSha256 ? { contentSha256: message._payloadSha256 } : {}),
      });
      const exact = records?.find((record) => record.id === payloadId && record.role === "user");
      if (!exact) return null;
      return {
        ...exact,
        // Actions target the current logical/dispatch row while payload reads
        // continue using the immutable sidecar id above.
        id: message.id,
        _userPayloadId: payloadId,
        status: message.status ?? exact.status,
        _routing: exact._routing ?? message._routing,
        _sendAttempt: message._sendAttempt ?? exact._sendAttempt,
      };
    },
    [activeId],
  );

  const regenerate = useCallback(async () => {
    // demo 用本地 messages；非 demo 找 WS 末条 user 重发。
    if (demo) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          await send(messages[i].content ?? "");
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
        const exact = await loadExactUserMessage(m);
        if (!exact) {
          toast("原始消息加载失败，请重试", "error");
          return;
        }
        const replay = exactUserReplayPayload(exact);
        await send(replay.text, replay.media, replay.imageEdit, replay.displayText);
        return;
      }
    }
  }, [demo, messages, activeId, send, loadExactUserMessage, toast]);

  // 打开设置中心并顺带刷新余额（顶栏 pill / 侧栏 / AgentGate 充值入口统一走此）。
  const openSettings = useCallback((section: SettingsSection = "account") => {
    void refreshMe();
    setSettingsSection(section);
    setSettingsOpen(true);
  }, [refreshMe]);

  const applyConversationPreferences = useCallback(
    (prefs: PrefsView, _patch?: Record<string, unknown>) => {
      setPreferenceEffort(prefs.default_effort);
      // default_model 变更经 modelPrefs → resolver effect 传导:只影响「无自有持久化选择」
      // 的会话与空会话态;已显式选过模型的会话保持自身选择(per-session 隔离语义)。
      setModelPrefs(prefs);
    },
    [],
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
  const openOrg = useCallback((section: OrgSection = "overview") => {
    void refreshMe();
    setOrgSection(section);
    setOrgOpen(true);
  }, [refreshMe]);

  const openTutorial = useCallback((id?: ProductFeatureId) => {
    // 教程是单一顶层中心：打开前收起其他中心，避免多层 Radix Dialog 叠加与焦点陷阱互抢。
    setSettingsOpen(false);
    setManageOpen(false);
    setMarketplaceOpen(false);
    setOrgOpen(false);
    setTutorialTopic(id ?? null);
    setTutorialCase(null);
    setTutorialOpen(true);
  }, []);

  // 键盘快捷键：⌘/Ctrl+K 新会话；Esc 停止当前（demo）流式。仅在进入工作区后生效。
  const inWorkspace = demo || (view === "app" && !!auth && !!user);
  const settingsFeedbackContext = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && message.traceId) {
        return { sessionId: activeId ?? null, requestId: message.traceId };
      }
    }
    return { sessionId: activeId ?? null, requestId: null };
  }, [activeId, messages]);

  const tutorialActionContext = useMemo(
    () => ({
      authenticated: inWorkspace,
      featureImage2: image2Available,
      microphone:
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined",
      orgRole: user?.org?.role ?? null,
    }),
    [inWorkspace, image2Available, user?.org?.role],
  );

  const focusProductFeature = useCallback((id: string) => {
    const focus = (attempt = 0) => {
      // 若用户已在等待期间主动聚焦别处，不再抢焦点；只有 body/目标本身才允许重试。
      const active = document.activeElement as HTMLElement | null;
      if (
        attempt > 0 &&
        active &&
        active !== document.body &&
        active.dataset.productFeature !== id
      ) {
        return;
      }
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-product-feature="${id}"]`),
      );
      const target = candidates.find((element) => element.getClientRects().length > 0);
      target?.focus({ preventScroll: false });
      // Radix Dialog 的 inert/focus-scope 清理可能跨帧完成；首次 focus 被浏览器拒绝时小步重试。
      if (target && document.activeElement !== target && attempt < 3) {
        window.setTimeout(() => focus(attempt + 1), 160);
        return;
      }
      target?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };
    // Dialog 卸载后的 Radix 焦点恢复会晚于当前 click 栈；等关闭过渡/门户清理完成再把焦点
    // 交给真实功能，否则最终会落回 <body>，视觉上“跳过去了”但键盘用户没有抵达。
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(() => focus(), 120)));
  }, []);

  const runTutorialAction = useCallback(
    (feature: ProductCapability) => {
      const resolved = resolveTutorialAction(feature, tutorialActionContext);
      if (!resolved.enabled) return;
      setTutorialOpen(false);
      const destination = feature.destination;
      switch (destination.kind) {
        case "new-chat":
          newSession();
          focusProductFeature(PRODUCT_CAPABILITIES.chatBasics.id);
          break;
        case "focus":
          if (destination.target === PRODUCT_CAPABILITIES.sessions.id) {
            if (window.matchMedia("(max-width: 767px)").matches) setMobileNavOpen(true);
            else setCollapsed(false);
          }
          focusProductFeature(destination.target);
          break;
        case "agent-picker":
          setPickerOpen(true);
          break;
        case "settings":
          openSettings(destination.section);
          break;
        case "manage":
          openManage(destination.tab);
          break;
        case "market":
          openMarketplace(destination.tab, destination.marketKind ?? "skill");
          break;
        case "inbox":
          setInboxOpen(true);
          break;
        case "github":
          openRepo();
          break;
        case "org":
          openOrg(destination.section);
          break;
      }
    },
    [
      tutorialActionContext,
      newSession,
      focusProductFeature,
      openSettings,
      openManage,
      openMarketplace,
      openRepo,
      openOrg,
    ],
  );

  const runTutorialCase = useCallback(
    (item: TutorialCase) => {
      setTutorialOpen(false);
      if (!inWorkspace) {
        setAuthMode("login");
        setView("app");
        return;
      }
      newSession();
      setComposerPrefill({ text: item.starterPrompt, nonce: Date.now() });
    },
    [inWorkspace, newSession],
  );

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
    // 应用连接器 BYOA OAuth 回调（照 github_linked 模式）：/?connector_linked=<provider> 或
    // /?connector_error=<code>（错误码经 connectorErrorText 映射中文，不裸露码）。
    if (sp.has("connector_linked")) {
      // 用户向名词全链路统一为「插件」（市场品类 / 管理中心 Tab / 本 toast 同名）。
      toast("插件已连接", "success");
      setManageTab("connectors");
      setManageOpen(true);
      sp.delete("connector_linked");
      touched = true;
    }
    if (sp.has("connector_error")) {
      toast(`插件连接失败：${connectorErrorText(sp.get("connector_error"))}`, "error");
      sp.delete("connector_error");
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
        toast(apiErrorMessage(e, "接受组织邀请失败"), "error");
      }
    })();
  }, [demo, inWorkspace, auth, user, confirmDialog, refreshMe, toast]);

  // 进入登录页（view=app 且未认证）时拉公开配置：决定 AuthGate 是否渲染真 Turnstile
  // widget。短暂失败自动重试；停在首页（home）/demo/已登录均不拉。
  useEffect(() => {
    if (demo || authed || view !== "app") return;
    void publicCfgRetryNonce;
    let cancelled = false;
    let retryTimer: number | undefined;
    api
      .getPublicConfig()
      .then((c) => {
        if (!cancelled) {
          setPublicCfg(c);
        }
      })
      .catch(() => {
        if (!cancelled) {
          /* 拿不到 config：publicCfg 维持 null → AuthGate fail-closed（bypass 未知时点击只
           * 登记 intent，绝不发占位 token）。短暂失败自动恢复，不形成永久灰锁。 */
          retryTimer = window.setTimeout(() => setPublicCfgRetryNonce((n) => n + 1), 1000);
        }
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [demo, authed, view, publicCfgRetryNonce]);

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
        // 初始 modelId 不在此直接写:models/modelPrefs 落定会触发 per-session resolver
        // effect,按「活动会话持久化选择 > default_model > 首个健康模型」统一解析。
        setModelPrefs(prefs);
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

  const fetchMyAgents = useCallback(async (): Promise<Agent[]> => {
    if (demo || !auth) return [DEFAULT_AGENT];
    const rows = await api.listMyAgents(authRef.current);
    return rows.map(agentFromApiRow);
  }, [demo, auth]);

  const refreshMyAgents = useCallback(async (): Promise<Agent[]> => {
    const rows = await fetchMyAgents();
    setMyAgents(rows);
    return rows;
  }, [fetchMyAgents]);

  // 已装智能体目录:登录后拉一次(会话 agent 归属解析用;失败留默认,解析回落 stub 不阻断)。
  useEffect(() => {
    if (demo || !auth) return;
    let cancelled = false;
    fetchMyAgents()
      .then((rows) => {
        if (!cancelled) setMyAgents(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [demo, auth, fetchMyAgents]);

  // 对话前置态机：检查订阅/容器、引导开通、轮询容器至就绪。gate.access=false 时由
  // AgentGate 面板占据对话区并禁用 Composer；gate.ready 是 P4 useChatSocket 连接的硬前置。
  const gate = useAgentGate(auth, inWorkspace && !demo);

  // Auto‑Dream 待确认建议数：同一份计数同时驱动侧栏入口信号与管理中心「优化」Tab 徽标。
  // 挂 gate.ready 是硬要求 —— 该 GET 经容器代理，容器没起时恒 503。
  const optimizer = useOptimizerPending(auth, agent.id, inWorkspace && !demo && gate.ready);

  // P4 真实 WS 对话引擎。gate.ready（容器 running）是连接硬前置；refreshMe 供
  // cost_charged / 余额不足时刷新顶栏余额。demo 不连真实 WS。
  const chat = useChatSocket({
    auth,
    ready: gate.ready,
    // cohort lane 就绪（P3 RFC D1）：与 gate.ready 正交的 WS 连接前置，防首连落错 slot。
    laneReady,
    enabled: inWorkspace && !demo,
    defaultAgentId: "main",
    refreshBalance: refreshMe,
    refreshInbox: inbox.refreshUnread,
    // 持久按 user 命名空间（隐私隔离）；onHydrated 把 IndexedDB 本地会话填进侧栏。
    userId: demo ? null : (user?.id ?? null),
    onHydrated,
    // GitHub 仓库绑定状态/错误帧 → useRepoBinding（经 ref，见 repoStatusHandlerRef）。
    onRepoStatus: (f) => repoStatusHandlerRef.current(f),
    onRepoBindError: (f) => repoBindErrorHandlerRef.current(f),
    onMediaJob: (frame: MediaJobWire) => setLiveMediaJob(frame.job),
    // 会话模型收敛写与显式选择共用同一 per-session 串行器(防跨写者乱序)。
    queueModelPatch,
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
        : (myAgents.find((a) => a.id === activeSessAgentId && a.ready !== false) ?? DEFAULT_AGENT);
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

  const sendingIdsRef = useRef(new Set<string>());
  const liveTerminalsRef = useRef(
    new Map<string, { lastOutcome: SessionLastOutcome; lastErrorCode: string | null }>(),
  );
  const liveTerminals = useMemo(() => {
    void chat.version;
    if (demo) return liveTerminalsRef.current;
    const now = new Set(sessions.filter((s) => chat.isSending(s.id)).map((s) => s.id));
    for (const id of now) liveTerminalsRef.current.delete(id);
    for (const id of sendingIdsRef.current) {
      if (!now.has(id)) {
        const t = deriveLiveTerminalFromMessages(chat.getSession(id)?.messages);
        if (t) liveTerminalsRef.current.set(id, t);
      }
    }
    sendingIdsRef.current = now;
    return new Map(liveTerminalsRef.current);
  }, [demo, chat, sessions]);
  useEffect(() => {
    for (const [id, t] of liveTerminals) applySessionTerminal(id, t);
  }, [liveTerminals, applySessionTerminal]);

  const liveTerminal = useCallback(
    (id: string) => liveTerminals.get(id),
    [liveTerminals],
  );

  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "k" || e.key === "K") {
        if (e.shiftKey || isEditable(e.target)) return;
        e.preventDefault();
        setCollapsed(false);
        setMobileNavOpen(true);
        window.setTimeout(() => {
          const nodes = [...document.querySelectorAll<HTMLInputElement>("[data-sidebar-search]")];
          const visible = nodes.find((el) => el.getClientRects().length > 0) ?? nodes[0];
          visible?.focus();
        }, 0);
        return;
      }
      if ((e.key === "o" || e.key === "O") && e.shiftKey) {
        if (isEditable(e.target)) return;
        e.preventDefault();
        newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  // 当前选中会话（对账/本轮活动指示的数据源）。告知 WS service 供 S1 对账无条件优先拉它。
  const activeSess = !demo && activeId ? chat.getSession(activeId) : undefined;
  useEffect(() => {
    if (demo) return;
    sockRef.current?.setActiveSession(activeId);
  }, [demo, activeId]);

  // Goal state is platform-owned (PG), not part of the browser session blob.
  // Fetch on session selection; live updates arrive through sys.goal_snapshot.
  useEffect(() => {
    if (demo || !activeId || !user) return;
    let cancelled = false;
    void api.getSessionGoal(authRef.current, activeId).then((goal) => {
      if (!cancelled) sockRef.current?.setGoalState(activeId, goal);
    }).catch(() => {
      // A just-created session can briefly race its first server upsert. The
      // next selection or goal action retries; do not poison chat readiness.
    });
    return () => { cancelled = true; };
  }, [demo, activeId, user?.id]);

  const setSessionGoal = useCallback(async (input: {
    objective: string;
    tokenBudget: number | null;
    creditBudget: string | null;
    expectedStateRevision: number;
  }) => {
    const auth = authRef.current;
    if (!auth) return;
    const sessionId = activeId ?? ensureActiveSession();
    if (!sessionId) return;
    const sessionTitle =
      activeSess?.title ?? sessions.find((session) => session.id === sessionId)?.title ?? "新对话";
    const ensured = await sockRef.current?.ensureServerSession(sessionId, agent.id, sessionTitle);
    if (!ensured) throw new Error("会话尚未创建成功，请检查网络后重试");
    const goal = await api.setSessionGoal(auth, sessionId, input);
    sockRef.current?.setGoalState(sessionId, goal);
  }, [activeId, activeSess?.title, agent.id, ensureActiveSession, sessions]);

  const transitionSessionGoal = useCallback(async (
    action: "pause" | "resume" | "complete" | "clear",
  ) => {
    const auth = authRef.current;
    if (!auth || !activeId) return;
    const revision = sockRef.current?.getSession(activeId)?.goalState?.stateRevision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
      throw new Error("目标状态尚未加载，请稍后重试");
    }
    const goal = await api.transitionSessionGoal(auth, activeId, action, revision);
    sockRef.current?.setGoalState(activeId, goal);
  }, [activeId]);

  // 本轮活动快照（喂给 MessageList → TurnActivity）：模型慢时把阶段反馈显性化，取代裸三个点。
  // 团队模式额外带队长当前 plan step（消息区常长时间纯空白时用它填充等待文案）。
  const teamLeaderActive = !demo && teamMode && agent.id === "main";
  // 思考档位选择器数据:按当前**执行**模型(团队模式下 = 队长引擎,与 send 同口径)
  // 的支持集渲染选项;生效档 = 会话显式选择 ?? 全局偏好,不被当前模型支持时如实
  // 显示「跟随」(发送层 effortForModel 同样过滤,所见 = 所发)。
  const effortModel = models.find(
    (m) => m.id === effectiveEffortModelId(modelId, teamLeaderActive),
  );
  const effortSupported = effortModel?.supported_efforts ?? [];
  const effortCandidate = sessionEffort !== undefined ? sessionEffort : preferenceEffort;
  const effortActive =
    effortCandidate != null && effortSupported.includes(effortCandidate)
      ? effortCandidate
      : null;
  const turnActivity = useMemo<TurnActivityInfo | null>(() => {
    if (demo || !activeSess || !activeSess._sendingInFlight) return null;
    return {
      startedAt: activeSess._turnStartedAt ?? null,
      lastFrameAt: activeSess._lastFrameAt,
      progressHint: activeSess._turnProgressHint,
      turnStatus: activeSess._turnStatus ?? null,
      recoveryStatus: activeSess._recoveryStatus ?? null,
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
  const rawConnBanner = demo
    ? null
    : deriveConnBanner({
        cls: chat.status.cls,
        label: chat.status.label,
        browserOnline: chat.browserOnline,
        provisioning: chat.provisioning,
      });
  // 横幅 2s 延迟（P3 RFC D6）：断开 >2s 才点亮，2s 内重连成功零闪烁。只作用于横幅显示——
  // deriveConnBanner 仍即时反映断线真相，断线排队/禁发等发送语义不受影响。
  const connBanner = useDelayedConnBanner(rawConnBanner);
  // 停止当前轮：demo 本地停回放；非 demo 发 inbound.control.stop 并本地收尾。
  const stopTurn = useCallback(() => {
    if (demo) {
      stopRef.current = true;
      setBusy(false);
      setStreamText("");
    } else if (activeId) {
      // 隐式负反馈（中途打断）：过秒停窗后 Stop → 对本轮末条 assistant 静默记 implicit down。
      // 现场取消息（chat 已在依赖内），不捕获每帧刷新的 wsMessages。
      const stopTarget = findStopTarget(chat.getMessages(activeId), Date.now());
      if (stopTarget) sendImplicitRatingRef.current?.(stopTarget, { reason: "中途打断" });
      // 本轮由用户主动打断 → 不做完成脉冲高亮（nudge effect 消费该标记后清）。
      stoppedTurnRef.current = true;
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
  // 隐式负反馈上报去重：本会话运行内已隐式上报过的 messageId（切会话时清），防同一条重复 POST。
  const implicitReportedRef = useRef<Set<string>>(new Set());
  // 方案 a：高成本 turn 完成后对评分行做一次性脉冲高亮（4s）。nudgeId 经 ratingCtx 下发；
  // 定时器走 ref 自管（不绑 effect cleanup，避免 sending/activeId 变更中途误清 → 高亮永驻）。
  const [ratingNudgeId, setRatingNudgeId] = useState<string | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // sending 沿检测：true→false（turn 完成）才评估是否高亮。
  const prevSendingRef = useRef(sending);
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
  // 隐式负反馈静默上报（方案 b）：仅记 implicit down，**绝不碰 sessionRatings**（不渲染成
  // 用户已选态）。两道跳过闸：① 用户已显式评过该条 → 尊重其表态不覆盖；② 本会话运行已隐式
  // 上报过该 id → 幂等。tags=['implicit', reason] 供后端归因；503/限流/网络失败一律静默吞。
  const sendImplicitRating = useCallback(
    (target: ImplicitTarget, { reason }: { reason: ImplicitReason }) => {
      if (demo || !user || !activeId) return;
      const { messageId, traceId } = target;
      if (sessionRatings.has(messageId)) return;
      if (implicitReportedRef.current.has(messageId)) return;
      implicitReportedRef.current.add(messageId);
      void api
        .submitResponseRating(authRef.current, {
          messageId,
          rating: "down",
          sessionId: activeId,
          traceId: traceId ?? undefined,
          model: modelId,
          tags: ["implicit", reason],
        })
        .catch(() => {
          /* 静默：不弹错、不打断对话；隐式信号丢失可接受。*/
        });
    },
    [demo, user, activeId, modelId, sessionRatings],
  );
  // 回填稳定间接（render 期赋值幂等，与 sockRef / repoStatusHandlerRef 同模式）——
  // send/stopTurn 只经 ref 调用，故它们的引用不被本回调的重建牵动。
  sendImplicitRatingRef.current = sendImplicitRating;

  // 逐条反馈：打开显式反馈弹窗。上下文发送白名单由 MessageFeedbackDialog 收口，
  // 不再把诊断串静默写入剪贴板。
  const onFeedback = useCallback((ctx: FeedbackContext) => {
    messageFeedbackTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessageFeedback(ctx);
  }, []);
  // 工具卡上下文动作（记忆/技能/定时任务卡上的「打开…」按钮 + 连接器写操作确认卡的
  // 鉴权动作）。稳定引用经 context 注入，不污染 ToolCard 数据契约。demo 无网络 → 不提供
  //（按钮自动隐藏 / 确认卡降级纯展示）。authRef 是稳定 ref，不入依赖。
  const toolActions = useMemo(
    () =>
      demo
        ? {}
        : {
            onOpenMemory: () => openManage("memory"),
            onOpenSkills: () => openManage("skills"),
            onOpenTasks: () => openManage("cron"),
            connectorConfirm: {
              getDetail: (id: string) => api.getConnectorConfirmation(authRef.current, id),
              decide: (id: string, decision: "approve" | "deny") =>
                api.decideConnectorConfirmation(authRef.current, id, decision),
            },
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
    async (msg: ChatMessage) => {
      if (demo || !activeId) return;
      const exact = await loadExactUserMessage(msg);
      if (!exact) {
        toast("原始消息加载失败，请重试", "error");
        return;
      }
      // A deferred red-card CTA was admitted only when the sidecar recorded
      // complete routing/media evidence. Re-check the decoded row before
      // dispatch so a corrupt/mismatched payload can never degrade to text-only.
      if (msg._userPayloadDeferred === true && !preciseRetryEligible(exact)) {
        toast("原消息的完整重试信息不可用，请使用重新生成", "error");
        return;
      }
      sockRef.current?.retryMessage({
        sessId: activeId,
        msgId: msg.id,
        agentId: agent.id,
        sourceOverride: exact,
      });
    },
    [demo, activeId, agent.id, loadExactUserMessage, toast],
  );

  // 红卡 CTA 硬门(任务④ / Codex 审计 R4)的精确重试目标解析:按 assistant 错误行的
  // _clientMessageId 在当前会话里定位可**原样重发**的 user 行。现场取 messages(稳定句柄 sockRef,
  // 不捕获每帧刷新的 wsMessages),与 retrySend 同 deps(仅随会话切换变)。资格三条:
  //   (a) 该 user 行存在且 status='error'(有完整 payload、确实失败);
  //   (b)(c) 自带 _routing 快照 + 附件重发证据仍在 —— 见 preciseRetryEligible(与 retryMessage
  //   实际读取的字段严格对齐,防止借用别轮 _lastRouting / 静默丢附件)。任一不满足 → 返回
  //   undefined,红卡落回 onRegenerate 兜底(见 AssistantCard 的 R5 末轮门控)。
  const resolveRetryTarget = useCallback(
    (clientMessageId: string): ChatMessage | undefined => {
      if (demo || !activeId) return undefined;
      const msgs = sockRef.current?.getMessages(activeId) ?? [];
      const target = msgs.find(
        (m) => m.role === "user" && m.id === clientMessageId && m.status === "error",
      );
      return target && preciseRetryEligible(target) ? target : undefined;
    },
    [demo, activeId],
  );

  const resolveInterruptedContinuation = useCallback(
    (error: ChatMessage): ChatMessage | undefined => {
      if (demo || !activeId) return undefined;
      const msgs = sockRef.current?.getMessages(activeId) ?? [];
      return interruptedContinuationTarget(msgs, error, activeId)?.user;
    },
    [demo, activeId],
  );

  const continueInterrupted = useCallback(
    (error: ChatMessage) => {
      if (demo || !activeId) return;
      sockRef.current?.continueInterruptedTurn({
        sessId: activeId,
        errorMessageId: error.id,
        agentId: agent.id,
      });
    },
    [demo, activeId, agent.id],
  );

  // 卡片回调集（稳定引用：作为 MessageRenderer memo 比较键之一，避免无谓重渲）。
  // True tape process paging + oversized-record loading. Hook methods are stable;
  // demo/readonly surfaces leave the cursor disabled rather than inventing content.
  const {
    fetchTapeRecordPayload,
    peekTapeRecordPayload,
    fetchUserMessagePayload,
    peekUserMessagePayload,
  } = chat;
  const cardCallbacks: CardCallbacks = useMemo(
    () => ({
      onRegenerate: regenerate,
      onContinue: () => send(CONTINUE_PROMPT),
      onTopUp: demo ? undefined : () => openSettings(),
      onFeedback,
      onRetrySend: demo ? undefined : retrySend,
      onContinueInterrupted: demo ? undefined : continueInterrupted,
      resolveInterruptedContinuation: demo ? undefined : resolveInterruptedContinuation,
      onQuote: demo || !activeId
        ? undefined
        : (message) => {
            if (message.role !== "user" && message.role !== "assistant") return;
            const text = replyQuoteText(message);
            if (!text) return;
            const quote = normalizeMessageReplyQuote({
              messageId: message.id,
              role: message.role,
              text,
            });
            if (!quote) return;
            setMessageReplyTarget({
              sessionId: activeId,
              quote,
            });
          },
      onFetchTapeRecordPayload: demo
        ? undefined
        : (tapeId, recordOrdinal, expected, signal) =>
            fetchTapeRecordPayload(activeId, tapeId, recordOrdinal, expected, signal),
      onPeekTapeRecordPayload: demo
        ? undefined
        : (tapeId, recordOrdinal, expected) =>
            peekTapeRecordPayload(activeId, tapeId, recordOrdinal, expected),
      onFetchUserMessagePayload: demo
        ? undefined
        : (messageId, expected, signal) =>
            fetchUserMessagePayload(activeId, messageId, expected, signal),
      onPeekUserMessagePayload: demo
        ? undefined
        : (messageId, expected) =>
            peekUserMessagePayload(activeId, messageId, expected),
      resolveRetryTarget: demo ? undefined : resolveRetryTarget,
    }),
    [
      regenerate,
      send,
      demo,
      openSettings,
      onFeedback,
      retrySend,
      continueInterrupted,
      resolveInterruptedContinuation,
      activeId,
      fetchTapeRecordPayload,
      peekTapeRecordPayload,
      fetchUserMessagePayload,
      peekUserMessagePayload,
      resolveRetryTarget,
    ],
  );

  const composerReplyTo =
    messageReplyTarget && messageReplyTarget.sessionId === activeId
      ? messageReplyTarget.quote
      : null;

  // 已评回读：切会话/登录后拉一次 GET，填充已评态（重开会话时高亮 👍/👎、避免重复采集）。
  // 依赖用**派生布尔**（非 user 对象，refreshMe 换引用不误触发清空）+ activeId。切会话先清
  // 旧 Map（防串态），再异步注水；cancelled 守卫防慢响应覆盖新会话。demo/未登录不拉。
  const ratingsEnabled = !demo && !!user;
  useEffect(() => {
    setSessionRatings(new Map());
    // 切会话：清隐式上报去重集 + 收起任何未散的评分脉冲高亮（旧 nudgeId 属上个会话）。
    implicitReportedRef.current = new Set();
    setRatingNudgeId(null);
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
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
  // nudgeId 随载荷下发：nudge 卡作为 Context 消费者穿透 MessageRenderer sig-memo 重渲（同 ratings
  // 机制，不改渲染签名）→ 命中的评分行加/去脉冲类，其余卡 nudgeId!==自身 id 不受影响。
  const ratingCtx: ResponseRatingCtx | null = useMemo(
    () =>
      ratingsEnabled
        ? {
            ratings: sessionRatings,
            submit: onRateResponse,
            nudgeId: ratingNudgeId,
            sessionId: activeId,
            getToken: () => authRef.current?.snapshot().token,
          }
        : null,
    [ratingsEnabled, sessionRatings, onRateResponse, ratingNudgeId, activeId],
  );

  // 方案 a：sending true→false（本轮完成）沿检测 → 若为高成本 turn 且轮末条 assistant 未被评过，
  // 点亮该条评分行做一次性脉冲高亮引导（4s 自动熄灭）。用户主动 Stop 的轮不高亮（stoppedTurnRef）。
  // 走 sockRef.current（稳定句柄，同 chat）现场取消息，deps 不含每帧翻新的 chat 引用。
  useEffect(() => {
    const wasSending = prevSendingRef.current;
    prevSendingRef.current = sending;
    if (!wasSending || sending) return; // 仅 true→false 沿动作
    if (stoppedTurnRef.current) {
      stoppedTurnRef.current = false; // 消费"本轮被主动打断"标记 → 不高亮
      return;
    }
    if (demo || !activeId) return;
    const msgs = sockRef.current?.getMessages(activeId) ?? [];
    if (!isExpensiveTurn(msgs)) return;
    // 轮末条 assistant 正文 = 评价行唯一落点（turnFinalAssistantFlags 最后一个 true）。
    const flags = turnFinalAssistantFlags(msgs);
    let idx = -1;
    for (let i = flags.length - 1; i >= 0; i--) {
      if (flags[i]) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const id = msgs[idx]?.id;
    if (!id || sessionRatings.has(id)) return; // 已显式评过 → 不打扰
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    setRatingNudgeId(id);
    nudgeTimerRef.current = setTimeout(() => {
      setRatingNudgeId(null);
      nudgeTimerRef.current = null;
    }, 4000);
  }, [sending, demo, activeId, sessionRatings]);

  // 卸载兜底：清未散的脉冲定时器，防泄漏。
  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    },
    [],
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
    const anchor = archiveScrollAnchorRef.current;
    if (
      anchor && !anchor.cancelled && !anchor.restoring &&
      Math.abs(el.scrollTop - anchor.capturedScrollTop) > 1
    ) {
      // 用户已经离开点击位置：响应仍须等 DOM 提交后释放 FIFO，但不再把视口拉回旧坐标。
      anchor.cancelled = true;
    }
  }, [settleArchiveAnchor]);
  const cancelArchiveCorrection = useCallback(() => {
    const anchor = archiveScrollAnchorRef.current;
    if (anchor) anchor.cancelled = true;
  }, []);
  // 切会话:重置粘滞并瞬时跳底(历史回看从底部开始);同时清归档按钮子态与视口锚点。
  useEffect(() => {
    stickToBottomRef.current = true;
    scrollToChatBottom();
    setArchiveLoading(false);
    setArchiveError(false);
    archiveRequestTokenRef.current += 1;
    settleArchiveAnchor();
    return () => {
      archiveRequestTokenRef.current += 1;
      settleArchiveAnchor();
    };
  }, [activeId, scrollToChatBottom, settleArchiveAnchor]);
  // 内容变更跟随:demo 走 messages/streamText,真实路径走 version/wsSending。
  // 流式期间高频触发,用瞬时赋值而非 smooth(60fps 下排队的平滑动画反而卡顿)。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToChatBottom();
  }, [messages, streamText, chat.version, wsSending, scrollToChatBottom]);

  // 归档「查看更早历史记录」:记录点击时屏幕里真实可见的消息行。前插渲染后持续把
  // 该行恢复到原位置；底部仍在增长的实时 Agent 响应不会污染这次校正。
  const onLoadOlderHistory = useCallback(async () => {
    if (demo || !activeId) return;
    settleArchiveAnchor();
    const token = ++archiveRequestTokenRef.current;
    const el = scrollRef.current;
    let resolveAnchor: (() => void) | null = null;
    const anchorSettled = el
      ? new Promise<void>((resolve) => { resolveAnchor = resolve; })
      : Promise.resolve();
    const settle = () => {
      const resolve = resolveAnchor;
      resolveAnchor = null;
      resolve?.();
    };
    archiveScrollAnchorRef.current = el
      ? {
        token,
        capturedScrollTop: el.scrollTop,
        timelineGeneration: sockRef.current?.getSession(activeId)?._timelineGeneration,
        row: captureVisibleVirtualRowAnchor(el),
        ready: false,
        cancelled: false,
        restoring: false,
        settle,
      }
      : null;
    setArchiveError(false);
    setArchiveLoading(true);
    try {
      // loadOlderHistory 是非抛出式契约:失败以 {ok:false} 返回(hasMore 不封死,可重试)。
      const res = await chat.loadOlderHistory(activeId);
      if (archiveRequestTokenRef.current !== token) return;
      if (!res.ok) {
        setArchiveError(true);
        settleArchiveAnchor(token);
      } else if (res.loaded > 0) {
        const anchor = archiveScrollAnchorRef.current;
        if (anchor?.token === token) anchor.ready = true;
      } else {
        settleArchiveAnchor(token);
      }
    } catch {
      if (archiveRequestTokenRef.current !== token) return;
      setArchiveError(true);
      settleArchiveAnchor(token);
    } finally {
      if (archiveRequestTokenRef.current === token) setArchiveLoading(false);
    }
    // Keep the shared history FIFO occupied until this request's DOM insertion
    // has either been anchored or deliberately cancelled by user navigation.
    await anchorSettled;
  }, [demo, activeId, chat, settleArchiveAnchor]);
  // 对应归档响应完成且前插行渲染后(paint 前)才校正 scrollTop。请求在途时的 tape/live
  // 增长没有 ready token，不能冒领这个锚点。
  useLayoutEffect(() => {
    const anchor = archiveScrollAnchorRef.current;
    if (!anchor?.ready) return;
    const el = scrollRef.current;
    if (!el) {
      settleArchiveAnchor(anchor.token);
      return;
    }
    if (
      anchor.cancelled || !anchor.row ||
      anchor.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration
    ) {
      settleArchiveAnchor(anchor.token);
      return;
    }
    if (anchor.restoring) return;
    anchor.restoring = true;
    void restoreVisibleVirtualRowAnchor(
      el,
      anchor.row,
      () => {
        const current = archiveScrollAnchorRef.current;
        return !current || current.token !== anchor.token || current.cancelled ||
          current.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration;
      },
    ).finally(() => settleArchiveAnchor(anchor.token));
  }, [archiveLoading, chat.version, settleArchiveAnchor]);

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
        document.documentElement.style.setProperty("--oc-visual-height-85", `${Math.round(h * 0.85)}px`);
      }
      const top = vv?.offsetTop || 0;
      if (Number.isFinite(top)) {
        document.documentElement.style.setProperty("--oc-visual-offset-top", `${Math.max(0, Math.round(top))}px`);
      }
    };
    const realign = () => {
      setVisualViewportVars();
      if (!stickToBottomRef.current) return;
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
      document.documentElement.style.removeProperty("--oc-visual-height-85");
      document.documentElement.style.removeProperty("--oc-visual-offset-top");
    };
  }, [inWorkspace, scrollToChatBottom]);

  useEffect(() => {
    if (!inWorkspace) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setBoardOpen(false);
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
  // 面板深链单选优先级：教程 > 设置 > 市场 > 管理 > 组织（同一时刻仅镜像一个顶层中心）。
  const activePanel: PanelParam | null = tutorialOpen
    ? "help"
    : settingsOpen
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
    activeTopic: tutorialOpen ? tutorialTopic : null,
    activeCase: tutorialOpen ? tutorialCase : null,
    onPopPanel: (panel, topic, caseId) => {
      setSettingsOpen(panel === "settings");
      setMarketplaceOpen(panel === "market");
      setManageOpen(panel === "manage");
      setOrgOpen(panel === "org");
      setTutorialOpen(panel === "help");
      if (panel === "help") {
        setTutorialTopic(topic);
        setTutorialCase(caseId);
      }
    },
    workspace: boardOpen ? "board" : "chat",
    boardView,
    boardTicket: boardTicketId,
    boardTicketType,
    onPopWorkspace: (ws) => setBoardOpen(ws === "board"),
    onPopBoardParams: (nextView, ticket, ticketType) => {
      setBoardView(nextView);
      setBoardTicketId(ticket);
      setBoardTicketType(ticketType);
    },
  });

  // 启动续期检查中:极简 splash(避免"闪一下首页又跳工作区"的割裂;通常 <300ms)。
  if (!demo && booting) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  // A transient boot failure is not a logout. Surface the dedicated recovery
  // action immediately instead of hiding it behind the ordinary landing page.
  if (!demo && view === "home" && !authRecoveryAvailable) {
    return (
      <>
        <LazyBoundary fallback={<SplashFallback />}>
          <Landing
            onStart={() => {
              // 「免费开始」入口进登录页（login）：登录页本身有「立即注册」链接，新用户不受阻。
              setAuthMode("login");
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
        {tutorialOpen && (
          <LazyBoundary fallback={<DialogFallback />}>
            <TutorialCenter
              open={tutorialOpen}
              topicId={tutorialTopic}
              caseId={tutorialCase}
              onTopicChange={(id) => {
                setTutorialTopic(id);
                setTutorialCase(null);
              }}
              onCaseChange={(id) => {
                setTutorialCase(id);
                setTutorialTopic(null);
              }}
              onShowCaseGallery={() => {
                setTutorialCase(null);
                setTutorialTopic(null);
              }}
              caseActionLabel="登录后试用"
              onRunCase={runTutorialCase}
              auth={auth}
              onRequireLogin={() => {
                setTutorialOpen(false);
                setAuthMode("login");
                setView("app");
              }}
              onClose={() => setTutorialOpen(false)}
              actionState={() => ({
                enabled: true,
                label: "登录后试用",
              })}
              onRunAction={() => {
                setTutorialOpen(false);
                setAuthMode("login");
                setView("app");
              }}
            />
          </LazyBoundary>
        )}
      </>
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
        onRetrySession={authRecoveryAvailable ? retryBoot : undefined}
        onBack={() => {
          if (authRecoveryAvailable) clearAuth();
          setAuthMode("login");
          setView("home");
        }}
        theme={theme}
        onCycleTheme={cycle}
        turnstileBypass={publicCfg?.turnstileBypass}
        turnstileSiteKey={publicCfg?.turnstileSiteKey}
        onRetryPublicConfig={() => setPublicCfgRetryNonce((n) => n + 1)}
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
      loading: historyLoading,
      graceExpired: historyGraceExpired,
      capExpired: historyCapExpired,
    });
  const historySurface = sessionHistorySurface({
    gated,
    loadingHistory,
    hasMessages: demo ? messages.length > 0 : wsMessages.length > 0,
    sending: demo ? busy : wsSending,
    knownNonEmpty: (activeMeta?.messageCount ?? 0) > 0,
    historyError: !demo && historyError !== null,
  });

  // 统一真实时间线分页：仅显式按钮加载，滚动绝不发请求。
  // demo / 无选中会话时不下发(MessageList 退化为纯本地翻页)。
  const messageListArchive: MessageListArchive | undefined =
    !demo && activeId
      ? {
          hasMore: activeSess?._timelineHasMore === true,
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
    onOpenAccount: demo ? undefined : () => openSettings(),
    onOpenFeedback: demo ? undefined : () => openSettings("feedback"),
    onNew: newSession,
    onRename: renameSessionPrompt,
    onDelete: deleteSessionConfirm,
    onTogglePin: togglePinSession,
    onMoveToProject: moveSessionToProject,
    projects,
    collapsedProjectIds,
    onToggleProjectCollapsed: toggleProjectCollapsed,
    onCreateProject: createProjectPrompt,
    onRenameProject: renameProjectPrompt,
    onDeleteProject: deleteProjectConfirm,
    isSending: (id: string) => !demo && chat.isSending(id),
    liveTerminal,
    socketVersion: chat.version,
    onLogout: demo ? undefined : logout,
    onOpenManage: demo ? undefined : () => openManage(DEFAULT_MANAGE_TAB),
    // 账号菜单「管理中心」右侧的待办信号（Auto‑Dream 有待确认建议时替换静态副标题）。
    optimizerPending: demo ? 0 : optimizer.pendingCount,
    onOpenMarketplace: demo ? undefined : () => openMarketplace("browse"),
    onOpenTutorial: demo ? undefined : () => openTutorial(),
    onOpenMediaTasks: demo ? undefined : () => setMediaTasksOpen(true),
    theme,
    onCycleTheme: cycle,
    // 管理后台入口:仅平台超管(user.role === 'admin')可见,导航到 React 管理后台
    // (web-react 第二 Vite 入口 /admin.html)。非 admin / demo 一律不渲染。
    showAdmin: !demo && user?.role === "admin",
    // 组织入口:仅 org owner/admin 可见(成员无管理面,只在设置·账户页只读展示归属)。
    onOpenOrg:
      demo || !(user?.org && (user.org.role === "owner" || user.org.role === "admin"))
        ? undefined
        : () => openOrg(),
    onOpenBoard: demo ? undefined : () => setBoardOpen(true),
    boardActive: boardOpen,
    unreadIds: unreadSessions.unreadIds,
    onMarkRead: unreadSessions.markRead,
    onOpenProjectSettings: (p: ChatProject) => setProjectSettings(p),
    onReorderProjects: reorderProjects,
    width: sidebarWidth.width,
    onResizeStart: sidebarWidth.onResizeStart,
    resizing: sidebarWidth.resizing,
    models,
    onArchive: toggleArchiveSession,
    onBatch: batchUpdateSessions,
    onLoadMore: loadMoreSessions,
    hasMore: hasMoreSessions,
    loadingMore: loadingMoreSessions,
    onLoadArchived: loadArchivedSessions,
    loadingArchived,
    onSearchMessages: searchSessionMessages,
  };
  const closeMobileThen = (fn?: () => void) =>
    fn
      ? () => {
          setMobileNavOpen(false);
          fn();
        }
      : undefined;
  return (
    <MediaSignProvider
      sign={demo ? null : signMedia}
      authKey={user?.id ?? "anon"}
    >
    <ToolCardActionsContext.Provider value={toolActions}>
    <ChatInteractionContext.Provider value={chatInteraction}>
    <ImageEditActionsContext.Provider value={imageEditActions}>
    {/* safe-px:横屏侧刘海安全区(竖屏为 0) */}
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-fg safe-px">
      {/* 桌面：内联侧栏（可折叠）。窄屏隐藏，改用抽屉。 */}
      {!collapsed && (
        <div className="hidden md:contents">
          <Sidebar
            {...sidebarProps}
            onSelect={(id) => {
              setBoardOpen(false);
              selectSession(id);
            }}
            onNew={() => {
              setBoardOpen(false);
              newSession();
            }}
            onCollapse={() => setCollapsed(true)}
          />
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
            setBoardOpen(false);
            selectSession(id);
            setMobileNavOpen(false);
          }}
          onNew={() => {
            setBoardOpen(false);
            newSession();
            setMobileNavOpen(false);
          }}
          onCollapse={() => setMobileNavOpen(false)}
          onOpenBoard={
            demo
              ? undefined
              : () => {
                  setBoardOpen(true);
                  setMobileNavOpen(false);
                }
          }
          onOpenAccount={closeMobileThen(sidebarProps.onOpenAccount)}
          onOpenFeedback={closeMobileThen(sidebarProps.onOpenFeedback)}
          onOpenManage={closeMobileThen(sidebarProps.onOpenManage)}
          onOpenMarketplace={closeMobileThen(sidebarProps.onOpenMarketplace)}
          onOpenTutorial={closeMobileThen(sidebarProps.onOpenTutorial)}
          onOpenOrg={closeMobileThen(sidebarProps.onOpenOrg)}
          onOpenMediaTasks={closeMobileThen(sidebarProps.onOpenMediaTasks)}
          onLogout={closeMobileThen(sidebarProps.onLogout)}
          width={undefined}
          onResizeStart={undefined}
          resizing={false}
        />
      </Sheet>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {boardOpen && !demo && auth ? (
          <LazyBoundary fallback={<SplashFallback />}>
            <TaskboardView
              auth={auth}
              view={boardView}
              ticketId={boardTicketId}
              ticketType={boardTicketType}
              onViewChange={setBoardView}
              onOpenTicket={setBoardTicketId}
              onTicketTypeChange={setBoardTicketType}
              onOpenMobileNav={() => setMobileNavOpen(true)}
              sidebarCollapsed={collapsed}
              onExpandSidebar={() => setCollapsed(false)}
              sessionIds={sessions.map((s) => s.id)}
              onOpenSession={(id) => {
                // originSessionKey 是 agent:<id>:webchat:dm:<peerId>，不能当 Session.id。
                if (!id || id.includes(":") || !sessions.some((s) => s.id === id)) return;
                setBoardOpen(false);
                selectSession(id);
              }}
            />
          </LazyBoundary>
        ) : (
        <>
        <ChatHeader
          agent={agent}
          onAgentClick={() => setPickerOpen(true)}
          models={models}
          selectedModelId={modelId}
          onSelectModel={selectModel}
          modelsLoading={modelsLoading || modelSwitchPreparing}
          effortSupported={effortSupported}
          effortActive={effortActive}
          onSelectEffort={demo ? undefined : setSessionEffort}
          // 团队模式知情指示:与 send 的生效条件同构(teamMode 只对 main 生效,
          // 见上方 send 的 agent.id === "main" 判定)——顶栏所见 = 实际所发。
          teamModeActive={!demo && teamMode && agent.id === "main"}
          onDisableTeamMode={() => setTeamMode(false)}
          credits={demo ? null : (user?.credits ?? null)}
          onOpenBilling={demo ? undefined : () => openSettings()}
          sidebarCollapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNew={newSession}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenInbox={demo ? undefined : () => setInboxOpen(true)}
          unreadCount={inbox.unreadCount}
          sessionUnreadCount={unreadSessions.unreadIds.size}
        />

        {!demo && repo.showBanner && repo.selection?.selected && (
          <RepoStatusBanner
            selection={repo.selection}
            progressPct={repo.progressPct}
            onDismiss={repo.dismissBanner}
          />
        )}

        <div
          ref={bindChatScroll}
          onScroll={onChatScroll}
          onWheel={cancelArchiveCorrection}
          onTouchStart={cancelArchiveCorrection}
          onPointerDown={cancelArchiveCorrection}
          onKeyDown={cancelArchiveCorrection}
          className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          {gated ? (
            <AgentGate
              phase={gate.phase}
              onOpen={gate.open}
              onRetry={gate.check}
              onTopUp={() => openSettings()}
            />
          ) : loadingHistory || historySurface === "skeleton" ? (
            // 冷会话历史拉取期：消息形骨架占位，避免「空白 → 突然填满」的突变。
            <MessageListSkeleton />
          ) : historySurface === "error" ? (
            <div
              className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-12"
              data-testid="session-history-error"
            >
              <Alert
                tone="danger"
                title="会话加载失败"
                action={
                  activeId ? (
                    <button
                      type="button"
                      className="rounded-full bg-hover px-3 py-1.5 text-xs text-fg"
                      onClick={() => retryHistory(activeId)}
                    >
                      重试
                    </button>
                  ) : undefined
                }
              >
                {historyError?.message || "加载失败，请重试。不会把已有会话显示成空白欢迎页。"}
              </Alert>
            </div>
          ) : showEmpty || historySurface === "empty" ? (
            <EmptyState
              agent={agent}
              onPrefill={(text) => setComposerPrefill({ text, nonce: Date.now() })}
              onChangeAgent={() => setPickerOpen(true)}
            />
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
              <SessionTimelineBoundary
                resetKey={activeId ?? "none"}
                onRetry={activeId ? () => retryHistory(activeId) : undefined}
              >
                {historyError && wsMessages.length > 0 && (
                  <div className="mx-auto mb-2 max-w-3xl px-5 pt-4" data-testid="session-history-error-banner">
                    <Alert
                      tone="danger"
                      title="会话加载失败"
                      action={
                        <button
                          type="button"
                          className="rounded-full bg-hover px-3 py-1.5 text-xs text-fg"
                          onClick={() => activeId && retryHistory(activeId)}
                        >
                          重试
                        </button>
                      }
                    >
                      {historyError.message}
                    </Alert>
                  </div>
                )}
                <MessageList
                  key={activeId}
                  messages={wsMessages}
                  sending={wsSending}
                  liveTurnUsage={activeSess?._liveTurnUsage}
                  turnActivity={turnActivity}
                  transientNotice={transientNotice}
                  historyLoading={historyLoading}
                  journalDegraded={activeSess?._liveJournalDegraded === true}
                  onRetryJournal={activeId ? () => { void chat.retryLiveJournalHydration(activeId); } : undefined}
                  archive={messageListArchive}
                  cb={cardCallbacks}
                  onRespondPermission={onRespondPermission}
                  scrollParent={chatScrollParent}
                  historyGeneration={`${activeId ?? "none"}::${activeSess?._timelineGeneration ?? "legacy"}`}
                  sessionId={activeId}
                />
              </SessionTimelineBoundary>
            </ResponseRatingProvider>
          )}
        </div>

        {/* composer-safe-b:底部 Home 指示条安全区(叠在原 pb-3 上),否则发送区被遮 */}
        <div className="shrink-0 composer-safe-b">
          {/* 任务列表 HUD:钉在输入框上方,始终可见(取代会滚走的 inline TodoWrite 卡)。
              初始展开全部 → ~3s 自动折叠成「正在执行的一条」;无任务时组件自渲染 null。 */}
          {!demo && !gated && (
            <PinnedTaskTracker
              todos={extractLatestTodos(wsMessages)}
              active={wsSending}
              tokenUsage={activeSess?._liveTurnUsage?.usage}
            />
          )}
          {!demo && gate.phase.kind === "dormant" && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone="info">容器已休眠，发送消息后将自动唤醒。</Alert>
            </div>
          )}
          {!demo && !gated && activeSess?._turnCostReminderCredits && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <TurnCostReminder
                credits={activeSess._turnCostReminderCredits}
              />
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
            onSend={(text, media, replyTo) =>
              send(text, media, undefined, undefined, replyTo)
            }
            busy={sending}
            stopping={activeSess?._recoveryStatus?.kind === "stopping"}
            onStop={stopTurn}
            disabled={gated}
            placeholder={`和「${agent.name}」对话…`}
            onUpload={demo ? undefined : uploadMedia}
            getVoiceToken={demo ? undefined : () => authRef.current.snapshot().token}
            prefill={composerPrefill}
            replyTo={composerReplyTo}
            onCancelReply={() => setMessageReplyTarget(null)}
            repoSelection={demo ? null : repo.selection}
            onOpenRepo={demo ? undefined : openRepo}
            goal={activeSess?.goalState}
            onSetGoal={demo ? undefined : setSessionGoal}
            onGoalAction={demo ? undefined : transitionSessionGoal}
          />
        </div>
        </>
        )}
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
          // Picker 自己刚拉过最新 readiness；先把这条写回 App 目录，避免旧的 ready=false
          // 在同一轮 render 后触发会话归属 effect，把用户刚选中的 Agent 立刻切回 main。
          setMyAgents((current) =>
            current.some((item) => item.id === a.id)
              ? current.map((item) => (item.id === a.id ? a : item))
              : [...current, a],
          );
          if (!demo && activeId && a.id !== agent.id) chat.switchAgent(activeId, a.id);
          setAgent(a);
          setPickerOpen(false);
          setChatError(null);
        }}
      />

      {!demo && authed && auth && <PendingPaymentRecovery auth={auth} onPaid={refreshMe} />}

      {/* 仅在打开时挂载 → 懒块首屏零下载;Dialog 无 exit 动画(仅 data-[state=open]),
          即时卸载无视觉回退。tab 等状态由 App 持有或组件 open 时自 resync,卸载安全。*/}
      {settingsOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <SettingsCenter
            open={settingsOpen}
            initialSection={settingsSection}
            auth={auth}
            user={user}
            theme={theme}
            demo={demo}
            onClose={() => setSettingsOpen(false)}
            onSetTheme={setTheme}
            onRefreshMe={refreshMe}
            onPreferencesChange={applyConversationPreferences}
            feedbackContext={settingsFeedbackContext}
            onOpenMemory={() => openManage("optimization")}
            onOpenManage={() => openManage("connectors")}
            onOpenRepo={demo ? undefined : openRepo}
          />
        </LazyBoundary>
      )}

      {!demo && auth && (
        <MessageFeedbackDialog
          open={messageFeedback !== null}
          auth={auth}
          sessionId={activeId ?? null}
          context={messageFeedback}
          returnFocus={messageFeedbackTriggerRef.current}
          onOpenChange={(open) => {
            if (!open) setMessageFeedback(null);
          }}
        />
      )}

      <ProjectSettingsDialog
        project={projectSettings}
        open={projectSettings !== null}
        onClose={() => setProjectSettings(null)}
        onSave={async (patch) => {
          if (!projectSettings) return;
          await updateProject(projectSettings.id, patch);
        }}
      />

      <InboxDialog
        open={inboxOpen}
        auth={auth}
        onClose={() => setInboxOpen(false)}
        onUnreadChange={inbox.refreshUnread}
      />

      {!demo && mediaTasksOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <MediaTaskCenter
            open={mediaTasksOpen}
            auth={auth}
            liveJob={liveMediaJob}
            onOpenChange={setMediaTasksOpen}
          />
        </LazyBoundary>
      )}

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
            autoAuthorizePluginSlug={manageAutoAuthorizePluginSlug}
            optimizerPendingCount={optimizer.pendingCount}
            onAutoAuthorizeConsumed={() => setManageAutoAuthorizePluginSlug(null)}
            onTabChange={setManageTab}
            onOpenMarketplace={() => {
              setManageOpen(false);
              openMarketplace("browse", "connector");
            }}
            onRequireLogin={() => {
              // 未登录深链兜底（正常路径进不来：未登录时工作区根本不渲染）。
              setManageOpen(false);
              if (demo) {
                window.location.href = "/";
                return;
              }
              setAuthMode("login");
              setView("app");
            }}
            onClose={() => {
              setManageOpen(false);
              setManageAutoAuthorizePluginSlug(null);
              // Plugin 绑定/解绑会改变 Agent readiness；关闭管理中心时立即刷新目录。
              void refreshMyAgents().catch(() => {});
              // 面板里应用/忽略过建议 → 回拉待办真值，侧栏信号不留 stale。
              void optimizer.refresh().catch(() => {});
            }}
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
            onOpenConnectors={(pluginSlug) => {
              setMarketplaceOpen(false);
              setManageAutoAuthorizePluginSlug(pluginSlug ?? null);
              openManage("connectors");
            }}
            onTabChange={setMarketplaceTab}
            onClose={() => {
              setMarketplaceOpen(false);
              // 市场关闭后刷新已装目录(装/卸都会变);若当前选中的市场 agent 刚被卸载,
              // 回落全能助手,header/composer 不显示 stale agent。
              if (!demo && auth) {
                refreshMyAgents()
                  .then((rows) => {
                    if (
                      agent.id !== "main" &&
                      !rows.some((r) => r.id === agent.id && r.ready !== false)
                    ) {
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
            initialSection={orgSection}
            auth={auth}
            user={user}
            onClose={() => setOrgOpen(false)}
            onRefreshMe={refreshMe}
          />
        </LazyBoundary>
      )}
      {tutorialOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <TutorialCenter
            open={tutorialOpen}
            topicId={tutorialTopic}
            caseId={tutorialCase}
            onTopicChange={(id) => {
              setTutorialTopic(id);
              setTutorialCase(null);
            }}
            onCaseChange={(id) => {
              setTutorialCase(id);
              setTutorialTopic(null);
            }}
            onShowCaseGallery={() => {
              setTutorialCase(null);
              setTutorialTopic(null);
            }}
            caseActionLabel="带着指令去对话"
            onRunCase={runTutorialCase}
            auth={auth}
            onClose={() => setTutorialOpen(false)}
            actionState={(feature) => resolveTutorialAction(feature, tutorialActionContext)}
            onRunAction={runTutorialAction}
          />
        </LazyBoundary>
      )}
      {confirmDialogEl}
      {promptTextEl}
      <ImageAnnotationEditor
        source={imageAnnotationSource}
        open={!!imageAnnotationSource}
        onOpenChange={(next) => !next && setImageAnnotationSource(null)}
        onSubmit={submitImageEdit}
      />
      {containerPreviewUrl && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ContainerWebPreview
            key={containerPreviewUrl}
            open
            sourceUrl={containerPreviewUrl}
            auth={auth}
            onClose={() => setContainerPreviewUrl(null)}
            onUseComments={(text) => {
              setComposerPrefill({ text, nonce: Date.now() });
              setContainerPreviewUrl(null);
            }}
          />
        </LazyBoundary>
      )}
    </div>
    </ImageEditActionsContext.Provider>
    </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>
    </MediaSignProvider>
  );
}

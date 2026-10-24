import { DialogFallback } from "./components/DialogFallback";
import { useDraftSessionMaterialization } from "./hooks/useDraftSessionMaterialization";
import { useDraftPreparation } from "./hooks/useDraftPreparation";
import { createGoalStarter } from "./lib/goalStart";
import {
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { appUpdate } from "./lib/appUpdate";
import {
  type CursorContextTier,
  cursorModelSupportsContextTier,
  supportsFastServiceTier,
  isCodexEngineModel,
  normalizeMessageReplyQuote,
  type MessageReplyQuote,
} from "@openclaude/protocol/browser";
import { AgentGate } from "./components/AgentGate";
import { LazyBoundary } from "./components/ChunkErrorBoundary";
import { AgentPicker } from "./components/AgentPicker";
import { AuthGate, type AuthMode } from "./components/AuthGate";
import { DesktopEnrollPage } from "./components/DesktopEnrollPage";
import { ChatHeader } from "./components/ChatHeader";
import { applyIntelligentUiSnapshot, useInputPredictionEnabled } from "./lib/intelligentUi";
import { ProjectScopeProvider } from "./hooks/useProjectScope";
import { Composer, resetComposerAttachmentCache } from "./components/Composer";
import { ComposerProjectPill } from "./components/ComposerProjectPill";
import { accountDraftKey, NEW_COMPOSER_DRAFT_KEY, teardownComposerDrafts } from "./lib/composerDraft";
import type { ImageAnnotationSource } from "./components/ImageAnnotationEditor";
import {
  type ImageCommentSubmit,
  type ImageEditActions,
  ImageEditActionsContext,
  type ImageEditSubmit,
} from "./components/chat/imageEditActions";
import { extractLatestTodos, PinnedTaskTracker } from "./components/chat/PinnedTaskTracker";
import { QueuedSendList } from "./components/chat/QueuedSendList";
import { PinnedDelegateTracker } from "./components/chat/PinnedDelegateTracker";
import { PinnedGoalBar } from "./components/chat/PinnedGoalBar";
import { deriveActivePlanStep, type TurnActivityInfo } from "./components/chat/TurnActivity";
import { EmptyState, greetingName } from "./components/EmptyState";
import { type ChatError, ErrorBanner } from "./components/ErrorBanner";
import { SessionTimelineBoundary } from "./components/SessionTimelineBoundary";
import { UpdateBanner } from "./components/UpdateBanner";
import { RepoStatusBanner } from "./components/github/RepoStatusBanner";
import { PendingPaymentRecovery } from "./components/payment/PendingPaymentRecovery";
import { CHAT_CREATE_TEMPLATES } from "./lib/chatCreateTemplates";
import { sessionTitleFromText } from "./lib/sessionTitle";
import { isDialogLayerOpen, resolveGlobalHotkey } from "./lib/hotkeys";
import { pushPaletteRecent } from "./lib/paletteRecents";
import { type BannerKind, collapsedBannersLabel, resolveBanners } from "./lib/bannerStack";
import { readNetworkInformation, shouldPrefetchCenters } from "./lib/prefetchPolicy";
// 分区注册表在 lib（不是 ManageCenter）：ManageCenter 是 lazy chunk，从组件里取值会把
// 六个面板一起拖进主包。默认落地页 = 注册表首位，两处不再各写各的。
import { DEFAULT_MANAGE_TAB, type ManageTab, normalizeManageTab } from "./lib/manageTabs";
import type { SettingsSection } from "./components/SettingsCenter";
import type { OrgSection } from "./components/OrgCenter";
import type { MarketplaceKind, MarketplaceTab } from "./components/MarketplaceCenter";
import { AssistantMessage, UserMessage } from "./components/Message";
import { MessageList, type MessageListArchive } from "./components/MessageRenderer";
import { MessageListSkeleton } from "./components/chat/HistorySkeleton";
import { TurnCostReminder } from "./components/chat/TurnCostReminder";
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
  type VisibleVirtualRowAnchor,
} from "./components/chat/archivePaging";
import { createStickToBottomController } from "./components/chat/stickToBottom";
import { attachWheelFence } from "./components/chat/wheelFence";
import { currentTurnSettled } from "./components/chat/turnSegment";
import type { CardCallbacks, FeedbackContext } from "./components/chat/cards";
import { ResponseRatingProvider } from "./components/chat/ResponseRating";
import { MediaSignProvider } from "./components/chat/media";
import {
  ArtifactInspectActiveContext,
  ArtifactInspectContext,
  ChatInteractionContext,
  ToolCardActionsContext,
  type ArtifactInspectTarget,
  type ChatInteraction,
} from "./components/tool/context";
import { isBrowserStepMessage } from "./components/tool/browserDetect";
import {
  DETAIL_PANE_WIDTH,
  type DeferredPayloadLoader,
  InspectorPanel,
  InspectorPanelContent,
  type PaneRequest,
  type PaneTab,
  paneRequestForSession,
  readDetailPaneOpen,
  writeDetailPaneOpen,
} from "./components/InspectorPanel";
import type { ToolLike } from "./components/tool/format";
import { Sidebar } from "./components/Sidebar";
import { Alert, Button, Sheet, Spinner, useConfirm, usePrompt } from "./components/ui";
import { BootSplash } from "./components/BootSplash";
import { useAgentGate } from "./hooks/useAgentGate";
import { useHistorySkeleton } from "./hooks/useHistorySkeleton";
import {
  type BoardViewParam,
  parseBoardView,
  parseBoardTicket,
  parseBoardTicketType,
  activePanelOf,
  parsePanelParam,
  parseProjectPath,
  parseSessionPath,
  parseTutorialCase,
  parseTutorialCommunity,
  parseTutorialStep,
  parseTutorialTab,
  parseTutorialTopic,
  parseTutorialWork,
  preferredBoardView,
  readLocationRoute,
  replaceSearchParams,
  type ProjectRoute,
  type TutorialTab,
  type TutorialWorkId,
  useAppRoute,
} from "./hooks/useAppRoute";
import { useAuth } from "./hooks/useAuth";
import { useSessionList } from "./hooks/useSessionList";
import { useChatProjects } from "./hooks/useChatProjects";
import { useUnreadSessions } from "./hooks/useUnreadSessions";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useLocalComposerPrefs } from "./hooks/useLocalComposerPrefs";
import { useMdViewport, useWideViewport } from "./hooks/useMdViewport";
import { useResizableWidth } from "./hooks/useResizableWidth";
import { readCollapsed, writeCollapsed } from "./lib/sidebarCollapsed";
import { type UseChatSocket, useChatSocket } from "./hooks/useChatSocket";
import { type ImplicitReason, useResponseRatings } from "./hooks/useResponseRatings";
import { useSessionEngineOptions } from "./hooks/useSessionEngineOptions";
import { useInbox } from "./hooks/useInbox";
import { useInflightDelegates } from "./hooks/useInflightDelegates";
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
} from "./lib/implicitFeedback";
import { CONTINUE_PROMPT } from "./lib/chat/render";
import { deriveLiveTerminalFromMessages } from "./lib/sessionStatus";
import { deriveConnBanner, isPlatedAssistantMessage, lastRealUserTurn } from "./lib/chat/pure";
import { useDelayedConnBanner } from "./hooks/useDelayedConnBanner";
import { incidentStore } from "./lib/incidentStore";
import {
  clearTeamModeForSession,
  readTeamModeForSession,
  writeTeamMode,
} from "./lib/teamMode";
import {
  type CollabMode,
  type CollabUiState,
  ADVISOR_PARENT_BLOCK_REASON,
  EMPTY_COLLAB_UI,
  advisorParentCapabilityAllowed,
  collaborationPutBody,
  docToUiState,
  isStaleCollabEpoch,
  keepCollabChoiceOnSaveFailure,
  recommendedAdvisorModel,
  sendCollabFields,
} from "./lib/collaborationConfig";
import { prepareAdvisorSend, persistRecoveredAdvisor, saveInitialCollaboration } from "./lib/collaborationSend";

import { clearSessionEffort, writeSessionEffort } from "./lib/sessionEffort";
import { clearContextTierForSession, writeContextTier } from "./lib/sessionContextTier";
import { writeSessionServiceTier } from "./lib/sessionServiceTier";
import { DEFAULT_AGENT, agentFromApiRow, type Agent } from "./lib/agents";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "./lib/productCapabilities";
import { resolveTutorialAction } from "./lib/tutorialActions";
import type { TutorialCase, TutorialCaseId } from "./lib/tutorialCaseCatalog";
import { api, apiErrorMessage, ApiError } from "./lib/api";
import { uploadFilesToProject } from "./lib/projectFileUpload";
import { reportClientFriction } from "./lib/clientFriction";
import {
  effectiveEffortModelId,
  effortForModel,
  extractPrefs,
  type PreferenceEffort,
  type PrefsView,
  resolveSessionModel,
} from "./lib/modelPreferences";
import { DEMO_MESSAGES, DEMO_MESSAGES_BY_SESSION, DEMO_MODELS, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { ChatProject, LockedPublicModel, Message, PublicConfig, PublicModel, Session, SessionLastOutcome, ToolCard } from "./lib/types";
import type { LockedSelectInfo } from "./components/ModelSelector";
import { lockedModelUnlockNotice } from "./lib/cursorModelPicker";
import {
  freshSessionRequiredForSwitch,
  freshSessionSwitchNotice,
  modelSwitchCompactionReason,
} from "./lib/modelSwitch";
import { TASKBOARD_ENABLED } from "./lib/taskboardFeature";
import { useServerFeatures } from "./hooks/useServerFeatures";
import { dismissSuggestion, readDismissedSuggestions, suggestProjectForChat } from "./lib/unfiledSuggest";
import { projectChipsBoardId } from "./lib/projectChips";
import type { SaveToProjectRequest } from "./components/project/SaveToProjectDialog";
import { useChatScroll } from "./hooks/useChatScroll";
import { useChatCardActions } from "./hooks/useChatCardActions";
import { useAppDeepLinks } from "./hooks/useAppDeepLinks";
import { useAppNavigationActions } from "./hooks/useAppNavigationActions";
import { useComposerSend } from "./hooks/useComposerSend";
import { useSessionModelAndCollab } from "./hooks/useSessionModelAndCollab";
import { AppDialogs } from "./components/AppDialogs";

// 首屏瘦身:营销首页 + 设置/管理/市场/组织/教程中心按需异步加载,移出 entry chunk。
// 命名导出 → default 适配。渲染点各自套 LazyBoundary（= chunk 加载失败兜底 + Suspense：
// 对话框仅在 open 时挂载 → 首屏零下载,首次打开拉块时短暂显 loading；React.lazy 解析后模块
// 常驻,再次打开无回退闪烁。发新版后旧标签页拉不到旧 chunk 时由 ChunkErrorBoundary 兜底,
// 提示刷新而非白屏——见 components/ChunkErrorBoundary）。
type PredictInput = typeof import("./lib/inputPrediction").predictInput;
const IdentityRecoveryNotice = lazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.IdentityRecoveryNotice })));
const AccountSwitchNotice = lazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.AccountSwitchNotice })));
const AuthGate = lazy(() => import("./components/AuthGate").then((m) => ({ default: m.AuthGate })));
const DesktopEnrollPage = lazy(() => import("./components/DesktopEnrollPage").then((m) => ({ default: m.DesktopEnrollPage })));
const Landing = lazy(() => import("./components/Landing").then((m) => ({ default: m.Landing })));
const TutorialCenter = lazy(() =>
  import("./components/TutorialCenter").then((m) => ({ default: m.TutorialCenter })),
);
const ContainerWebPreview = lazy(() =>
  import("./components/ContainerWebPreview").then((m) => ({ default: m.ContainerWebPreview })),
);
const TaskboardView = lazy(() =>
  import("./components/taskboard/TaskboardView").then((m) => ({ default: m.TaskboardView })),
);
// 2026-09-17 首屏体量门(first-screen-budget)超限修复:下列对话框/编辑器都是「点开才需要」的
// 覆盖层,此前静态 import 把它们(连同 ImageViewer 三模式、ProjectAssetsPanel 等)钉在入口静态
// 闭包里。改 React.lazy 后由渲染点的挂载闸(useMountedOnce / 条件挂载)控制首次下载;打开过
// 一次即常驻,状态保留与关闭语义与原先「始终挂载、按 open 显隐」一致。
const ImageAnnotationEditor = lazy(() =>
  import("./components/ImageAnnotationEditor").then((m) => ({ default: m.ImageAnnotationEditor })),
);
// 项目主页(/p/<id>)是并列工作区,点开项目才需要;带着 ProjectAssetsPanel,不能进入口闭包。
const ProjectHome = lazy(() =>
  import("./components/project/ProjectHome").then((m) => ({ default: m.ProjectHome })),
);

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取这些懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    // 省流量模式 / 2G 下不在后台下完全部中心(shell 审计 S-16);API 缺席的浏览器照常预取。
    if (!shouldPrefetchCenters(readNetworkInformation())) return;
    void import("./components/Landing").catch(() => {});
    void import("./components/SettingsCenter").catch(() => {});
    void import("./components/ManageCenter").catch(() => {});
    void import("./components/MarketplaceCenter").catch(() => {});
    void import("./components/OrgCenter").catch(() => {});
    void import("./components/TutorialCenter").catch(() => {});
    void import("./components/MediaTaskCenter").catch(() => {});
    // 全屏图片查看器(含圈选编辑/评论/调整大小)也是懒块:时间线里点图即开,预热后首开零延迟。
    void import("./components/ImageViewer").catch(() => {});
    if (TASKBOARD_ENABLED) {
      void import("./components/taskboard/TaskboardView").catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch, { timeout: 8000 });
  } else {
    setTimeout(prefetch, 3000);
  }
}

/** 全屏懒块加载态（营销首页 chunk 下载期）——与启动续期 splash 同视觉,不割裂。*/
function SplashFallback() {
  return <BootSplash />;
}
/** 懒加载对话框的挂载闸:首次 open 之前不挂载(不下载 chunk);打开过一次后常驻返回 true,
 *  保持与原先「始终挂载、按 open 显隐」相同的状态保留/关闭语义。渲染期 setState 是 React
 *  认可的「由 props 派生状态」写法,只在 open 首次翻真时触发一次。 */
function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return mounted || open;
}

const EMPTY_WS_MESSAGES: ChatMessage[] = [];



export function App() {
  // P7 最小路由（无路由库）：特判页（demo / reset-password / desktop/enroll）与启动深链
  // （会话 /s/<id> + 面板 ?panel=）的解析见 readLocationRoute；此后 URL 是状态的 replaceState 单向镜像。
  const urlRoute = readLocationRoute(location);
  const { params, demo, resetToken, desktopEnroll, routingEnabled } = urlRoute;
  // 会话深链恢复未决标记：resolve 前 useSessionList 暂停"自动选中上次会话"
  // （URL 指定 > 最近会话）；resolve/放弃后置 null。
  const [pendingRouteSession, setPendingRouteSession] = useState<string | null>(() =>
    routingEnabled ? parseSessionPath(location.pathname) : null,
  );
  // 任务面板是并列工作区（整段替换 <main>），不是管理中心 Tab。boot 自 /board。
  const [boardOpen, setBoardOpenState] = useState(
    () => TASKBOARD_ENABLED && routingEnabled && location.pathname === "/board",
  );
  // 项目主页(/p/<id>[/<tab>])：第三个并列工作区。null = 不在项目主页。
  const [projectHome, setProjectHome] = useState<ProjectRoute | null>(null);
  // 启动深链 /p/<id> 的未决目标：等项目列表到达再打开(useAppRoute),不存在则回 /。
  const [pendingRouteProject, setPendingRouteProject] = useState<ProjectRoute | null>(() =>
    routingEnabled ? parseProjectPath(location.pathname) : null,
  );
  // 所有「去对话 / 去任务面板」的入口都经这里：切工作区即离开项目主页。
  // 用户主动导航也作废未决的 /p/<id> 深链恢复(否则列表迟到后会把人拽回项目主页)。
  const setBoardOpen = useCallback((open: boolean) => {
    setBoardOpenState(open);
    setProjectHome(null);
    setPendingRouteProject(null);
  }, []);
  const [boardView, setBoardView] = useState<BoardViewParam>(() =>
    routingEnabled ? parseBoardView(params, preferredBoardView()) : preferredBoardView(),
  );
  const [boardTicketId, setBoardTicketId] = useState<string | null>(() =>
    routingEnabled ? parseBoardTicket(params) : null,
  );
  const [boardTicketType, setBoardTicketType] = useState(() =>
    routingEnabled ? parseBoardTicketType(params) : null,
  );
  // 视图态：home=营销首页,app=登录页/工作区。启动静默续期成功（useAuth onBootAuthed）
  // 直接置 app,失败停在 home。
  const [view, setView] = useState<"home" | "app">(resetToken || desktopEnroll ? "app" : "home");
  // AuthGate 初始模式：「免费开始」=register，顶栏「登录」=login，重置链接=reset。
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
  const [collapsed, setCollapsed] = useState(() => readCollapsed());
  const composerPrefs = useLocalComposerPrefs();
  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agent, setAgent] = useState(DEFAULT_AGENT);
  // 已装智能体目录(agent 归属解析用):登录后拉一次,市场关闭时刷新;AgentPicker 打开时
  // 自行拉最新,两者互不依赖。目录**必须**参与会话归属解析的依赖(见下方 effect 注释)。
  const [myAgents, setMyAgents] = useState<Agent[]>([DEFAULT_AGENT]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 对话模型/默认思考深度:模型能力来自 GET /api/public/models；用户默认来自
  // /api/me/preferences。两者同批 hydrate 后才决定初始值,避免迟到偏好覆盖人工选择。
  const [models, setModels] = useState<PublicModel[]>(demo ? DEMO_MODELS : []);
  const [lockedModels, setLockedModels] = useState<LockedPublicModel[]>([]);
  const [subscribeOpenSignal, setSubscribeOpenSignal] = useState(0);
  const [modelId, setModelId] = useState<string | undefined>(demo ? DEMO_MODELS[0]?.id : undefined);
  // 最近一次 preferences 快照(default_model 解析用):per-session 模型恢复的回落基准。
  // 写入点 = models 装载批 + SettingsCenter onPreferencesChange;下方 resolver effect 消费。
  const [modelPrefs, setModelPrefs] = useState<PrefsView>({});
  const [preferenceEffort, setPreferenceEffort] = useState<PreferenceEffort | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSwitchPreparing, setModelSwitchPreparing] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  // 输入框上方横幅栈的「展开全部」(shell 审计 S-06)。默认折叠到 MAX_VISIBLE_BANNERS 条。
  const [bannersExpanded, setBannersExpanded] = useState(false);
  // UpdateBanner 自己订阅 governor,这里再订一份只为把它算进横幅栈的条数。
  const updateBannerVisible = useSyncExternalStore(appUpdate.subscribe, appUpdate.getBannerVisible);
  const [imageAnnotationSource, setImageAnnotationSource] = useState<ImageAnnotationSource | null>(null);
  const [containerPreviewUrl, setContainerPreviewUrl] = useState<string | null>(null);
  // 详情面板(右侧第三栏,OCV5-370):宽屏(≥1100px)内联第三列,开合与宽度记在本机;
  // 更窄的视口用贴底 Sheet,不硬挤三列。面板里看哪一步是纯 UI 态,不进 ChatSocket。
  const isMdViewport = useMdViewport();
  const isWideViewport = useWideViewport();
  const [paneOpen, setPaneOpenState] = useState(readDetailPaneOpen);
  const [paneSheetOpen, setPaneSheetOpen] = useState(false);
  const [paneRequest, setPaneRequest] = useState<PaneRequest | null>(null);
  const [paneActive, setPaneActive] = useState<ToolLike | null>(null);
  const paneWidth = useResizableWidth(DETAIL_PANE_WIDTH);
  const setPaneOpen = useCallback((open: boolean) => {
    setPaneOpenState(open);
    writeDetailPaneOpen(open);
  }, []);
  const paneToggleRef = useRef<(() => void) | null>(null);
  // 请求记下发起时的会话(openPane 引用稳定,不随会话变):切会话后旧请求不再交给新面板。
  const activeIdRef = useRef<string | null>(null);
  const isWideRef = useRef(isWideViewport);
  isWideRef.current = isWideViewport;
  /** 从面板外打开 / 定位面板:宽屏展开内联列,窄屏弹出贴底面板。 */
  const openPane = useCallback(
    (tab?: PaneTab, message?: ToolLike | null) => {
      setPaneRequest({ tab, message, nonce: Date.now(), sessionId: activeIdRef.current });
      if (isWideRef.current) setPaneOpen(true);
      else setPaneSheetOpen(true);
    },
    [setPaneOpen],
  );
  // 面板深链：boot 读到 ?panel= 即以打开态初始化（工作区渲染后即呈现；未登录深链则
  // 登录后呈现）。打开/关闭经 useAppRoute 同步回 query。
  const [settingsOpen, setSettingsOpen] = useState(urlRoute.panel === "settings");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [messageFeedback, setMessageFeedback] = useState<FeedbackContext | null>(null);
  const messageFeedbackTriggerRef = useRef<HTMLElement | null>(null);
  const messageFeedbackMounted = useMountedOnce(messageFeedback !== null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxMounted = useMountedOnce(inboxOpen);
  const [findOpen, setFindOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteMounted = useMountedOnce(paletteOpen);
  const [mediaTasksOpen, setMediaTasksOpen] = useState(false);
  // 「视频任务」入口门控:null=未知(保持可见),false=账号未开放(隐藏死入口)。
  const [mediaTasksAvailable, setMediaTasksAvailable] = useState<boolean | null>(null);
  // 「ChatGPT 直连」入口门控:服务端 GET /api/chatgpt-proxy/access 明确 enabled 才显示(默认隐藏)。
  const [chatGptProxyEnabled, setChatGptProxyEnabled] = useState(false);
  const [chatGptProxyOpen, setChatGptProxyOpen] = useState(false);
  const [liveMediaJob, setLiveMediaJob] = useState<MediaGenerationJob | null>(null);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const repoModalMounted = useMountedOnce(repoModalOpen);
  const [manageOpen, setManageOpen] = useState(urlRoute.panel === "manage");
  const [manageTab, setManageTab] = useState<ManageTab>(DEFAULT_MANAGE_TAB);
  const [manageAutoAuthorizePluginSlug, setManageAutoAuthorizePluginSlug] = useState<
    string | null
  >(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(urlRoute.panel === "market");
  const [orgOpen, setOrgOpen] = useState(urlRoute.panel === "org");
  const [orgSection, setOrgSection] = useState<OrgSection>("overview");
  const [tutorialOpen, setTutorialOpen] = useState(urlRoute.panel === "help");
  const [tutorialTopic, setTutorialTopic] = useState<ProductFeatureId | null>(urlRoute.tutorialTopic);
  const [tutorialCase, setTutorialCase] = useState<TutorialCaseId | null>(urlRoute.tutorialCase);
  const [tutorialCommunity, setTutorialCommunity] = useState<string | null>(urlRoute.tutorialCommunity);
  // 一级页签（null = 案例展厅，不进 URL）/ 精选作品 / 功能教程目标步骤：镜像到 ?tab= / ?work= / ?step=。
  const [tutorialTab, setTutorialTab] = useState<TutorialTab | null>(urlRoute.tutorialTab);
  const [tutorialWork, setTutorialWork] = useState<TutorialWorkId | null>(urlRoute.tutorialWork);
  const [tutorialStep, setTutorialStep] = useState<number | null>(urlRoute.tutorialStep);
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>("browse");
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>("skill");
  // 「在对话中创建」技能/智能体:关市场 → 新会话 → Composer 预填引导模板(用户改后发送)。
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [goalOpenNonce, setGoalOpenNonce] = useState(0);
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
    resolvedIdentity,
    pendingAccount,
    accountSwitchReady,
    acceptAccountSwitch,
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
      teardownComposerDrafts(user?.id);
      resetComposerAttachmentCache();
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
      setTutorialCommunity(keepPublicTutorial ? parseTutorialCommunity(publicQuery) : null);
      setTutorialTab(keepPublicTutorial ? parseTutorialTab(publicQuery) : null);
      setTutorialWork(keepPublicTutorial ? parseTutorialWork(publicQuery) : null);
      setTutorialStep(keepPublicTutorial ? parseTutorialStep(publicQuery) : null);
      setView("home");
    },
    // 登出前清本 user 的 IndexedDB 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效）。
    onLogout: () => void sockRef.current?.wipePersistence(),
    onAccountSwitchPending: () => {
      setContainerPreviewUrl(null);
      setSettingsOpen(false);
      setMediaTasksOpen(false);
      setLiveMediaJob(null);
      setManageAutoAuthorizePluginSlug(null);
      setOrgOpen(false);
      setTutorialOpen(false);
    },
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
    loadMoreError,
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
    // demo 会话按 id 取 fixture(misc-p3 D-02 接线):目前只有 s1 有消息,其余点开即空态;要给别的会话
    // 补内容只需往 DEMO_MESSAGES_BY_SESSION 加 fixture 并同步 DEMO_SESSIONS 的 messageCount。
    onDemoSelect: (id) => setMessages(DEMO_MESSAGES_BY_SESSION[id] ?? []),
    // 新建会话：停 demo 流式回放 + 清空展示消息 + 清错误（原 newSession 前置收尾）。
    onNewSessionReset: () => {
      interrupt();
      setMessages([]);
      setChatError(null);
      setPendingRouteSession(null);
      setPendingRouteProject(null);
    },
    onDeleteSession: (id) => {
      localStore.current.delete(id);
      clearTeamModeForSession(id); // 顺手清该会话的团队模式 per-session 键(不留孤儿键)
      clearSessionEffort(id); // 同上:思考档位 per-session 键
      clearContextTierForSession(id); // 同上:Cursor 上下文档位 per-session 键
      writeSessionServiceTier(id, null); // OCV5-434 GPT Fast per-session 键
    },
    onActiveSessionDeleted: () => {
      setMessages([]);
      setChatError(null);
    },
    // URL 深链恢复未决：暂停自动选中（URL 指定 > 最近会话）。
    holdAutoSelect: pendingRouteSession !== null,
  });

  // 「项目下新建会话」草稿意图：项目行入口记下目标项目，空白草稿真正建会话（首次发送）时
  // 消费——本地立即归属该项目 + 服务端 PATCH 落库。无参新建 / 选中已有会话都会覆盖清除，
  // 意图只活在「一次草稿」生命周期内，不会泄漏到之后的新会话。
  // 草稿归属既要被 send 同步读取(ref),也要在输入框里显示、可改(state):两者经 setDraftProject 同写。
  const draftProjectRef = useRef<string | null>(null);
  const [draftProjectId, setDraftProjectIdState] = useState<string | null>(null);
  const setDraftProject = useCallback((projectId: string | null) => {
    draftProjectRef.current = projectId;
    setDraftProjectIdState(projectId);
  }, []);
  const handleNew = useCallback(() => {
    setDraftProject(null);
    newSession();
  }, [newSession, setDraftProject]);
  const newSessionInProject = useCallback(
    (projectId: string) => {
      setDraftProject(projectId);
      newSession();
    },
    [newSession, setDraftProject],
  );

  const [projectSettings, setProjectSettings] = useState<ChatProject | null>(null);
  const [ungroupedAssetsOpen, setUngroupedAssetsOpen] = useState(false);
  // 「打开项目」的唯一入口(侧栏项目名、顶栏项目、输入框项目标识)：打开项目主页。
  // 项目设置仍可从主页的 ⋯ / 设置 与侧栏行的 ⋯ 进入。
  const projectsRef = useRef<ChatProject[]>([]);
  const openProject = useCallback((projectId: string) => {
    if (!projectsRef.current.some((x) => x.id === projectId)) return;
    setPendingRouteProject(null);
    setBoardOpenState(false);
    setProjectHome({ projectId, tab: "overview" });
  }, []);
  const projectSettingsOpen = projectSettings !== null || ungroupedAssetsOpen;
  const projectSettingsMounted = useMountedOnce(projectSettingsOpen);
  // 新建项目对话框:null=关;{}=普通新建;{sessionId,title}=从该会话创建并移入。
  const [createProjectFrom, setCreateProjectFrom] = useState<{ sessionId?: string; title?: string } | null>(null);
  const createProjectMounted = useMountedOnce(createProjectFrom !== null);
  const [projectArchiveOpen, setProjectArchiveOpen] = useState(false);
  const projectArchiveMounted = useMountedOnce(projectArchiveOpen);
  // P5b：「记住这条 / 存为项目技能」弹窗请求（null = 关）。
  const [saveToProject, setSaveToProject] = useState<SaveToProjectRequest | null>(null);
  const saveToProjectMounted = useMountedOnce(saveToProject !== null);
  // 换号 / 登出：发起时的身份已不在，弹窗直接收起（保存流程自己也会按身份停下）。
  useEffect(() => {
    void user?.id;
    setSaveToProject(null);
  }, [user?.id]);

  const {
    projects,
    projectsLoaded,
    collapsedIds: collapsedProjectIds,
    toggleCollapsed: toggleProjectCollapsed,
    createProject,
    renameProjectPrompt,
    deleteProjectConfirm,
    restoreProject,
    listDeletedProjects,
    setProjectArchived,
    setProjectPinned,
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

  projectsRef.current = projects;
  const homeProject = projectHome ? projects.find((p) => p.id === projectHome.projectId) : undefined;

  // 服务端功能开关（GET /api/features；读不到 = 全关，demo 不读）。
  const serverFeatures = useServerFeatures(demo ? null : auth, demo);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setDismissedSuggestions(user?.id ? readDismissedSuggestions(user.id) : new Set());
  }, [user?.id]);
  // 当前会话所属项目的看板：P5b 两个入口只在会话属于有看板的项目时出现。
  const activeProjectId = activeId ? sessions.find((s) => s.id === activeId)?.projectId : undefined;
  const activeChatProject = activeProjectId ? projects.find((p) => p.id === activeProjectId) : undefined;
  const chipsBoardProjectId = projectChipsBoardId({
    demo,
    taskboardEnabled: TASKBOARD_ENABLED,
    chipsFlag: serverFeatures.chips,
    project: activeChatProject,
  });
  const chipsProjectName = activeChatProject?.name ?? "";

  // 确保项目的看板已在容器里建好（任何看板路由首次访问都会建出预留的看板）。
  // 项目主页的入口和 P5b / P5c 的保存共用这一条路径。
  const prepareProjectBoard = useCallback(
    async (boardProjectId: string): Promise<boolean> => {
      try {
        const { taskboardApi } = await import("./lib/taskboard");
        await taskboardApi.getProject(authRef.current, boardProjectId);
        return true;
      } catch (e) {
        toast(apiErrorMessage(e, "项目看板暂时打不开，请稍后再试"), "error");
        return false;
      }
    },
    [toast],
  );
  // 主页上的项目被删除(本页 ⋯ 删除或别处删除)：列表落定后不再存在 → 回对话。
  useEffect(() => {
    if (projectHome && projectsLoaded && !homeProject) setProjectHome(null);
  }, [projectHome, projectsLoaded, homeProject]);

  // Ctrl/⌘K recents: whatever the user actually lands on (project home or a chat).
  const paletteUserId = user?.id ?? (demo ? "demo" : null);
  const homeProjectId = homeProject?.id ?? null;
  const chatViewActiveId = !boardOpen && !projectHome ? activeId : undefined;
  useEffect(() => {
    if (homeProjectId) pushPaletteRecent(paletteUserId, { kind: "project", id: homeProjectId });
  }, [paletteUserId, homeProjectId]);
  useEffect(() => {
    if (chatViewActiveId) pushPaletteRecent(paletteUserId, { kind: "session", id: chatViewActiveId });
  }, [paletteUserId, chatViewActiveId]);
  // Stable search callbacks for the palette (its debounce effect depends on them).
  const searchSessionMessagesRef = useRef(searchSessionMessages);
  searchSessionMessagesRef.current = searchSessionMessages;
  const paletteSearchMessages = useMemo(
    () =>
      demo || !auth
        ? undefined
        : (q: string, signal: AbortSignal) => searchSessionMessagesRef.current(q, signal, undefined, true),
    [demo, auth],
  );
  const paletteSearchAssets = useMemo(
    () =>
      demo || !auth
        ? undefined
        : (q: string, signal: AbortSignal, limit: number) =>
            api.searchProjectAssets(authRef.current, q, { signal, limit }),
    [demo, auth],
  );

  const unreadSessions = useUnreadSessions({
    sessions,
    activeId: activeId ?? null,
    userId: user?.id ?? null,
    auth: demo ? null : auth,
    // sidebar-B UUS-01：系统通知点开后落到对应会话（hook 内已 window.focus()）。
    // 在项目主页时点系统通知：落到对应会话即离开主页(任务面板保持原行为)。
    onNotificationOpen: (id: string) => {
      setProjectHome(null);
      setPendingRouteProject(null);
      selectSession(id);
    },
  });
  const sidebarWidth = useSidebarWidth();

  // 切会话/进出任务看板时清掉面板里的定位:消息对象引用属于旧会话上下文,跨会话保留只会
  // 展示与当前消息流无关的陈旧内容。宽屏面板的开合是用户偏好,保留;窄屏抽屉收起。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId / boardOpen / projectHome 是「换了上下文」的触发信号
  useEffect(() => {
    setPaneRequest(null);
    setPaneActive(null);
    setPaneSheetOpen(false);
  }, [activeId, boardOpen, projectHome]);

  const {
    applyCollabDoc,
    collabAsDefault,
    collabEpochRef,
    collabMode,
    collabSaveError,
    collabUi,
    persistCollab,
    selectModel,
    setCollabAsDefault,
    setCollabMode,
    setCollabSaveError,
    setCollabUi,
    setTeamMode,
    setTeamModeState,
    teamMode,
  } = useSessionModelAndCollab({
    activeId,
    agent,
    auth,
    confirmDialog,
    demo,
    handleNew,
    modelId,
    modelPrefs,
    modelSwitchPreparing,
    models,
    queueModelPatch,
    resetSessionList,
    sessions,
    sessionsResetRef,
    setModelId,
    setModelSwitchPreparing,
    setSessions,
    sockRef,
    toast,
  });

  // 本会话的思考档位与上下文档位(hooks/useSessionEngineOptions,原位调用)。
  const { sessionEffort, setSessionEffort, contextTier, setContextTier, serviceTier, setServiceTier } =
    useSessionEngineOptions(activeId);

  const { draftSessionId, stopPreparing } = useDraftPreparation({
    auth, userId: user?.id ?? null, activeId, agentId: agent.id, modelId,
    effortLevel: effortForModel(models, effectiveEffortModelId(modelId, false),
      sessionEffort !== undefined ? sessionEffort : preferenceEffort),
    enabled: !demo && laneReady && view === "app" && serverListSettled && !activeId &&
      !draftProjectId && !projectHome && !boardOpen && collabMode === "solo" && serviceTier !== "fast" &&
      !!modelId && isCodexEngineModel(modelId) && models.some(m => m.id === modelId),
  });

  // Async goal saves can finish after navigation; only consume the selected draft's project.
  const selectedSessionIdRef = useRef(activeId);
  selectedSessionIdRef.current = activeId;
  const {
    image2Available,
    imageEditActions,
    send,
    startInProject,
    submitImageEdit,
    uploadMedia,
  } = useComposerSend({
    activeId,
    agent,
    applyCollabDoc,
    auth,
    authRef,
    boardOpen,
    collabAsDefault,
    collabEpochRef,
    collabUi,
    contextTier,
    demo,
    draftProjectId,
    draftProjectRef,
    draftSessionId,
    modelId,
    models,
    newSessionInProject,
    preferenceEffort,
    projectHome,
    publicCfg,
    selectedSessionIdRef,
    sendImplicitRatingRef,
    serviceTier,
    sessionEffort,
    sessions,
    setActiveId,
    setBoardOpen,
    setBusy,
    setChatError,
    setCollabSaveError,
    setCollabUi,
    setDraftProject,
    setImageAnnotationSource,
    setMessages,
    setSessions,
    setStreamText,
    setTeamModeState,
    sockRef,
    stopPreparing,
    stopRef,
    toast,
    user,
  });

  const {
    applyConversationPreferences,
    ensureActiveSession,
    handleLockedSelect,
    inWorkspace,
    loadExactUserMessage,
    openManage,
    openMarketplace,
    openOrg,
    openRepo,
    openSettings,
    openTutorial,
    regenerate,
    runTutorialAction,
    runTutorialCase,
    settingsFeedbackContext,
    tutorialActionContext,
  } = useAppNavigationActions({
    activeId,
    agent,
    auth,
    collabMode,
    confirmDialog,
    contextTier,
    demo,
    draftSessionId,
    handleNew,
    image2Available,
    messages,
    modelId,
    refreshMe,
    send,
    serviceTier,
    sessionEffort,
    setActiveId,
    setAuthMode,
    setBoardOpen,
    setCollapsed,
    setComposerPrefill,
    setInboxOpen,
    setManageOpen,
    setManageTab,
    setMarketplaceBrowseKind,
    setMarketplaceOpen,
    setMarketplaceTab,
    setMobileNavOpen,
    setModelPrefs,
    setOrgOpen,
    setOrgSection,
    setPickerOpen,
    setPreferenceEffort,
    setRepoModalOpen,
    setSessions,
    setSettingsOpen,
    setSettingsSection,
    setSubscribeOpenSignal,
    setTutorialCase,
    setTutorialCommunity,
    setTutorialOpen,
    setTutorialStep,
    setTutorialTab,
    setTutorialTopic,
    setTutorialWork,
    setView,
    sockRef,
    stopPreparing,
    toast,
    user,
    view,
  });

  const {
    inbox,
    refreshMyAgents,
  } = useAppDeepLinks({
    auth,
    authRef,
    authed,
    confirmDialog,
    demo,
    handleNew,
    inWorkspace,
    publicCfgRetryNonce,
    refreshMe,
    routingEnabled,
    setComposerPrefill,
    setLockedModels,
    setManageOpen,
    setManageTab,
    setModelPrefs,
    setModels,
    setModelsLoading,
    setMyAgents,
    setPreferenceEffort,
    setPublicCfg,
    setPublicCfgRetryNonce,
    toast,
    user,
    view,
  });

  // 对话前置态机：检查订阅/容器、引导开通、轮询容器至就绪。gate.access=false 时由
  // AgentGate 面板占据对话区并禁用 Composer；gate.ready 是 P4 useChatSocket 连接的硬前置。
  const gate = useAgentGate(auth, inWorkspace && !demo);

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
  // 分享对话框只针对打开时的会话;切会话(返回键/深链)就关掉,不拿旧快照配新标题。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId 是触发条件
  useEffect(() => {
    setShareOpen(false);
  }, [activeId]);
  const wsSending = !demo && chat.isSending(activeId);
  // 统一“本轮进行中”信号：demo 用本地 busy，非 demo 用 WS in-flight。
  const sending = demo ? busy : wsSending;
  activeIdRef.current = activeId ?? null;
  // 详情面板可用 = 对话视图(非任务看板 / 项目主页)里有会话内容;demo 只在点了某张工具卡时出现。
  const paneAvailable =
    !boardOpen && !projectHome && (demo ? !!paneRequest?.message : !!activeId && wsMessages.length > 0);
  const paneRequestHere = paneRequestForSession(paneRequest, activeId);
  const paneInline = paneAvailable && isWideViewport && paneOpen;
  const paneShown = paneInline || (paneAvailable && !isWideViewport && paneSheetOpen);
  const togglePane = () => {
    if (paneShown) {
      if (isWideViewport) setPaneOpen(false);
      else setPaneSheetOpen(false);
      return;
    }
    openPane();
  };
  paneToggleRef.current = paneAvailable && !demo ? togglePane : null;
  const inflightDelegates = useInflightDelegates({
    sessionId: !demo && activeId ? activeId : null,
    messages: wsMessages,
    enabled: !demo && gate.access && !!activeId,
    auth,
  });

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
    const onKey = (e: KeyboardEvent) => {
      const action = resolveGlobalHotkey(e);
      if (action === "search") {
        if (!inWorkspace) return;
        e.preventDefault();
        // Toggle. Another dialog layer (settings, drawer, …) keeps Esc/focus; don't stack on it.
        const otherLayer = isDialogLayerOpen();
        setPaletteOpen((o) => (o ? false : !otherLayer));
        return;
      }
      if (action === "new") {
        e.preventDefault();
        setBoardOpen(false);
        handleNew();
      }
      if (action === "find") {
        if (!inWorkspace || demo || wsMessages.length <= 0) return;
        e.preventDefault();
        setFindOpen(true);
      }
      if (action === "pane") {
        if (!inWorkspace || !paneToggleRef.current) return;
        e.preventDefault();
        paneToggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNew, inWorkspace, demo, wsMessages.length, setBoardOpen]);

  // 当前选中会话（对账/本轮活动指示的数据源）。告知 WS service 供 S1 对账无条件优先拉它。
  const activeSess = !demo && activeId ? chat.getSession(activeId) : undefined;
  useEffect(() => {
    if (demo) return;
    sockRef.current?.setActiveSession(activeId);
  }, [demo, activeId]);

  // Goal state is platform-owned (PG), not part of the browser session blob.
  // Fetch on session selection; live updates arrive through sys.goal_snapshot.
  // Draft sessions with no client_sessions row used to 404; the route now
  // returns 200 {goal:null}, and a missing goal is a no-op here.
  // 只随登录身份变化重拉(user 对象 refreshMe 会换引用,不应触发)。
  const goalUserId = user?.id;
  useEffect(() => {
    if (demo || !activeId || !goalUserId) return;
    let cancelled = false;
    void api.getSessionGoal(authRef.current, activeId).then((goal) => {
      if (!cancelled) sockRef.current?.setGoalState(activeId, goal);
    }).catch(() => {
      // A just-created session can briefly race its first server upsert. The
      // next selection or goal action retries; do not poison chat readiness.
    });
    return () => { cancelled = true; };
  }, [demo, activeId, goalUserId]);

  const goalStarterRef = useRef(createGoalStarter());
  const setSessionGoal = useCallback(async (input: {
    objective: string;
    tokenBudget: number | null;
    creditBudget: string | null;
    expectedStateRevision: number;
  }) => {
    const auth = authRef.current;
    if (!auth) throw new Error("请先登录后再设置目标");
    const sessionId = activeId ?? ensureActiveSession();
    if (!sessionId) throw new Error("会话尚未就绪，请稍后重试");
    const sessionTitle =
      activeSess?.title ?? sessions.find((session) => session.id === sessionId)?.title ?? "新对话";
    const projectId = draftProjectRef.current;
    await goalStarterRef.current(sessionId, {
      isBusy: () => !!sockRef.current?.isSending(sessionId),
      save: async () => {
        const ensured = await sockRef.current?.ensureServerSession(sessionId, agent.id, sessionTitle);
        if (!ensured) throw new Error("会话尚未创建成功，请检查网络后重试");
        return api.setSessionGoal(auth, sessionId, input);
      },
      apply: (goal) => sockRef.current?.setGoalState(sessionId, goal),
      start: (goal) => {
        if (authRef.current !== auth || !sockRef.current?.getSession(sessionId)) {
          throw new Error("登录状态已变化或原会话已关闭");
        }
        return send(goal.objective, undefined, undefined, undefined, undefined, { sessionId, projectId });
      },
    });
  }, [activeId, activeSess?.title, agent.id, ensureActiveSession, sessions, send]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.version 是就地 mutation 会话的刷新触发器(见末行注释)。
  const turnActivity = useMemo<TurnActivityInfo | null>(() => {
    if (demo || !activeSess) return null;
    // OCV5-428: a message still in the local journal (transport down, or on the wire
    // without the server's admission ACK) gets its own row; 「思考中」 waits for admission.
    const dispatch = chat.dispatchStatus(activeSess.id);
    if (!activeSess._sendingInFlight && !dispatch) return null;
    return {
      dispatch,
      startedAt: activeSess._turnStartedAt ?? null,
      lastFrameAt: activeSess._lastFrameAt,
      progressHint: activeSess._turnProgressHint,
      hasPlated: wsMessages.some((m) =>
        isPlatedAssistantMessage(m) &&
        (!activeSess._activeClientMessageId ||
          m._clientMessageId === activeSess._activeClientMessageId),
      ),
      turnStatus: activeSess._turnStatus ?? null,
      recoveryStatus: activeSess._recoveryStatus ?? null,
      hasVisibleProcess: activeSess._liveUnitsPackApplied === true ||
        wsMessages.some((m) =>
          m._liveUnit === true ||
          m.role === "thinking" ||
          m.role === "tool" ||
          m.role === "agent-group" ||
          m.role === "plan",
        ),
      coldStart: !!activeSess._isFirstTurnAfterReady,
      agentName: agent.name || "助手",
      leaderStep: teamLeaderActive ? deriveActivePlanStep(extractLatestTodos(wsMessages)) : null,
    };
    // chat.version 是就地 mutation 会话的变更权威信号（同引用，须显式入依赖才随帧刷新）。
  }, [demo, activeSess, teamLeaderActive, agent.name, wsMessages, chat.version, chat.dispatchStatus]);

  // 对话前置门：非 demo 且尚无访问权（容器未就绪/未订阅/出错等）→ 由 AgentGate 占据对话区
  // 并禁用 Composer。demo 与已就绪（ready|dormant）放行正常对话。
  const gated = !demo && !gate.access;
  // 冷会话加载骨架（计时器 + 派生，见 hooks/useHistorySkeleton）。须在下方 boot/登录等早返回之前调用。
  const { loadingHistory, historySurface } = useHistorySkeleton({
    demo,
    activeId,
    sessions,
    gated,
    wsMessageCount: wsMessages.length,
    wsSending,
    demoMessageCount: messages.length,
    demoBusy: busy,
    serverListSettled,
    historyLoading,
    historyError,
  });

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
  const {
    artifactInspect,
    cardCallbacks,
    chatInteraction,
    onRespondPermission,
    signMedia,
    stopTurn,
    toolActions,
  } = useChatCardActions({
    activeId,
    agent,
    authRef,
    chat,
    chipsBoardProjectId,
    chipsProjectName,
    demo,
    loadExactUserMessage,
    messageFeedbackTriggerRef,
    newSession,
    openManage,
    openPane,
    openSettings,
    regenerate,
    send,
    sendImplicitRatingRef,
    sending,
    setBoardOpen,
    setBusy,
    setChatError,
    setCollapsed,
    setComposerPrefill,
    setMessageFeedback,
    setMessageReplyTarget,
    setModelPickerOpen,
    setSaveToProject,
    setStreamText,
    setSubscribeOpenSignal,
    sockRef,
    stopRef,
    stoppedTurnRef,
    toast,
  });
  // 详情面板里点开大记录(>1 MiB 定位桩)时,与聊天区共用同一套正文取数与页面缓存。
  const paneDeferredLoader = useMemo<DeferredPayloadLoader>(
    () => ({ peek: cardCallbacks.onPeekTapeRecordPayload, fetch: cardCallbacks.onFetchTapeRecordPayload }),
    [cardCallbacks],
  );

  const composerReplyTo =
    messageReplyTarget && messageReplyTarget.sessionId === activeId
      ? messageReplyTarget.quote
      : null;

  let lastUserText: string | undefined;
  if (demo) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content) {
        lastUserText = messages[i].content;
        break;
      }
    }
  } else {
    for (let i = wsMessages.length - 1; i >= 0; i--) {
      const message = wsMessages[i];
      if (message.role === "user" && message.status !== "queued" && message.text) {
        lastUserText = message.text;
        break;
      }
    }
  }
  // 输入预测(OCV5-375):回答末尾模型写的 next 块 → 输入框浅色预测;打字时按本会话说过的话补全。
  // 设置里关掉时 master 也不再下发这段提示词。demo 不开。
  // 解析器按需加载,不进首屏包(首屏只有输入框的补全和浮层);加载失败就没有预测。
  const inputPredictionOn = useInputPredictionEnabled();
  const [predictInput, setPredictInput] = useState<PredictInput | null>(null);
  useEffect(() => {
    if (demo || !inputPredictionOn || predictInput) return;
    let alive = true;
    void import("./lib/inputPrediction").then(
      (m) => {
        if (alive) setPredictInput(() => m.predictInput);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [demo, inputPredictionOn, predictInput]);
  const inputPrediction = useMemo(
    () => (demo || !inputPredictionOn || !predictInput ? null : predictInput(wsMessages)),
    [demo, inputPredictionOn, predictInput, wsMessages],
  );
  const timelineMessages = wsMessages.filter(
    (message) => message.role !== "user" || message.status !== "queued",
  );
  const queuedOutgoing = wsMessages.filter(
    (message) => message.role === "user" && message.status === "queued",
  );

  // 视频任务能力探测:登录后拉一次。仅在服务端明确回答 available:false 时隐藏入口;
  // 请求失败/未知保持可见(任务中心内部有「暂未开放」兜底),避免网络抖动误藏功能。
  const mediaGateEnabled = !demo && !!user;
  useEffect(() => {
    if (!mediaGateEnabled) {
      setMediaTasksAvailable(null);
      return;
    }
    let cancelled = false;
    api
      .getMediaCapabilities(authRef.current)
      .then((cap) => {
        if (!cancelled) setMediaTasksAvailable(cap?.available !== false);
      })
      .catch(() => {
        if (!cancelled) setMediaTasksAvailable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaGateEnabled]);

  // ChatGPT 直连授权探测:登录后拉一次。与视频任务相反,这里默认隐藏、只有服务端明确
  // enabled:true 才显示入口 —— 未授权用户看不到任何代理信息。
  useEffect(() => {
    if (!mediaGateEnabled) {
      setChatGptProxyEnabled(false);
      setChatGptProxyOpen(false);
      return;
    }
    let cancelled = false;
    api
      .getChatGptProxyAccess(authRef.current)
      .then((access) => {
        if (!cancelled) setChatGptProxyEnabled(access.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setChatGptProxyEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaGateEnabled]);

  // 逐条响应评价 / 隐式负反馈 / 完成脉冲高亮(hooks/useResponseRatings)。放在原先这几个 effect
  // 所在的位置,与其它 effect 的执行顺序不变;send/stopTurn 经 ref 调用隐式上报,引用保持稳定。
  const { ratingCtx, sendImplicitRating } = useResponseRatings({
    demo,
    signedIn: !!user,
    activeId,
    modelId,
    sending,
    authRef,
    sockRef,
    stoppedTurnRef,
  });
  sendImplicitRatingRef.current = sendImplicitRating;

  const {
    beginDirectUserChatScroll,
    endDirectUserChatScroll,
    markUserChatScroll,
    onChatScroll,
    onLoadOlderHistory,
    stickToBottomRef,
  } = useChatScroll({
    activeId,
    archiveLoading,
    archiveRequestTokenRef,
    archiveScrollAnchorRef,
    chat,
    chatScrollParent,
    demo,
    inWorkspace,
    messages,
    scrollRef,
    sending,
    setArchiveError,
    setArchiveLoading,
    settleArchiveAnchor,
    sockRef,
    stopTurn,
    streamText,
    wsSending,
  });

  // ── P7 最小路由接线：URL 单向镜像（会话路径 + 面板 query）/ popstate / 深链恢复 ──
  // 面板深链单选优先级见 activePanelOf（同一时刻仅镜像一个顶层中心）。
  const activePanel = activePanelOf({
    help: tutorialOpen,
    settings: settingsOpen,
    market: marketplaceOpen,
    manage: manageOpen,
    org: orgOpen,
  });
  const routeProjectIds = useMemo(() => projects.map((p) => p.id), [projects]);
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
    activeCommunity: tutorialOpen ? tutorialCommunity : null,
    activeTutorialTab: tutorialOpen ? tutorialTab : null,
    activeTutorialWork: tutorialOpen ? tutorialWork : null,
    activeTutorialStep: tutorialOpen ? tutorialStep : null,
    onPopPanel: (panel, topic, caseId, communityId, extras) => {
      setSettingsOpen(panel === "settings");
      setMarketplaceOpen(panel === "market");
      setManageOpen(panel === "manage");
      setOrgOpen(panel === "org");
      setTutorialOpen(panel === "help");
      if (panel === "help") {
        setTutorialTopic(topic);
        setTutorialCase(caseId);
        setTutorialCommunity(communityId);
        setTutorialTab(extras.tab);
        setTutorialWork(extras.work);
        setTutorialStep(extras.step);
      } else {
        setTutorialTopic(null);
        setTutorialCase(null);
        setTutorialCommunity(null);
        setTutorialTab(null);
        setTutorialWork(null);
        setTutorialStep(null);
      }
    },
    workspace: TASKBOARD_ENABLED && boardOpen ? "board" : projectHome ? "project" : "chat",
    boardView,
    boardTicket: boardTicketId,
    boardTicketType,
    projectRoute: projectHome,
    pendingProject: pendingRouteProject,
    clearPendingProject: () => setPendingRouteProject(null),
    projectIds: routeProjectIds,
    projectListSettled: projectsLoaded,
    onOpenProject: (route) => {
      setBoardOpenState(false);
      setProjectHome(route);
    },
    onPopWorkspace: (ws) => {
      setBoardOpenState(TASKBOARD_ENABLED && ws === "board");
      if (ws !== "project") setProjectHome(null);
    },
    onPopBoardParams: (nextView, ticket, ticketType) => {
      setBoardView(nextView);
      setBoardTicketId(ticket);
      setBoardTicketType(ticketType);
    },
  });

  // 启动续期检查中:极简 splash(避免"闪一下首页又跳工作区"的割裂;通常 <300ms)。
  if (!demo && booting) {
    return <BootSplash />;
  }
  if (!demo && pendingAccount) return <LazyBoundary fallback={<SplashFallback />}>
    <AccountSwitchNotice name={pendingAccount.displayName} ready={accountSwitchReady} onAccept={acceptAccountSwitch} onRetry={retryBoot} />
  </LazyBoundary>;
  // A transient boot failure is not a logout. Surface the dedicated recovery
  // action immediately instead of hiding it behind the ordinary landing page.
  if (!demo && view === "home" && !authRecoveryAvailable && !desktopEnroll) {
    return (
      <>
        <LazyBoundary fallback={<SplashFallback />}>
          <Landing
            onStart={(prompt) => {
              // 首页输入框 / 场景卡带来的任务:沿用案例的 pending 键,进入工作区后预填、不自动发送。
              if (prompt) {
                try {
                  sessionStorage.setItem(
                    "oc_v5_pending_case",
                    JSON.stringify({ source: "landing", starterPrompt: prompt }),
                  );
                } catch {
                  /* quota / private mode */
                }
              }
              // 「免费开始」直达注册表，少一次「立即注册」点击。
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
        {tutorialOpen && (
          <LazyBoundary fallback={<DialogFallback />}>
            <TutorialCenter
              open={tutorialOpen}
              topicId={tutorialTopic}
              caseId={tutorialCase}
              communityId={tutorialCommunity}
              browseView={tutorialTab ?? "showcase"}
              onBrowseViewChange={(next) => setTutorialTab(next === "showcase" ? null : next)}
              signatureWorkId={tutorialWork}
              onSignatureWorkChange={setTutorialWork}
              stepIndex={tutorialStep}
              onTopicChange={(id) => {
                // 用户自己换篇：深链带来的目标步骤不再适用。
                if (id !== tutorialTopic) setTutorialStep(null);
                setTutorialTopic(id);
                setTutorialCase(null);
                setTutorialCommunity(null);
              }}
              onCaseChange={(id) => {
                setTutorialCase(id);
                setTutorialTopic(null);
                setTutorialCommunity(null);
                setTutorialStep(null);
              }}
              onShowCaseGallery={() => {
                setTutorialCase(null);
                setTutorialTopic(null);
                setTutorialCommunity(null);
                setTutorialStep(null);
              }}
              onCommunityChange={(id) => {
                setTutorialCommunity(id);
                if (id) {
                  setTutorialTopic(null);
                  setTutorialCase(null);
                  setTutorialStep(null);
                }
              }}
              caseActionLabel="登录后试用"
              onRunCase={runTutorialCase}
              auth={auth}
              onRequireLogin={() => {
                setTutorialOpen(false);
                setTutorialCommunity(null);
                setAuthMode("login");
                setView("app");
              }}
              activeSessionId={activeId ?? null}
              sessionMessages={wsMessages}
              sending={sending}
              sessionTitle={
                activeSess?.title ?? sessions.find((session) => session.id === activeId)?.title ?? ""
              }
              sessionProjectId={sessions.find((session) => session.id === activeId)?.projectId ?? null}
              onClose={() => {
                setTutorialOpen(false);
                setTutorialCommunity(null);
                setTutorialTab(null);
                setTutorialWork(null);
                setTutorialStep(null);
              }}
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
      // 首页(Landing)固定深色,登录页跟随系统主题:系统浅色时直切会闪白。
      // 外层容器挂 animate-in(styles.css 的 fade-up 0.32s)把硬切柔化成整页淡入。
      <div className="h-full animate-in">
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
            if (desktopEnroll) {
              window.location.assign("/");
              return;
            }
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
      </div>
    );
  }

  if (desktopEnroll && auth) {
    return <DesktopEnrollPage auth={auth} />;
  }

  const showEmpty = demo ? messages.length === 0 && !busy : wsMessages.length === 0 && !wsSending;
  // ── 输入框上方的全局横幅栈(shell 审计 S-06)──────────────────────────────
  // 五种横幅原先各自按条件挂载、互不知情,断线 + 休眠 + 新版本 + 发送失败同时成立时 390px
  // 屏上横幅吃掉 ~560px。这里先算出"此刻成立的有哪些",交给 resolveBanners 按优先级裁决:
  // 同屏最多 2 条,其余折叠成一行「还有 N 条提示」。移动端(<md)的连接条走 Composer 的
  // banner 插槽钉在输入框上方(软键盘不会把它顶走),不进这个栈。
  const activeBannerKinds: BannerKind[] = [];
  if (chatError) activeBannerKinds.push("error");
  if (!gated && connBanner && isMdViewport) activeBannerKinds.push("connection");
  if (!demo && gate.phase.kind === "dormant") activeBannerKinds.push("dormant");
  if (!demo && updateBannerVisible) activeBannerKinds.push("update");
  if (!demo && !gated && activeSess?._turnCostReminderCredits) activeBannerKinds.push("cost");
  const bannerStack = resolveBanners(activeBannerKinds, bannersExpanded);
  const showBanner = (kind: BannerKind) => bannerStack.visible.includes(kind);

  // 更早对话仍只靠显式按钮，滚动不发请求。
  // 本轮处理步骤按游标自动补齐，不在过程区放「加载更早的处理步骤」。
  // demo / 无选中会话时不下发(MessageList 退化为纯本地翻页)。
  const messageListArchive: MessageListArchive | undefined =
    !demo && activeId
      ? {
          hasMore: activeSess?._timelineHasMore === true,
          loading: archiveLoading,
          error: archiveError,
          onLoadOlder: onLoadOlderHistory,
          liveHasMoreBefore: activeSess?._liveUnitsHasMoreBefore === true,
          liveUnitsCursor: activeSess?._liveUnitsBeforeCursor ?? null,
          onLoadOlderLiveUnits: () => chat.loadOlderLiveUnits(activeId),
        }
      : undefined;

  // 侧栏公共 props：桌面内联与移动抽屉两处复用。余额（balanceCents）本期不展示（P3.5 计费中心）。
  // rename/delete 的数据收口（三持有方）在 useSessionList。
  const sidebarProps = {
    sessions,
    // 项目主页时侧栏高亮项目行，而不是背后仍选中的会话。
    activeId: homeProject ? undefined : activeId,
    activeProjectId: homeProject ? homeProject.id : null,
    onOpenProject: openProject,
    user,
    credits: user?.credits ?? null,
    onOpenAccount: demo ? undefined : () => openSettings(),
    onOpenFeedback: demo ? undefined : () => openSettings("feedback"),
    onNew: handleNew,
    onNewWithAgent: demo ? undefined : () => { handleNew(); setPickerOpen(true); },
    onRename: renameSessionPrompt,
    onDelete: deleteSessionConfirm,
    onTogglePin: togglePinSession,
    onMoveToProject: moveSessionToProject,
    projects,
    collapsedProjectIds,
    onToggleProjectCollapsed: toggleProjectCollapsed,
    onCreateProject: () => setCreateProjectFrom({}),
    onCreateProjectFromSession: (sess: Session) => setCreateProjectFrom({ sessionId: sess.id, title: sess.title }),
    onRenameProject: renameProjectPrompt,
    onDeleteProject: deleteProjectConfirm,
    onToggleProjectPin: demo ? undefined : (p: ChatProject) => void setProjectPinned(p, !p.pinnedAt),
    onArchiveProject: demo ? undefined : (p: ChatProject) => void setProjectArchived(p, true),
    onOpenProjectArchive: demo ? undefined : () => setProjectArchiveOpen(true),
    isSending: (id: string) => !demo && chat.isSending(id),
    liveTerminal,
    socketVersion: chat.version,
    onLogout: demo ? undefined : logout,
    onOpenManage: demo ? undefined : () => openManage(DEFAULT_MANAGE_TAB),
    onOpenMarketplace: demo ? undefined : () => openMarketplace("browse"),
    onOpenTutorial: demo ? undefined : () => openTutorial(),
    onOpenMediaTasks:
      demo || mediaTasksAvailable === false ? undefined : () => setMediaTasksOpen(true),
    onOpenChatGptProxy: !demo && chatGptProxyEnabled ? () => setChatGptProxyOpen(true) : undefined,
    // 「API 接入」:admin-only rollout(与后端 requireAdmin / strategy Layer 2 同门)。
    onOpenApiAccess: !demo && user?.role === "admin" ? () => openSettings("api-access") : undefined,
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
    onOpenBoard: demo || !TASKBOARD_ENABLED ? undefined : () => setBoardOpen(true),
    boardActive: TASKBOARD_ENABLED && boardOpen,
    unreadIds: unreadSessions.unreadIds,
    onMarkRead: unreadSessions.markRead,
    onOpenProjectSettings: (p: ChatProject) => {
      setUngroupedAssetsOpen(false);
      setProjectSettings(p);
    },
    onOpenProjectAssets: () => {
      setProjectSettings(null);
      setUngroupedAssetsOpen(true);
    },
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
    // sidebar-B S-08：加载更早会话失败时侧栏底部给「点击重试」。
    loadMoreError,
    // sidebar-B S-05：拖宽把手可 Tab 聚焦并用键盘调宽。
    onResizeKeyDown: sidebarWidth.onResizeKeyDown,
    onLoadArchived: loadArchivedSessions,
    loadingArchived,
    onSearchMessages: searchSessionMessages,
    onOpenPalette: () => setPaletteOpen(true),
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
    <ArtifactInspectContext.Provider value={artifactInspect}>
    {/* tools T-18:详情面板当前查看的那条 tool 消息 → 源卡片选中态。与 open 回调分开成独立 context,
        面板开合只重渲消费它的 ToolCard,不打穿 MessageList 的 sig-memo(tool/context.ts 注释)。 */}
    <ArtifactInspectActiveContext.Provider value={paneShown ? paneActive : null}>
    <ImageEditActionsContext.Provider value={imageEditActions}>
    {/* safe-px:横屏侧刘海安全区(竖屏为 0) */}
    <ProjectScopeProvider
      auth={!demo && auth ? auth : null}
      chatProjects={projects}
      userId={user?.id}
    >
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-fg safe-px">
      {/* 桌面：内联侧栏（可折叠）。窄屏隐藏，改用抽屉。 */}
      {!collapsed && (
        <div className="hidden md:contents">
          <Sidebar
            {...sidebarProps}
            onSelect={(id) => {
              setDraftProject(null);
              setBoardOpen(false);
              selectSession(id);
            }}
            onNew={() => {
              setBoardOpen(false);
              handleNew();
            }}
            onNewWithAgent={
              demo
                ? undefined
                : () => {
                    setBoardOpen(false);
                    handleNew();
                    setPickerOpen(true);
                  }
            }
            onNewInProject={(projectId) => {
              setBoardOpen(false);
              newSessionInProject(projectId);
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
            setDraftProject(null);
            setBoardOpen(false);
            selectSession(id);
            setMobileNavOpen(false);
          }}
          onNew={() => {
            setBoardOpen(false);
            handleNew();
            setMobileNavOpen(false);
          }}
          onNewWithAgent={
            demo
              ? undefined
              : () => {
                  setBoardOpen(false);
                  handleNew();
                  setPickerOpen(true);
                  setMobileNavOpen(false);
                }
          }
          onNewInProject={(projectId) => {
            setBoardOpen(false);
            newSessionInProject(projectId);
            setMobileNavOpen(false);
          }}
          onOpenProject={(projectId) => {
            openProject(projectId);
            setMobileNavOpen(false);
          }}
          onCollapse={() => setMobileNavOpen(false)}
          // sidebar-B S-06：抽屉里同一按钮语义是「关闭导航」，读屏名与桌面「折叠侧栏」区分。
          collapseLabel="关闭导航"
          onOpenBoard={
            demo || !TASKBOARD_ENABLED
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
          onOpenPalette={closeMobileThen(sidebarProps.onOpenPalette)}
          onOpenMediaTasks={closeMobileThen(sidebarProps.onOpenMediaTasks)}
          onOpenChatGptProxy={closeMobileThen(sidebarProps.onOpenChatGptProxy)}
          onOpenApiAccess={closeMobileThen(sidebarProps.onOpenApiAccess)}
          onLogout={closeMobileThen(sidebarProps.onLogout)}
          width={undefined}
          onResizeStart={undefined}
          resizing={false}
        />
      </Sheet>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {TASKBOARD_ENABLED && boardOpen && !demo && auth ? (
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
              onOpenProjectSettings={(projectId) => {
                const p = projects.find((x) => x.id === projectId);
                if (!p) return;
                setUngroupedAssetsOpen(false);
                setProjectSettings(p);
              }}
            />
          </LazyBoundary>
        ) : homeProject && projectHome ? (
          <LazyBoundary fallback={<SplashFallback />}>
            <ProjectHome
              project={homeProject}
              tab={projectHome.tab}
              onTabChange={(tab) => setProjectHome({ projectId: homeProject.id, tab })}
              sessions={sessions}
              demo={demo}
              auth={auth}
              authSession={authRef.current}
              onStart={(text) => startInProject(homeProject.id, text)}
              onNewSession={() => {
                setBoardOpen(false);
                newSessionInProject(homeProject.id);
              }}
              onOpenSession={(id) => {
                if (!sessions.some((s) => s.id === id)) return;
                setDraftProject(null);
                setBoardOpen(false);
                selectSession(id);
              }}
              onOpenSettings={() => {
                setUngroupedAssetsOpen(false);
                setProjectSettings(homeProject);
              }}
              onRename={() => void renameProjectPrompt(homeProject)}
              onDelete={() => void deleteProjectConfirm(homeProject)}
              onOpenMobileNav={() => setMobileNavOpen(true)}
              onLoadArchived={() => void loadArchivedSessions()}
              onPrepareBoard={
                demo || !TASKBOARD_ENABLED || !homeProject.boardProjectId
                  ? undefined
                  : () => prepareProjectBoard(homeProject.boardProjectId as string)
              }
              recipeSchedule={serverFeatures.recipeSchedule}
              onShowSurface={(surface) => {
                setProjectHome(null);
                if (surface === "board") setBoardOpen(true);
                else openManage(surface);
              }}
              loadingArchived={loadingArchived}
              sidebarCollapsed={collapsed}
              onExpandSidebar={() => setCollapsed(false)}
            />
          </LazyBoundary>
        ) : (
        <>
        {/* 会话标题 h1(读屏定位当前会话;视觉已由顶栏表达,故 sr-only。探针:工作区 h1=0)。 */}
        <h1 className="sr-only">{activeSess?.title || "新对话"}</h1>
        <ChatHeader
          agent={agent}
          onAgentClick={() => setPickerOpen(true)}
          projectBreadcrumb={(() => {
            const pid = sessions.find((s) => s.id === activeId)?.projectId;
            if (!pid) return null;
            const chat = projects.find((p) => p.id === pid);
            return chat ? { chatName: chat.name } : null;
          })()}
          projectSuggestion={(() => {
            if (!serverFeatures.unfiledSuggest || !user?.id || !activeId) return null;
            const active = sessions.find((s) => s.id === activeId);
            if (!active || active.projectId || active.archived || dismissedSuggestions.has(active.id)) return null;
            const hit = suggestProjectForChat(active, sessions, projects);
            const target = hit ? projects.find((p) => p.id === hit.projectId) : undefined;
            if (!target) return null;
            const uid = user.id;
            return {
              name: target.name,
              onAccept: () => moveSessionToProject(active, target.id),
              onDismiss: () => {
                dismissSuggestion(uid, active.id);
                setDismissedSuggestions((cur) => new Set(cur).add(active.id));
              },
            };
          })()}
          onOpenProjectScope={() => {
            const pid = sessions.find((s) => s.id === activeId)?.projectId;
            if (pid) openProject(pid);
          }}
          models={models}
          lockedModels={lockedModels}
          selectedModelId={modelId}
          onSelectModel={selectModel}
          onLockedSelect={demo ? undefined : handleLockedSelect}
          modelsLoading={modelsLoading || modelSwitchPreparing}
          effortSupported={effortSupported}
          effortActive={effortActive}
          onSelectEffort={demo ? undefined : setSessionEffort}
          contextTier={contextTier}
          onSelectContextTier={demo ? undefined : setContextTier}
          serviceTier={serviceTier}
          onSelectServiceTier={demo ? undefined : setServiceTier}
          modelPickerOpen={modelPickerOpen}
          onModelPickerOpenChange={setModelPickerOpen}
          // 团队模式知情指示:与 send 的生效条件同构(teamMode 只对 main 生效,
          // 见上方 send 的 agent.id === "main" 判定)——顶栏所见 = 实际所发。
          teamModeActive={!demo && teamMode && agent.id === "main"}
          onDisableTeamMode={() => setTeamMode(false)}
          advisorModeActive={!demo && collabMode === "advisor" && agent.id === "main"}
          advisorModelLabel={
            collabMode === "advisor" && agent.id === "main"
              ? collabUi.advisorModel
              : undefined
          }
          onDisableAdvisorMode={() => setCollabMode("solo")}
          credits={demo ? null : (user?.credits ?? null)}
          onOpenBilling={demo ? undefined : () => openSettings()}
          sidebarCollapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNew={handleNew}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenInbox={demo ? undefined : () => setInboxOpen(true)}
          onOpenFind={demo ? undefined : () => setFindOpen(true)}
          onShare={demo ? undefined : () => setShareOpen(true)}
          onTogglePane={paneAvailable && !demo ? togglePane : undefined}
          paneOpen={paneShown}
          unreadCount={inbox.unreadCount}
          sessionUnreadCount={unreadSessions.unreadIds.size}
        />
        {!demo && auth && authRecoveryAvailable && <LazyBoundary fallback={null}>
          <IdentityRecoveryNotice onRetry={retryBoot} />
        </LazyBoundary>}

        {!demo && repo.showBanner && repo.selection?.selected && (
          <RepoStatusBanner
            selection={repo.selection}
            progressPct={repo.progressPct}
            onDismiss={repo.dismissBanner}
            onRetry={() => {
              const sel = repo.selection;
              if (sel?.selected) void repo.confirm(sel.owner, sel.repo, sel.branch);
            }}
          />
        )}

        <div
          ref={bindChatScroll}
          onScroll={onChatScroll}
          onWheel={markUserChatScroll}
          onTouchStart={beginDirectUserChatScroll}
          onTouchMove={beginDirectUserChatScroll}
          onTouchEnd={endDirectUserChatScroll}
          onTouchCancel={endDirectUserChatScroll}
          onPointerDown={beginDirectUserChatScroll}
          onPointerUp={endDirectUserChatScroll}
          onPointerCancel={(event) => {
            if (event.pointerType !== "touch") endDirectUserChatScroll();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType !== "touch") endDirectUserChatScroll();
          }}
          onKeyDown={markUserChatScroll}
          className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-font-size={composerPrefs.fontSize}
        >
          {gated ? (
            <AgentGate
              phase={gate.phase}
              onOpen={gate.open}
              onRetry={gate.check}
              onTopUp={() => {
                openSettings("account");
                setSubscribeOpenSignal((n) => n + 1);
              }}
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
              userName={demo ? undefined : greetingName(user)}
              onPrefill={(text) => setComposerPrefill({ text, nonce: Date.now() })}
              onChangeAgent={() => setPickerOpen(true)}
              onOpenGoal={demo ? undefined : () => setGoalOpenNonce(Date.now())}
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
                  processDisclosure
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
                  followBottomRef={stickToBottomRef}
                  find={findOpen ? { onClose: () => setFindOpen(false) } : undefined}
                />
              </SessionTimelineBoundary>
            </ResponseRatingProvider>
          )}
        </div>

        {/* composer-safe-b:底部 Home 指示条安全区(叠在原 pb-3 上),否则发送区被遮 */}
        <div className="shrink-0 composer-safe-b">
          {/* 任务列表 HUD:钉在输入框上方,始终可见(取代会滚走的 inline TodoWrite 卡)。
              初始展开全部 → ~3s 自动折叠成「正在执行的一条」;无任务或本轮已收口时组件自渲染
              null(收口后由 MessageRenderer 的 inline 只读 TodoWrite/plan 卡兜底)。 */}
          {!demo && !gated && (
            <PinnedGoalBar messages={timelineMessages} />
          )}
          {!demo && !gated && (
            <PinnedTaskTracker
              todos={extractLatestTodos(timelineMessages)}
              active={wsSending}
              settled={currentTurnSettled(timelineMessages)}
              tokenUsage={activeSess?._liveTurnUsage?.usage}
            />
          )}
          {!demo && !gated && (
            <PinnedDelegateTracker
              items={inflightDelegates.items}
              onDismiss={inflightDelegates.dismiss}
              // 父轮已结束时不再给「停止本轮」(hud H-18 接线):stopTurn 此时无可停之物,按了没反应。
              onStop={wsSending ? stopTurn : undefined}
            />
          )}
          {!demo && !gated && (
            <div
              id="pending-approval-bar-slot"
              className="mx-auto mb-2 max-w-3xl px-4 empty:mb-0 empty:hidden"
            />
          )}
          {/* 以下五条横幅的显隐由 bannerStack(resolveBanners)统一裁决,渲染顺序即优先级:
              发送失败 > 连接状态 > 容器休眠 > 新版本 > 成本提醒;超出 2 条的折叠成一行。 */}
          {showBanner("error") && chatError && (
            <ErrorBanner
              error={chatError}
              onRetry={() => {
                const t = chatError.retryText;
                setChatError(null);
                send(t);
              }}
              onDismiss={() => setChatError(null)}
              onSwitchModel={demo ? undefined : () => setModelPickerOpen(true)}
            />
          )}
          {/* WS 连接状态条三态（离线 / 环境启动中 / 服务端重连中，见 deriveConnBanner）。仅非 demo。
              移动端(< md)软键盘弹出会压缩可视视口,流式布局里的横幅会被顶出屏幕;改走
              Composer 的 banner 插槽钉在输入框上方,始终可见。桌面(md+)保持原流式位置。 */}
          {showBanner("connection") && connBanner && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert
                tone={connBanner.tone}
                action={
                  connBanner.tone === "warning" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => chat.retryConnectNow()}
                    >
                      立即重连
                    </Button>
                  ) : undefined
                }
              >
                {connBanner.text}
              </Alert>
            </div>
          )}
          {showBanner("dormant") && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <Alert tone="info">容器已休眠，发送消息后将自动唤醒。</Alert>
            </div>
          )}
          {/* 版本更新横幅:仅 governor 判定不能自动软刷时出现(自动刷成功的用户无感)。*/}
          {showBanner("update") && <UpdateBanner />}
          {showBanner("cost") && activeSess?._turnCostReminderCredits && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              <TurnCostReminder
                credits={activeSess._turnCostReminderCredits}
              />
            </div>
          )}
          {(bannerStack.hidden.length > 0 || bannerStack.canCollapse) && (
            <div className="mx-auto mb-2 max-w-3xl px-4">
              {/* 折叠条不走 Alert 的 action 槽:那个槽在 <sm 会整行换到第二行右对齐(给「重试」类
                  动作设计的),折叠条要的是"一行文字 + 行内切换键",在 390px 上两行会把省下来的
                  高度又吃回去。 */}
              <Alert tone="info" density="compact" live="off" data-testid="banner-stack-collapsed">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {bannersExpanded ? "已展开全部提示" : collapsedBannersLabel(bannerStack.hidden.length)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="-my-1.5 -mr-1.5 shrink-0"
                    aria-expanded={bannersExpanded}
                    onClick={() => setBannersExpanded((v) => !v)}
                  >
                    {bannersExpanded ? "收起" : "展开"}
                  </Button>
                </div>
              </Alert>
            </div>
          )}
          {!demo && !gated && queuedOutgoing.length > 0 && (
            <QueuedSendList
              messages={queuedOutgoing}
              onEdit={(message) => cardCallbacks.onEditQueued?.(message)}
              onDelete={(message) => cardCallbacks.onDeleteQueued?.(message)}
              onSendNow={(message) => cardCallbacks.onSendQueuedNow?.(message)}
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
            environmentPreparing={!demo && chat.provisioning}
            banner={
              !gated && connBanner && !isMdViewport ? (
                <div className="mb-2">
                  <Alert
                    tone={connBanner.tone}
                    action={
                      connBanner.tone === "warning" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => chat.retryConnectNow()}
                        >
                          立即重连
                        </Button>
                      ) : undefined
                    }
                  >
                    {connBanner.text}
                  </Alert>
                </div>
              ) : undefined
            }
            placeholder={`和「${agent.name}」对话…`}
            onUpload={demo ? undefined : uploadMedia}
            getVoiceToken={demo ? undefined : () => authRef.current.snapshot().token}
            prefill={composerPrefill}
            lastUserText={lastUserText}
            prediction={inputPrediction}
            draftKey={accountDraftKey(activeId ?? NEW_COMPOSER_DRAFT_KEY, user?.id)}
            replyTo={composerReplyTo}
            onCancelReply={() => setMessageReplyTarget(null)}
            repoSelection={demo ? null : repo.selection}
            onOpenRepo={demo ? undefined : openRepo}
            goal={activeSess?.goalState}
            onSetGoal={demo ? undefined : setSessionGoal}
            onGoalAction={demo ? undefined : transitionSessionGoal}
            sendKey={composerPrefs.sendKey}
            fontSize={composerPrefs.fontSize}
            goalOpenRequest={goalOpenNonce}
            projectSlot={
              // 仍是未发首条的草稿时可改归属:包括被 GitHub/目标提前物化成空会话行的草稿。
              activeId && !sessions.some((x) => x.id === activeId && x.messageCount === 0 && !x.projectId) ? undefined : (
                <ComposerProjectPill
                  projects={projects}
                  projectId={draftProjectId}
                  editable
                  onPick={setDraftProject}
                  onOpen={openProject}
                />
              )
            }
          />
        </div>
        </>
        )}
      </main>

      {/* 详情面板(右侧第三栏)。宽屏:与 Sidebar|main 并列的内联 aside;
          更窄:贴底 Sheet(共用 InspectorPanelContent)。任务看板 / 项目主页占据 main 时不渲染。 */}
      {paneInline && (
        <InspectorPanel
          key={activeId ?? "demo"}
          messages={wsMessages}
          version={chat.version}
          running={wsSending}
          request={paneRequestHere}
          deferredLoader={paneDeferredLoader}
          focusNonce={paneRequestHere?.nonce}
          onClose={() => setPaneOpen(false)}
          onActiveChange={setPaneActive}
          width={paneWidth.width}
          resizing={paneWidth.resizing}
          widthMin={DETAIL_PANE_WIDTH.min}
          widthMax={DETAIL_PANE_WIDTH.max}
          onResizeStart={paneWidth.onResizeStart}
          onResizeKeyDown={paneWidth.onResizeKeyDown}
        />
      )}
      <Sheet
        open={paneAvailable && paneSheetOpen && !isWideViewport}
        onOpenChange={(o) => {
          if (!o) setPaneSheetOpen(false);
        }}
        side="bottom"
        srTitle="详情面板"
      >
        {paneSheetOpen && (
          <div className="flex h-[80dvh] min-h-0 flex-col">
            <InspectorPanelContent
              key={activeId ?? "demo"}
              messages={wsMessages}
              version={chat.version}
              running={wsSending}
              request={paneRequestHere}
              deferredLoader={paneDeferredLoader}
              onClose={() => setPaneSheetOpen(false)}
              onActiveChange={setPaneActive}
            />
          </div>
        )}
      </Sheet>

      <AppDialogs
        activeId={activeId}
        activeSess={activeSess}
        agent={agent}
        applyConversationPreferences={applyConversationPreferences}
        auth={auth}
        authRef={authRef}
        authed={authed}
        boardOpen={boardOpen}
        chat={chat}
        chatGptProxyEnabled={chatGptProxyEnabled}
        chatGptProxyOpen={chatGptProxyOpen}
        chatViewActiveId={chatViewActiveId}
        collabAsDefault={collabAsDefault}
        collabMode={collabMode}
        collabSaveError={collabSaveError}
        collabUi={collabUi}
        createProject={createProject}
        createProjectFrom={createProjectFrom}
        createProjectMounted={createProjectMounted}
        demo={demo}
        draftProjectId={draftProjectId}
        handleNew={handleNew}
        homeProject={homeProject}
        inbox={inbox}
        inboxMounted={inboxMounted}
        inboxOpen={inboxOpen}
        listDeletedProjects={listDeletedProjects}
        liveMediaJob={liveMediaJob}
        manageAutoAuthorizePluginSlug={manageAutoAuthorizePluginSlug}
        manageOpen={manageOpen}
        manageTab={manageTab}
        marketplaceBrowseKind={marketplaceBrowseKind}
        marketplaceOpen={marketplaceOpen}
        marketplaceTab={marketplaceTab}
        mediaTasksOpen={mediaTasksOpen}
        messageFeedback={messageFeedback}
        messageFeedbackMounted={messageFeedbackMounted}
        messageFeedbackTriggerRef={messageFeedbackTriggerRef}
        modelId={modelId}
        models={models}
        moveSessionToProject={moveSessionToProject}
        myAgents={myAgents}
        newSession={newSession}
        newSessionInProject={newSessionInProject}
        openManage={openManage}
        openMarketplace={openMarketplace}
        openRepo={openRepo}
        openTutorial={openTutorial}
        orgOpen={orgOpen}
        orgSection={orgSection}
        paletteMounted={paletteMounted}
        paletteOpen={paletteOpen}
        paletteSearchAssets={paletteSearchAssets}
        paletteSearchMessages={paletteSearchMessages}
        paletteUserId={paletteUserId}
        persistCollab={persistCollab}
        pickerOpen={pickerOpen}
        prepareProjectBoard={prepareProjectBoard}
        projectArchiveMounted={projectArchiveMounted}
        projectArchiveOpen={projectArchiveOpen}
        projectSettings={projectSettings}
        projectSettingsMounted={projectSettingsMounted}
        projectSettingsOpen={projectSettingsOpen}
        projects={projects}
        refreshMe={refreshMe}
        refreshMyAgents={refreshMyAgents}
        repo={repo}
        repoModalMounted={repoModalMounted}
        repoModalOpen={repoModalOpen}
        restoreProject={restoreProject}
        saveToProject={saveToProject}
        saveToProjectMounted={saveToProjectMounted}
        selectSession={selectSession}
        sending={sending}
        sessions={sessions}
        setAgent={setAgent}
        setAuthMode={setAuthMode}
        setBoardOpen={setBoardOpen}
        setBoardOpenState={setBoardOpenState}
        setChatError={setChatError}
        setChatGptProxyOpen={setChatGptProxyOpen}
        setCollabAsDefault={setCollabAsDefault}
        setCollabMode={setCollabMode}
        setComposerPrefill={setComposerPrefill}
        setCreateProjectFrom={setCreateProjectFrom}
        setDraftProject={setDraftProject}
        setInboxOpen={setInboxOpen}
        setManageAutoAuthorizePluginSlug={setManageAutoAuthorizePluginSlug}
        setManageOpen={setManageOpen}
        setManageTab={setManageTab}
        setMarketplaceOpen={setMarketplaceOpen}
        setMarketplaceTab={setMarketplaceTab}
        setMediaTasksOpen={setMediaTasksOpen}
        setMessageFeedback={setMessageFeedback}
        setMyAgents={setMyAgents}
        setOrgOpen={setOrgOpen}
        setPaletteOpen={setPaletteOpen}
        setPendingRouteProject={setPendingRouteProject}
        setPickerOpen={setPickerOpen}
        setProjectArchiveOpen={setProjectArchiveOpen}
        setProjectArchived={setProjectArchived}
        setProjectHome={setProjectHome}
        setProjectSettings={setProjectSettings}
        setRepoModalOpen={setRepoModalOpen}
        setSaveToProject={setSaveToProject}
        setSettingsOpen={setSettingsOpen}
        setShareOpen={setShareOpen}
        setTeamMode={setTeamMode}
        setTheme={setTheme}
        setUngroupedAssetsOpen={setUngroupedAssetsOpen}
        setView={setView}
        settingsFeedbackContext={settingsFeedbackContext}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        shareOpen={shareOpen}
        subscribeOpenSignal={subscribeOpenSignal}
        teamMode={teamMode}
        theme={theme}
        toast={toast}
        ungroupedAssetsOpen={ungroupedAssetsOpen}
        updateProject={updateProject}
        user={user}
        wsMessages={wsMessages}
      />{tutorialOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <TutorialCenter
            open={tutorialOpen}
            topicId={tutorialTopic}
            caseId={tutorialCase}
            communityId={tutorialCommunity}
            browseView={tutorialTab ?? "showcase"}
            onBrowseViewChange={(next) => setTutorialTab(next === "showcase" ? null : next)}
            signatureWorkId={tutorialWork}
            onSignatureWorkChange={setTutorialWork}
            stepIndex={tutorialStep}
            onTopicChange={(id) => {
              // 用户自己换篇：深链带来的目标步骤不再适用。
              if (id !== tutorialTopic) setTutorialStep(null);
              setTutorialTopic(id);
              setTutorialCase(null);
              setTutorialCommunity(null);
            }}
            onCaseChange={(id) => {
              setTutorialCase(id);
              setTutorialTopic(null);
              setTutorialCommunity(null);
              setTutorialStep(null);
            }}
            onShowCaseGallery={() => {
              setTutorialCase(null);
              setTutorialTopic(null);
              setTutorialCommunity(null);
              setTutorialStep(null);
            }}
            onCommunityChange={(id) => {
              setTutorialCommunity(id);
              if (id) {
                setTutorialTopic(null);
                setTutorialCase(null);
                setTutorialStep(null);
              }
            }}
            caseActionLabel="带着指令去对话"
            onRunCase={runTutorialCase}
            auth={auth}
            onRequireLogin={() => {
              setAuthMode("login");
            }}
            activeSessionId={activeId ?? null}
            sessionMessages={wsMessages}
            sending={sending}
            sessionTitle={
              activeSess?.title ?? sessions.find((session) => session.id === activeId)?.title ?? ""
            }
            sessionProjectId={sessions.find((session) => session.id === activeId)?.projectId ?? null}
            onClose={() => {
              setTutorialOpen(false);
              setTutorialCommunity(null);
              setTutorialTab(null);
              setTutorialWork(null);
              setTutorialStep(null);
            }}
            actionState={(feature) => resolveTutorialAction(feature, tutorialActionContext)}
            onRunAction={runTutorialAction}
          />
        </LazyBoundary>
      )}
      {confirmDialogEl}
      {promptTextEl}
      {/* 圈选编辑器是懒块:有 source 才挂载(编辑器自身在 !open 时即重置全部状态、无退场动画,
          条件挂载与原先常驻+open 显隐等价);关闭即卸载,下次打开走已缓存的模块。 */}
      {imageAnnotationSource && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ImageAnnotationEditor
            source={imageAnnotationSource}
            open
            onOpenChange={(next) => !next && setImageAnnotationSource(null)}
            onSubmit={submitImageEdit}
          />
        </LazyBoundary>
      )}
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
    </ProjectScopeProvider>
    </ImageEditActionsContext.Provider>
    </ArtifactInspectActiveContext.Provider>
    </ArtifactInspectContext.Provider>
    </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>
    </MediaSignProvider>
  );
}

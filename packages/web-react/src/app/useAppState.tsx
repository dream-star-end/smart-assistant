/**
 * App state, session, auth and model selection: the first half of the App() hook section.
 *
 * Split out of App() verbatim (FINDINGS §7.6 A1, OCV5-472): App calls
 * useAppActions(useAppState()) where its hook section used to be, so React sees the same hooks in
 * the same order and every value is the same binding as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { appUpdate } from '../lib/appUpdate'
import {
  cursorModelSupportsContextTier,
  supportsFastServiceTier,
  isCodexEngineModel,
  type MessageReplyQuote,
} from '@openclaude/protocol'
import type { AuthMode } from '../components/AuthGate'
import { resetComposerAttachmentCache } from '../components/Composer'
import { teardownComposerDrafts } from '../lib/composerDraft'
import type { ImageAnnotationSource } from '../components/ImageAnnotationEditor'
import type { ImageCommentSubmit, ImageEditSubmit } from '../components/chat/imageEditActions'
import type { ChatError } from '../components/ErrorBanner'
import { sessionTitleFromText } from '../lib/sessionTitle'
import { pushPaletteRecent } from '../lib/paletteRecents'
import { DEFAULT_MANAGE_TAB, type ManageTab } from '../lib/manageTabs'
import type { SettingsSection } from '../components/SettingsCenter'
import type { OrgSection } from '../components/OrgCenter'
import type { MarketplaceKind, MarketplaceTab } from '../components/MarketplaceCenter'
import type { VisibleVirtualRowAnchor } from '../components/chat/archivePaging'
import type { FeedbackContext } from '../components/chat/cards'
import {
  DETAIL_PANE_WIDTH,
  type PaneRequest,
  type PaneTab,
  readDetailPaneOpen,
  writeDetailPaneOpen,
} from '../components/InspectorPanel'
import type { ToolLike } from '../components/tool/format'
import { useConfirm, usePrompt } from '../components/ui'
import {
  type BoardViewParam,
  parseBoardView,
  parseBoardTicket,
  parseBoardTicketType,
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
  type ProjectRoute,
  type TutorialTab,
  type TutorialWorkId,
} from '../hooks/useAppRoute'
import { useAuth } from '../hooks/useAuth'
import { genWsSessionId, useSessionList } from '../hooks/useSessionList'
import { useChatProjects } from '../hooks/useChatProjects'
import { useUnreadSessions } from '../hooks/useUnreadSessions'
import { useSidebarWidth } from '../hooks/useSidebarWidth'
import { useLocalComposerPrefs } from '../hooks/useLocalComposerPrefs'
import { useMdViewport, useWideViewport } from '../hooks/useMdViewport'
import { useResizableWidth } from '../hooks/useResizableWidth'
import { readCollapsed, writeCollapsed } from '../lib/sidebarCollapsed'
import type { UseChatSocket } from '../hooks/useChatSocket'
import type { ImplicitReason } from '../hooks/useResponseRatings'
import { useSessionEngineOptions } from '../hooks/useSessionEngineOptions'
import { useTheme } from '../hooks/useTheme'
import { useToast } from '../components/ui'
import { imageByteCache } from '../lib/chat/imageBytes'
import { containerPreviewHrefFromTarget } from '../lib/containerPreview'
import type { RepoBindErrorWire, RepoStatusWire } from '../lib/chat/frames'
import type { MediaGenerationJob } from '@openclaude/protocol/mediaGeneration'
import type { InboundMessage, MediaRef } from '../lib/chat/frames'
import { findRewriteTarget, type ImplicitTarget } from '../lib/implicitFeedback'
import { incidentStore } from '../lib/incidentStore'
import { clearTeamModeForSession, readTeamModeForSession, writeTeamMode } from '../lib/teamMode'
import {
  type CollabMode,
  type CollabUiState,
  ADVISOR_PARENT_BLOCK_REASON,
  EMPTY_COLLAB_UI,
  advisorParentCapabilityAllowed,
  collaborationPutBody,
  docToUiState,
  isStaleCollabEpoch,
  recommendedAdvisorModel,
  sendCollabFields,
} from '../lib/collaborationConfig'
import { clearSessionEffort, writeSessionEffort } from '../lib/sessionEffort'
import { clearContextTierForSession, writeContextTier } from '../lib/sessionContextTier'
import { writeSessionServiceTier } from '../lib/sessionServiceTier'
import { DEFAULT_AGENT, type Agent } from '../lib/agents'
import type { ProductFeatureId } from '../lib/productCapabilities'
import type { TutorialCaseId } from '../lib/tutorialCaseCatalog'
import { api, apiErrorMessage, ApiError } from '../lib/api'
import {
  effectiveEffortModelId,
  effortForModel,
  type PreferenceEffort,
  type PrefsView,
  resolveSessionModel,
} from '../lib/modelPreferences'
import {
  DEMO_MESSAGES,
  DEMO_MESSAGES_BY_SESSION,
  DEMO_MODELS,
  DEMO_USER,
  demoReply,
} from '../lib/demo'
import type {
  ChatProject,
  LockedPublicModel,
  Message,
  PublicConfig,
  PublicModel,
  Session,
  ToolCard,
} from '../lib/types'
import {
  freshSessionRequiredForSwitch,
  freshSessionSwitchNotice,
  modelSwitchCompactionReason,
} from '../lib/modelSwitch'
import { TASKBOARD_ENABLED } from '../lib/taskboardFeature'
import { useServerFeatures } from '../hooks/useServerFeatures'
import { readDismissedSuggestions } from '../lib/unfiledSuggest'
import { projectChipsBoardId } from '../lib/projectChips'
import type { SaveToProjectRequest } from '../components/project/SaveToProjectDialog'
import { useMountedOnce } from './appHelpers'

export function useAppState() {
  // P7 最小路由（无路由库）：特判页（demo / reset-password / desktop/enroll）与启动深链
  // （会话 /s/<id> + 面板 ?panel=）的解析见 readLocationRoute；此后 URL 是状态的 replaceState 单向镜像。
  const urlRoute = readLocationRoute(location)
  const { params, demo, resetToken, desktopEnroll, routingEnabled } = urlRoute
  // 会话深链恢复未决标记：resolve 前 useSessionList 暂停"自动选中上次会话"
  // （URL 指定 > 最近会话）；resolve/放弃后置 null。
  const [pendingRouteSession, setPendingRouteSession] = useState<string | null>(() =>
    routingEnabled ? parseSessionPath(location.pathname) : null,
  )
  // 任务面板是并列工作区（整段替换 <main>），不是管理中心 Tab。boot 自 /board。
  const [boardOpen, setBoardOpenState] = useState(
    () => TASKBOARD_ENABLED && routingEnabled && location.pathname === '/board',
  )
  // 项目主页(/p/<id>[/<tab>])：第三个并列工作区。null = 不在项目主页。
  const [projectHome, setProjectHome] = useState<ProjectRoute | null>(null)
  // 启动深链 /p/<id> 的未决目标：等项目列表到达再打开(useAppRoute),不存在则回 /。
  const [pendingRouteProject, setPendingRouteProject] = useState<ProjectRoute | null>(() =>
    routingEnabled ? parseProjectPath(location.pathname) : null,
  )
  // 所有「去对话 / 去任务面板」的入口都经这里：切工作区即离开项目主页。
  // 用户主动导航也作废未决的 /p/<id> 深链恢复(否则列表迟到后会把人拽回项目主页)。
  const setBoardOpen = useCallback((open: boolean) => {
    setBoardOpenState(open)
    setProjectHome(null)
    setPendingRouteProject(null)
  }, [])
  const [boardView, setBoardView] = useState<BoardViewParam>(() =>
    routingEnabled ? parseBoardView(params, preferredBoardView()) : preferredBoardView(),
  )
  const [boardTicketId, setBoardTicketId] = useState<string | null>(() =>
    routingEnabled ? parseBoardTicket(params) : null,
  )
  const [boardTicketType, setBoardTicketType] = useState(() =>
    routingEnabled ? parseBoardTicketType(params) : null,
  )
  // 视图态：home=营销首页,app=登录页/工作区。启动静默续期成功（useAuth onBootAuthed）
  // 直接置 app,失败停在 home。
  const [view, setView] = useState<'home' | 'app'>(resetToken || desktopEnroll ? 'app' : 'home')
  // AuthGate 初始模式：「免费开始」=register，顶栏「登录」=login，重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? 'reset' : 'login')
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme()

  // 公开配置（Turnstile bypass / site key）：登录页驱动 AuthGate 是否渲染真 widget。
  const [publicCfg, setPublicCfg] = useState<PublicConfig | null>(null)
  const [publicCfgRetryNonce, setPublicCfgRetryNonce] = useState(0)

  // demo 展示消息（本地 fixture 流式回放用；非 demo 的消息权威在 WS service）。
  const [messages, setMessages] = useState<Message[]>(demo ? DEMO_MESSAGES : [])
  const [busy, setBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [toolCards] = useState<ToolCard[]>([])
  const [collapsed, setCollapsed] = useState(() => readCollapsed())
  const composerPrefs = useLocalComposerPrefs()
  useEffect(() => {
    writeCollapsed(collapsed)
  }, [collapsed])
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [agent, setAgent] = useState(DEFAULT_AGENT)
  // 已装智能体目录(agent 归属解析用):登录后拉一次,市场关闭时刷新;AgentPicker 打开时
  // 自行拉最新,两者互不依赖。目录**必须**参与会话归属解析的依赖(见下方 effect 注释)。
  const [myAgents, setMyAgents] = useState<Agent[]>([DEFAULT_AGENT])
  const [pickerOpen, setPickerOpen] = useState(false)
  // 对话模型/默认思考深度:模型能力来自 GET /api/public/models；用户默认来自
  // /api/me/preferences。两者同批 hydrate 后才决定初始值,避免迟到偏好覆盖人工选择。
  const [models, setModels] = useState<PublicModel[]>(demo ? DEMO_MODELS : [])
  const [lockedModels, setLockedModels] = useState<LockedPublicModel[]>([])
  const [subscribeOpenSignal, setSubscribeOpenSignal] = useState(0)
  const [modelId, setModelId] = useState<string | undefined>(demo ? DEMO_MODELS[0]?.id : undefined)
  // 最近一次 preferences 快照(default_model 解析用):per-session 模型恢复的回落基准。
  // 写入点 = models 装载批 + SettingsCenter onPreferencesChange;下方 resolver effect 消费。
  const [modelPrefs, setModelPrefs] = useState<PrefsView>({})
  const [preferenceEffort, setPreferenceEffort] = useState<PreferenceEffort | undefined>()
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelSwitchPreparing, setModelSwitchPreparing] = useState(false)
  const [chatError, setChatError] = useState<ChatError | null>(null)
  // 输入框上方横幅栈的「展开全部」(shell 审计 S-06)。默认折叠到 MAX_VISIBLE_BANNERS 条。
  const [bannersExpanded, setBannersExpanded] = useState(false)
  // UpdateBanner 自己订阅 governor,这里再订一份只为把它算进横幅栈的条数。
  const updateBannerVisible = useSyncExternalStore(appUpdate.subscribe, appUpdate.getBannerVisible)
  const [imageAnnotationSource, setImageAnnotationSource] = useState<ImageAnnotationSource | null>(
    null,
  )
  const [containerPreviewUrl, setContainerPreviewUrl] = useState<string | null>(null)
  // 详情面板(右侧第三栏,OCV5-370):宽屏(≥1100px)内联第三列,开合与宽度记在本机;
  // 更窄的视口用贴底 Sheet,不硬挤三列。面板里看哪一步是纯 UI 态,不进 ChatSocket。
  const isMdViewport = useMdViewport()
  const isWideViewport = useWideViewport()
  const [paneOpen, setPaneOpenState] = useState(readDetailPaneOpen)
  const [paneSheetOpen, setPaneSheetOpen] = useState(false)
  const [paneRequest, setPaneRequest] = useState<PaneRequest | null>(null)
  const [paneActive, setPaneActive] = useState<ToolLike | null>(null)
  const paneWidth = useResizableWidth(DETAIL_PANE_WIDTH)
  const setPaneOpen = useCallback((open: boolean) => {
    setPaneOpenState(open)
    writeDetailPaneOpen(open)
  }, [])
  const paneToggleRef = useRef<(() => void) | null>(null)
  // 请求记下发起时的会话(openPane 引用稳定,不随会话变):切会话后旧请求不再交给新面板。
  const activeIdRef = useRef<string | null>(null)
  const isWideRef = useRef(isWideViewport)
  isWideRef.current = isWideViewport
  /** 从面板外打开 / 定位面板:宽屏展开内联列,窄屏弹出贴底面板。 */
  const openPane = useCallback(
    (tab?: PaneTab, message?: ToolLike | null) => {
      setPaneRequest({ tab, message, nonce: Date.now(), sessionId: activeIdRef.current })
      if (isWideRef.current) setPaneOpen(true)
      else setPaneSheetOpen(true)
    },
    [setPaneOpen],
  )
  // 面板深链：boot 读到 ?panel= 即以打开态初始化（工作区渲染后即呈现；未登录深链则
  // 登录后呈现）。打开/关闭经 useAppRoute 同步回 query。
  const [settingsOpen, setSettingsOpen] = useState(urlRoute.panel === 'settings')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account')
  const [messageFeedback, setMessageFeedback] = useState<FeedbackContext | null>(null)
  const messageFeedbackTriggerRef = useRef<HTMLElement | null>(null)
  const messageFeedbackMounted = useMountedOnce(messageFeedback !== null)
  const [inboxOpen, setInboxOpen] = useState(false)
  const inboxMounted = useMountedOnce(inboxOpen)
  const [findOpen, setFindOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteMounted = useMountedOnce(paletteOpen)
  const [mediaTasksOpen, setMediaTasksOpen] = useState(false)
  // 「视频任务」入口门控:null=未知(保持可见),false=账号未开放(隐藏死入口)。
  const [mediaTasksAvailable, setMediaTasksAvailable] = useState<boolean | null>(null)
  // 「ChatGPT 直连」入口门控:服务端 GET /api/chatgpt-proxy/access 明确 enabled 才显示(默认隐藏)。
  const [chatGptProxyEnabled, setChatGptProxyEnabled] = useState(false)
  const [chatGptProxyOpen, setChatGptProxyOpen] = useState(false)
  const [liveMediaJob, setLiveMediaJob] = useState<MediaGenerationJob | null>(null)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  const repoModalMounted = useMountedOnce(repoModalOpen)
  const [manageOpen, setManageOpen] = useState(urlRoute.panel === 'manage')
  const [manageTab, setManageTab] = useState<ManageTab>(DEFAULT_MANAGE_TAB)
  const [manageAutoAuthorizePluginSlug, setManageAutoAuthorizePluginSlug] = useState<string | null>(
    null,
  )
  const [marketplaceOpen, setMarketplaceOpen] = useState(urlRoute.panel === 'market')
  const [orgOpen, setOrgOpen] = useState(urlRoute.panel === 'org')
  const [orgSection, setOrgSection] = useState<OrgSection>('overview')
  const [tutorialOpen, setTutorialOpen] = useState(urlRoute.panel === 'help')
  const [tutorialTopic, setTutorialTopic] = useState<ProductFeatureId | null>(
    urlRoute.tutorialTopic,
  )
  const [tutorialCase, setTutorialCase] = useState<TutorialCaseId | null>(urlRoute.tutorialCase)
  const [tutorialCommunity, setTutorialCommunity] = useState<string | null>(
    urlRoute.tutorialCommunity,
  )
  // 一级页签（null = 案例展厅，不进 URL）/ 精选作品 / 功能教程目标步骤：镜像到 ?tab= / ?work= / ?step=。
  const [tutorialTab, setTutorialTab] = useState<TutorialTab | null>(urlRoute.tutorialTab)
  const [tutorialWork, setTutorialWork] = useState<TutorialWorkId | null>(urlRoute.tutorialWork)
  const [tutorialStep, setTutorialStep] = useState<number | null>(urlRoute.tutorialStep)
  const [marketplaceTab, setMarketplaceTab] = useState<MarketplaceTab>('browse')
  const [marketplaceBrowseKind, setMarketplaceBrowseKind] = useState<MarketplaceKind>('skill')
  // 「在对话中创建」技能/智能体:关市场 → 新会话 → Composer 预填引导模板(用户改后发送)。
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(
    null,
  )
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [goalOpenNonce, setGoalOpenNonce] = useState(0)
  const [messageReplyTarget, setMessageReplyTarget] = useState<{
    sessionId: string
    quote: MessageReplyQuote
  } | null>(null)
  // 归档「查看更早历史记录」按钮子态(加载中 / 失败可重试)。切会话时重置(见下)。
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [chatScrollParent, setChatScrollParent] = useState<HTMLDivElement | null>(null)
  const bindChatScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setChatScrollParent((current) => (current === node ? current : node))
  }, [])
  // 归档前插视口锚点:只有对应请求已返回后才允许消费，避免期间其它内容增长冒领锚点。
  const archiveScrollAnchorRef = useRef<{
    token: number
    capturedScrollTop: number
    timelineGeneration: number | undefined
    row: VisibleVirtualRowAnchor | null
    ready: boolean
    cancelled: boolean
    restoring: boolean
    settle: () => void
  } | null>(null)
  const archiveRequestTokenRef = useRef(0)
  const settleArchiveAnchor = useCallback((token?: number) => {
    const anchor = archiveScrollAnchorRef.current
    if (!anchor || (token !== undefined && anchor.token !== token)) return
    archiveScrollAnchorRef.current = null
    anchor.settle()
  }, [])
  const stopRef = useRef(false)
  // 稳定句柄：让早于 useChatSocket 声明的 send/regenerate 回调引用 WS 引擎，避免
  // “块级变量在声明前使用” 的 TDZ（hook 在下方调用后回填 sockRef.current）。
  const sockRef = useRef<UseChatSocket | null>(null)
  const toast = useToast()
  // 只有 userNoticeApproval 完整门禁后的 approved_recovery 才进入一次性 success toast。
  // 内部 incident 的 open/resolved 均由 store 静默忽略，不展示负面运维状态。
  useEffect(
    () =>
      incidentStore.onResolved((e) => {
        const msg = e.message?.trim() ? e.message : `${e.title}已恢复`
        toast(msg, 'success')
      }),
    [toast],
  )
  // Aurora 风格确认/输入对话框(Promise 式),取代原生 window.confirm/prompt。
  const [confirmDialog, confirmDialogEl] = useConfirm()
  const [promptText, promptTextEl] = usePrompt()
  // GitHub 仓库绑定帧处理器的稳定间接：useChatSocket 在 useRepoBinding 之前声明，故经 ref
  // 透传（与 sockRef 同样的 TDZ 规避；handler 本身是 useRepoBinding 的稳定 useCallback）。
  const repoStatusHandlerRef = useRef<(f: RepoStatusWire) => void>(() => {})
  const repoBindErrorHandlerRef = useRef<(f: RepoBindErrorWire) => void>(() => {})
  // 隐式负反馈上报入口的稳定间接（与 sockRef 同款 TDZ 规避）：send/stopTurn 在
  // sendImplicitRating 声明之前就要引用它，故经 ref 回填；回调本体在下方 useCallback 定义。
  // 走 ref 而非直接入 deps → send/stopTurn 引用保持稳定（不被评价态/模型切换牵动重建）。
  const sendImplicitRatingRef = useRef<
    ((target: ImplicitTarget, opts: { reason: ImplicitReason }) => void) | null
  >(null)
  // 用户主动 Stop 的轮不做完成脉冲高亮：stopTurn 置位，sending 沿的 nudge effect 消费后清。
  const stoppedTurnRef = useRef(false)

  // 本地会话消息存储（脚手架，仅 demo 路径用）：activeId → 消息数组。非 demo 走 WS + IndexedDB。
  const localStore = useRef<Map<string, Message[]>>(new Map())
  // 会话列表域整体重置的稳定间接：useSessionList 在 useAuth 之后调用（需要 auth/user），
  // clearAuth/登录成功的会话收尾经本 ref 回填（与 sockRef 同款 TDZ 规避）。
  const sessionsResetRef = useRef<() => void>(() => {})
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
      teardownComposerDrafts(user?.id)
      resetComposerAttachmentCache()
      // signPath 只在单一租户内唯一；鉴权身份退出/过期时必须丢弃内存图片字节，避免
      // 同一 SPA 随后登录另一账号后以相同容器路径命中上一账号的 Blob。
      imageByteCache.clear()
      localStore.current.clear()
      sessionsResetRef.current() // 清列表/选中/已拉历史标记,允许下次登录重新自动选中
      setMessages([])
      setChatError(null)
      setContainerPreviewUrl(null)
      setSettingsOpen(false)
      setMediaTasksOpen(false)
      setLiveMediaJob(null)
      setManageAutoAuthorizePluginSlug(null)
      setOrgOpen(false)
      const publicQuery = new URLSearchParams(location.search)
      const keepPublicTutorial = routingEnabled && parsePanelParam(publicQuery) === 'help'
      setTutorialOpen(keepPublicTutorial)
      setTutorialCase(keepPublicTutorial ? parseTutorialCase(publicQuery) : null)
      setTutorialTopic(keepPublicTutorial ? parseTutorialTopic(publicQuery) : null)
      setTutorialCommunity(keepPublicTutorial ? parseTutorialCommunity(publicQuery) : null)
      setTutorialTab(keepPublicTutorial ? parseTutorialTab(publicQuery) : null)
      setTutorialWork(keepPublicTutorial ? parseTutorialWork(publicQuery) : null)
      setTutorialStep(keepPublicTutorial ? parseTutorialStep(publicQuery) : null)
      setView('home')
    },
    // 登出前清本 user 的 IndexedDB 命名空间（隐私，类比 P5 媒体缓存按 authKey 失效）。
    onLogout: () => void sockRef.current?.wipePersistence(),
    // 启动静默续期成功 → 直接恢复工作区。
    onBootAuthed: () => {
      imageByteCache.clear()
      setView('app')
    },
    // 登录成功不预载会话：由 useChatSocket IndexedDB 注水（onHydrated）+ listSessions
    // 合并 server canonical 列表填侧栏；selectSession 再按需拉取单会话历史。
    onLoginSuccess: () => {
      imageByteCache.clear()
      sessionsResetRef.current()
      setMessages([])
    },
  })

  // AuthSession 整个生命周期是同一引用；token + epoch 在对象内部原子推进。
  // 经本地 useRef 再持有一次以保留 biome 的稳定 ref 推断 —— 直接使用 hook 返回的 ref 会在
  // 多处 useCallback/useEffect 误报 useExhaustiveDependencies（lint 只认本地 useRef 为稳定）。
  const authRef = useRef(authSessionRef.current)

  // Assistant/tool markdown often exposes a dev-server URL such as
  // http://localhost:3000. That address belongs to the user's container, not
  // the viewer's phone or PC. Capture only explicit, validated loopback links
  // and route them into the authenticated isolated-Chromium preview.
  useEffect(() => {
    if (demo || !authed) return
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return
      const previewUrl = containerPreviewHrefFromTarget(event.target)
      if (!previewUrl) return
      event.preventDefault()
      event.stopPropagation()
      setContainerPreviewUrl(previewUrl)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [authed, demo])

  const interrupt = useCallback(() => {
    stopRef.current = true
    setBusy(false)
    setStreamText('')
    setChatError(null)
  }, [])

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
      interrupt()
      setMessages([])
      setChatError(null)
      setPendingRouteSession(null)
      setPendingRouteProject(null)
    },
    onDeleteSession: (id) => {
      localStore.current.delete(id)
      clearTeamModeForSession(id) // 顺手清该会话的团队模式 per-session 键(不留孤儿键)
      clearSessionEffort(id) // 同上:思考档位 per-session 键
      clearContextTierForSession(id) // 同上:Cursor 上下文档位 per-session 键
      writeSessionServiceTier(id, null) // OCV5-434 GPT Fast per-session 键
    },
    onActiveSessionDeleted: () => {
      setMessages([])
      setChatError(null)
    },
    // URL 深链恢复未决：暂停自动选中（URL 指定 > 最近会话）。
    holdAutoSelect: pendingRouteSession !== null,
  })

  // 「项目下新建会话」草稿意图：项目行入口记下目标项目，空白草稿真正建会话（首次发送）时
  // 消费——本地立即归属该项目 + 服务端 PATCH 落库。无参新建 / 选中已有会话都会覆盖清除，
  // 意图只活在「一次草稿」生命周期内，不会泄漏到之后的新会话。
  // 草稿归属既要被 send 同步读取(ref),也要在输入框里显示、可改(state):两者经 setDraftProject 同写。
  const draftProjectRef = useRef<string | null>(null)
  const [draftProjectId, setDraftProjectIdState] = useState<string | null>(null)
  const setDraftProject = useCallback((projectId: string | null) => {
    draftProjectRef.current = projectId
    setDraftProjectIdState(projectId)
  }, [])
  const handleNew = useCallback(() => {
    setDraftProject(null)
    newSession()
  }, [newSession, setDraftProject])
  const newSessionInProject = useCallback(
    (projectId: string) => {
      setDraftProject(projectId)
      newSession()
    },
    [newSession, setDraftProject],
  )

  const [projectSettings, setProjectSettings] = useState<ChatProject | null>(null)
  const [ungroupedAssetsOpen, setUngroupedAssetsOpen] = useState(false)
  // 「打开项目」的唯一入口(侧栏项目名、顶栏项目、输入框项目标识)：打开项目主页。
  // 项目设置仍可从主页的 ⋯ / 设置 与侧栏行的 ⋯ 进入。
  const projectsRef = useRef<ChatProject[]>([])
  const openProject = useCallback((projectId: string) => {
    if (!projectsRef.current.some((x) => x.id === projectId)) return
    setPendingRouteProject(null)
    setBoardOpenState(false)
    setProjectHome({ projectId, tab: 'overview' })
  }, [])
  const projectSettingsOpen = projectSettings !== null || ungroupedAssetsOpen
  const projectSettingsMounted = useMountedOnce(projectSettingsOpen)
  // 新建项目对话框:null=关;{}=普通新建;{sessionId,title}=从该会话创建并移入。
  const [createProjectFrom, setCreateProjectFrom] = useState<{
    sessionId?: string
    title?: string
  } | null>(null)
  const createProjectMounted = useMountedOnce(createProjectFrom !== null)
  const [projectArchiveOpen, setProjectArchiveOpen] = useState(false)
  const projectArchiveMounted = useMountedOnce(projectArchiveOpen)
  // P5b：「记住这条 / 存为项目技能」弹窗请求（null = 关）。
  const [saveToProject, setSaveToProject] = useState<SaveToProjectRequest | null>(null)
  const saveToProjectMounted = useMountedOnce(saveToProject !== null)
  // 换号 / 登出：发起时的身份已不在，弹窗直接收起（保存流程自己也会按身份停下）。
  useEffect(() => {
    void user?.id
    setSaveToProject(null)
  }, [user?.id])

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
      let moved: string[] = []
      setSessions((c) => {
        moved = c.filter((s) => s.projectId === projectId).map((s) => s.id)
        return c.map((s) => (s.projectId === projectId ? { ...s, projectId: null } : s))
      })
      return moved
    },
    onRestoreProjectSessions: (projectId, sessionIds) => {
      const ids = new Set(sessionIds)
      setSessions((c) => c.map((s) => (ids.has(s.id) ? { ...s, projectId } : s)))
    },
  })

  projectsRef.current = projects
  const homeProject = projectHome ? projects.find((p) => p.id === projectHome.projectId) : undefined

  // 服务端功能开关（GET /api/features；读不到 = 全关，demo 不读）。
  const serverFeatures = useServerFeatures(demo ? null : auth, demo)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setDismissedSuggestions(user?.id ? readDismissedSuggestions(user.id) : new Set())
  }, [user?.id])
  // 当前会话所属项目的看板：P5b 两个入口只在会话属于有看板的项目时出现。
  const activeProjectId = activeId ? sessions.find((s) => s.id === activeId)?.projectId : undefined
  const activeChatProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId)
    : undefined
  const chipsBoardProjectId = projectChipsBoardId({
    demo,
    taskboardEnabled: TASKBOARD_ENABLED,
    chipsFlag: serverFeatures.chips,
    project: activeChatProject,
  })
  const chipsProjectName = activeChatProject?.name ?? ''

  // 确保项目的看板已在容器里建好（任何看板路由首次访问都会建出预留的看板）。
  // 项目主页的入口和 P5b / P5c 的保存共用这一条路径。
  const prepareProjectBoard = useCallback(
    async (boardProjectId: string): Promise<boolean> => {
      try {
        const { taskboardApi } = await import('../lib/taskboard')
        await taskboardApi.getProject(authRef.current, boardProjectId)
        return true
      } catch (e) {
        toast(apiErrorMessage(e, '项目看板暂时打不开，请稍后再试'), 'error')
        return false
      }
    },
    [toast],
  )
  // 主页上的项目被删除(本页 ⋯ 删除或别处删除)：列表落定后不再存在 → 回对话。
  useEffect(() => {
    if (projectHome && projectsLoaded && !homeProject) setProjectHome(null)
  }, [projectHome, projectsLoaded, homeProject])

  // Ctrl/⌘K recents: whatever the user actually lands on (project home or a chat).
  const paletteUserId = user?.id ?? (demo ? 'demo' : null)
  const homeProjectId = homeProject?.id ?? null
  const chatViewActiveId = !boardOpen && !projectHome ? activeId : undefined
  useEffect(() => {
    if (homeProjectId) pushPaletteRecent(paletteUserId, { kind: 'project', id: homeProjectId })
  }, [paletteUserId, homeProjectId])
  useEffect(() => {
    if (chatViewActiveId)
      pushPaletteRecent(paletteUserId, { kind: 'session', id: chatViewActiveId })
  }, [paletteUserId, chatViewActiveId])
  // Stable search callbacks for the palette (its debounce effect depends on them).
  const searchSessionMessagesRef = useRef(searchSessionMessages)
  searchSessionMessagesRef.current = searchSessionMessages
  const paletteSearchMessages = useMemo(
    () =>
      demo || !auth
        ? undefined
        : (q: string, signal: AbortSignal) =>
            searchSessionMessagesRef.current(q, signal, undefined, true),
    [demo, auth],
  )
  const paletteSearchAssets = useMemo(
    () =>
      demo || !auth
        ? undefined
        : (q: string, signal: AbortSignal, limit: number) =>
            api.searchProjectAssets(authRef.current, q, { signal, limit }),
    [demo, auth],
  )

  const unreadSessions = useUnreadSessions({
    sessions,
    activeId: activeId ?? null,
    userId: user?.id ?? null,
    auth: demo ? null : auth,
    // sidebar-B UUS-01：系统通知点开后落到对应会话（hook 内已 window.focus()）。
    // 在项目主页时点系统通知：落到对应会话即离开主页(任务面板保持原行为)。
    onNotificationOpen: (id: string) => {
      setProjectHome(null)
      setPendingRouteProject(null)
      selectSession(id)
    },
  })
  const sidebarWidth = useSidebarWidth()

  // 切会话/进出任务看板时清掉面板里的定位:消息对象引用属于旧会话上下文,跨会话保留只会
  // 展示与当前消息流无关的陈旧内容。宽屏面板的开合是用户偏好,保留;窄屏抽屉收起。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId / boardOpen / projectHome 是「换了上下文」的触发信号
  useEffect(() => {
    setPaneRequest(null)
    setPaneActive(null)
    setPaneSheetOpen(false)
  }, [activeId, boardOpen, projectHome])

  // ── per-session 模型选择(会话间互不影响,持久化恢复)────────────────────────
  //
  // 选择器的值 = 活动会话的有效模型:会话自己的持久化选择优先(须仍可见且健康,
  // 否则回落),其次 default_model 偏好,再回落首个健康模型(resolveSessionModel)。
  // 数据流:侧栏 Session.modelId(IndexedDB 注水 + listSessions server-wins + 选择写通)
  // 是本 effect 的读源;显式选择经 selectModel 写通三持有方(侧栏 + WS service/IndexedDB +
  // 服务端 PATCH,与 rename 同款收口)。空会话态(无 activeId)解析结果 = 纯默认,作为
  // "下一个新会话"的初始意图;空态显式选择只改 modelId state,不进本 effect 依赖,不被覆盖。
  const activeSessionModelId =
    !demo && activeId ? sessions.find((s) => s.id === activeId)?.modelId : undefined
  useEffect(() => {
    // 活动会话解析:切会话/会话模型到达(注水·listSessions·detail 回填)/偏好变更时恢复。
    // activeId 必须进依赖:A(有模型)→B(无模型)切换时 activeSessionModelId 可能不变,
    // 仅 activeId 变,不重跑就会把 A 的模型粘给 B。
    if (demo || models.length === 0 || !activeId) return
    setModelId(resolveSessionModel(models, activeSessionModelId, modelPrefs))
  }, [demo, models, activeId, activeSessionModelId, modelPrefs])
  // 「新建会话并以目标模型起手」的一次性意图(Opus/Fable 只能新会话使用的弹窗确认后写入):
  // 空态 effect 消费一次即清空,下一次新建仍回默认解析。
  const nextSessionModelRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    // 空会话态默认:boot 初值与 default_model 变更传导(= 下一个新会话的初始意图)。
    // 空态的显式选择(selectModel 只 setModelId)不改本 effect 依赖,不会被覆盖。
    if (demo || models.length === 0 || activeId !== undefined) return
    const pinned = nextSessionModelRef.current
    nextSessionModelRef.current = undefined
    if (pinned && models.some((m) => m.id === pinned)) {
      setModelId(pinned)
      return
    }
    setModelId(resolveSessionModel(models, undefined, modelPrefs))
  }, [demo, models, activeId, modelPrefs])

  // 显式选择模型:活动会话存在则写通三持有方(服务端经 queueModelPatch:选择即挂 pending
  // 意图压制一切在途旧载荷 + 单飞串行合并 PATCH,同时消掉「旧响应迟到盖回」与「连选
  // PATCH 倒序落库」两类竞态)。失败契约:服务端存有**旧值**时下次 listSessions
  // server-wins 盖回,重选即重试;服务端从未有值(NULL=从未显式选择,无"清除"流)则缺席
  // 不表态,本地意图保留 —— 两种失败面都可自愈。新会话行未建 404 同吞,由建行 PUT/建行后
  // 收敛 PATCH 落地。无活动会话(空会话态)仅更新选择器,作为下一会话意图。
  const activeModelSwitchSessionRef = useRef(activeId)
  activeModelSwitchSessionRef.current = activeId
  const selectModel = useCallback(
    async (id: string) => {
      if (id === modelId || modelSwitchPreparing) return
      const sid = activeId
      const commit = (modelSwitchId?: string) => {
        if (activeModelSwitchSessionRef.current === sid) setModelId(id)
        // 成功反馈只挂用户主动切换路径:boot 恢复模型偏好走上方 resolveSessionModel 的
        // setModelId,不经过 commit,不会误报。失败面已有 toast(压缩失败)或 server-wins
        // 盖回,成功此前静默;压缩切换(prepareModelSwitch)带明确等待,给压缩语义文案。
        const displayName = models.find((m) => m.id === id)?.display_name ?? id
        toast(
          modelSwitchId ? `已压缩上下文并切换到 ${displayName}` : `已切换到 ${displayName}`,
          'success',
        )
        if (demo) return
        if (!sid) return
        setSessions((c) => c.map((s) => (s.id === sid ? { ...s, modelId: id } : s)))
        sockRef.current?.setSessionModel(sid, id, modelSwitchId)
        queueModelPatch(sid, id)
      }
      if (demo || !activeId) {
        commit()
        return
      }
      const currentMessages = sockRef.current?.getMessages(activeId) ?? []
      const hasContent =
        (sessions.find((session) => session.id === activeId)?.messageCount ?? 0) > 0 ||
        currentMessages.some(
          (message) =>
            message.role === 'user' ||
            message.role === 'assistant' ||
            message.role === 'tool' ||
            message.role === 'agent-group',
        )
      // Opus / Fable 只能新会话起手(见 lib/modelSwitch):已有上下文的非 Opus/Fable 会话
      // 不切换,先说明原因(初始上下文过大 + 吃不到缓存),给「新建会话」快捷入口。
      if (freshSessionRequiredForSwitch(modelId, id, hasContent)) {
        const targetName = models.find((m) => m.id === id)?.display_name
        const notice = freshSessionSwitchNotice(
          id,
          typeof targetName === 'string' ? targetName : undefined,
        )
        const go = await confirmDialog({
          title: notice.title,
          body: (
            <div className="space-y-2 text-sm text-muted" data-testid="fresh-session-switch-notice">
              {notice.paragraphs.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ),
          confirmText: notice.confirmText,
          cancelText: notice.cancelText,
        })
        if (go !== true) return
        nextSessionModelRef.current = id
        handleNew()
        return
      }
      const reason = modelSwitchCompactionReason(models, modelId, id, hasContent)
      if (!reason || !modelId) {
        commit()
        return
      }
      const details = [
        reason.visionDowngrade
          ? '目标模型不支持当前会话的多模态上下文，图片等内容将转换为文字交接。'
          : null,
        reason.contextDowngrade ? '目标模型的上下文窗口更短，需要先压缩当前会话。' : null,
      ].filter((detail): detail is string => detail !== null)
      const confirmed = await confirmDialog({
        title: '切换模型？',
        body: (
          <div className="space-y-2 text-sm text-muted">
            {details.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
            <p>
              压缩并切换会用当前模型生成交接内容，原始记录不会删除。直接切换沿用原来的方式，不压缩，新模型可能看不到完整上下文。
            </p>
          </div>
        ),
        confirmText: '压缩并切换',
        altText: '直接切换',
      })
      if (confirmed === false) return
      if (confirmed === 'alt') {
        commit()
        return
      }
      setModelSwitchPreparing(true)
      try {
        const switchId = await sockRef.current?.prepareModelSwitch(activeId, modelId, id)
        if (!switchId) throw new Error('模型切换准备失败')
        commit(switchId)
      } catch (error) {
        toast(error instanceof Error ? error.message : '上下文压缩失败，仍保留原模型', 'error')
      } finally {
        setModelSwitchPreparing(false)
      }
    },
    [
      demo,
      activeId,
      modelId,
      modelSwitchPreparing,
      models,
      sessions,
      setSessions,
      queueModelPatch,
      confirmDialog,
      toast,
      handleNew,
    ],
  )
  // 回填给 useAuth 的 chat 域收尾（onClearAuth/onLoginSuccess 经 sessionsResetRef 调用）。
  sessionsResetRef.current = resetSessionList

  // 团队模式(v5 轻量组队):**会话级**开关(清「设备级粘滞开关」债)。每个会话独立记忆,
  // per-session 键 `oc_v5_team_mode:<sessionId>` 承载;新会话继承全局偏好默认值
  // (`oc_v5_team_mode`,镜像用户最近一次选择——老用户习惯不变:上次开着新会话也开着)。
  // 切会话按 activeId 重读(下方 effect);开关切换同时写 per-session + 全局默认
  // (见 lib/teamMode)。语义仍为 turn 级 flag,只对「全能助手」(main)生效,只在
  // agent.id==='main' 时随消息发送(见 send)。开关 UI 挂在 AgentPicker 的 main 卡片。
  // 声明在 useSessionList 之后:setTeamMode/重读 effect 需要 activeId 定位当前会话。
  const [teamMode, setTeamModeState] = useState(() => readTeamModeForSession(activeId))
  const [collabUi, setCollabUi] = useState<CollabUiState>(() => ({
    ...EMPTY_COLLAB_UI,
    mode: readTeamModeForSession(activeId) ? 'team' : 'solo',
  }))
  const collabMode = collabUi.mode
  const collabEpochRef = useRef(0)
  const [collabAsDefault, setCollabAsDefault] = useState(false)
  const [collabSaveError, setCollabSaveError] = useState<string | null>(null)
  const applyCollabDoc = useCallback((doc: Parameters<typeof docToUiState>[0]) => {
    const next = docToUiState(doc)
    setCollabUi(next)
    setTeamModeState(next.mode === 'team')
    setCollabSaveError(null)
  }, [])
  const persistCollab = useCallback(
    async (mode: CollabMode, opts?: { advisorModel?: string | null; asDefault?: boolean }) => {
      const epoch = ++collabEpochRef.current
      const previous = collabUi
      const parentEngineForGate =
        models.find((row) => row.id === modelId)?.engine ?? collabUi.parentEngine
      if (
        mode === 'advisor' &&
        !advisorParentCapabilityAllowed({
          parentEngine: parentEngineForGate,
          advisorConsultParents: collabUi.advisorConsultParents,
          advisorConsultAllowed: collabUi.advisorConsultAllowed,
        })
      ) {
        const msg = collabUi.advisorConsultParentReason || ADVISOR_PARENT_BLOCK_REASON
        setCollabSaveError(msg)
        toast(msg, 'error')
        return
      }
      const advisorModel =
        mode === 'advisor'
          ? (opts?.advisorModel ?? collabUi.advisorModel ?? recommendedAdvisorModel(collabUi))
          : null
      const asDefault = opts?.asDefault === true
      // Optimistic mode only; configVersion stays empty until the server returns it.
      setCollabUi((cur) => ({ ...cur, mode, advisorModel, configVersion: '' }))
      setTeamModeState(mode === 'team')
      writeTeamMode(activeId, mode === 'team')
      setCollabSaveError(null)
      // useAuth.auth is null until authed; authRef always holds MemoryAuthSession.
      if (demo || !auth) return
      const collabAuth = auth
      const identityEpoch = collabAuth.snapshot().epoch
      // Empty composer has no sessionId. Skipping PUT avoids the old asDefault/!sessionId
      // default-write path; first send persists against the minted session id.
      if (!activeId && !asDefault) return
      if (activeId && sockRef.current) {
        if (modelId) sockRef.current.setSessionModel(activeId, modelId)
        const title = sessions.find((session) => session.id === activeId)?.title || '新对话'
        const ensured = await sockRef.current.ensureServerSession(activeId, agent.id, title)
        if (!ensured) {
          setCollabUi(previous)
          setTeamModeState(previous.mode === 'team')
          const msg = '会话尚未创建成功，请检查网络后重试'
          setCollabSaveError(msg)
          toast(msg, 'error')
          return
        }
      }
      try {
        const doc = await api.putCollaborationConfig(
          collabAuth,
          collaborationPutBody({
            sessionId: activeId,
            mode,
            advisorModel,
            expectedRev: collabUi.rev,
            asDefault,
          }),
        )
        if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
        if (collabAuth.snapshot().epoch !== identityEpoch) return
        applyCollabDoc(doc)
      } catch (err) {
        if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
        if (collabAuth.snapshot().epoch !== identityEpoch) return
        if (err instanceof ApiError && err.status === 409) {
          try {
            const fresh = await api.getCollaborationConfig(collabAuth, activeId)
            if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
            if (collabAuth.snapshot().epoch !== identityEpoch) return
            applyCollabDoc(fresh)
            setCollabSaveError('配置已被更新，请确认后再选一次')
            toast('协作配置有更新，已重新读取，请再选一次', 'error')
            return
          } catch (rereadErr) {
            if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
            if (collabAuth.snapshot().epoch !== identityEpoch) return
            const msg = apiErrorMessage(rereadErr, '协作配置冲突后重读失败')
            setCollabUi(previous)
            setTeamModeState(previous.mode === 'team')
            setCollabSaveError(msg)
            toast(msg, 'error')
            return
          }
        }
        setCollabUi(previous)
        setTeamModeState(previous.mode === 'team')
        const msg = apiErrorMessage(err, '协作配置保存失败')
        setCollabSaveError(msg)
        toast(msg, 'error')
      }
    },
    [activeId, agent.id, applyCollabDoc, auth, collabUi, demo, modelId, models, sessions, toast],
  )
  const setTeamMode = useCallback(
    (enabled: boolean) => {
      void persistCollab(enabled ? 'team' : 'solo')
    },
    [persistCollab],
  )
  const setCollabMode = useCallback(
    (mode: CollabMode) => {
      void persistCollab(mode, { asDefault: collabAsDefault })
    },
    [collabAsDefault, persistCollab],
  )
  // 切会话:服务端配置为权威。epoch 让慢 GET 不能覆盖后来的会话或用户点击。
  useEffect(() => {
    const epoch = ++collabEpochRef.current
    const enabled = readTeamModeForSession(activeId)
    setCollabUi((cur) => ({
      ...EMPTY_COLLAB_UI,
      mode: enabled ? 'team' : 'solo',
      advisorModels: cur.advisorModels,
      advisorUnavailableReason: cur.advisorUnavailableReason,
      advisorConsultParents: cur.advisorConsultParents,
      advisorConsultParentReason: cur.advisorConsultParentReason,
    }))
    setTeamModeState(enabled)
    setCollabAsDefault(false)
    // auth is null until login/boot getMe (useAuth). authRef always holds the
    // MemoryAuthSession, including the anonymous epoch-0 object — do not GET on it.
    if (demo || !auth) return
    const collabAuth = auth
    const identityEpoch = collabAuth.snapshot().epoch
    void api
      .getCollaborationConfig(collabAuth, activeId)
      .then((doc) => {
        if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
        if (collabAuth.snapshot().epoch !== identityEpoch) return
        applyCollabDoc(doc)
      })
      .catch((err) => {
        if (isStaleCollabEpoch(epoch, collabEpochRef.current)) return
        if (collabAuth.snapshot().epoch !== identityEpoch) return
        setCollabSaveError(apiErrorMessage(err, '协作配置读取失败'))
      })
  }, [activeId, applyCollabDoc, auth, demo])

  // 本会话的思考档位与上下文档位(hooks/useSessionEngineOptions,原位调用)。
  const {
    sessionEffort,
    setSessionEffort,
    contextTier,
    setContextTier,
    serviceTier,
    setServiceTier,
  } = useSessionEngineOptions(activeId)

  // Async goal saves can finish after navigation; only consume the selected draft's project.
  const selectedSessionIdRef = useRef(activeId)
  selectedSessionIdRef.current = activeId
  const send = useCallback(
    async (
      text: string,
      media?: MediaRef[],
      imageEdit?: InboundMessage['content']['imageEdit'],
      displayText?: string,
      replyTo?: MessageReplyQuote,
      target?: { sessionId: string; projectId?: string | null },
    ) => {
      setChatError(null)
      const visibleText = displayText ?? text
      const sessionTitle = sessionTitleFromText(visibleText)

      // demo：本地流式回放（无网络），仅用于离线预览设计。
      if (demo) {
        const userMsg: Message = {
          id: `tmp-${Date.now()}`,
          role: 'user',
          content: visibleText,
          createdAt: new Date().toISOString(),
        }
        setMessages((m) => [...m, userMsg])
        setBusy(true)
        setStreamText('')
        stopRef.current = false
        const full = demoReply(text)
        for (let i = 0; i < full.length && !stopRef.current; i += 3) {
          setStreamText(full.slice(0, i + 3))
          await new Promise((r) => setTimeout(r, 12))
        }
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: full,
            createdAt: new Date().toISOString(),
          },
        ])
        setStreamText('')
        setBusy(false)
        return
      }

      if (!user || !sockRef.current) {
        if (target) throw new Error('登录状态或会话连接不可用')
        return
      }
      const sendProjectId = target ? target.projectId : draftProjectRef.current
      // 隐式负反馈（改写重发）：发送前用**当前会话**的现有消息判定「5min 内高相似改写」——
      // 命中即对被改写轮的末条 assistant 静默记 implicit down（空会话无历史 → 命中不了）。
      // 现场取消息（sockRef.current === chat，稳定句柄）而非捕获每帧刷新的 wsMessages。
      if (!target) {
        const rewriteTarget = findRewriteTarget(
          sockRef.current?.getMessages(activeId) ?? [],
          visibleText,
          Date.now(),
        )
        if (rewriteTarget) sendImplicitRatingRef.current?.(rewriteTarget, { reason: '改写重发' })
      }
      // 非 demo：经真实 WS 引擎发送（inbound.message）。确保有会话承载本轮（peer.id）。
      let sessionId = target?.sessionId ?? activeId
      let createdSession: Session | null = null
      let modeForSend = collabMode
      let advisorModelForSend = collabUi.advisorModel
      let configVersionForSend = collabUi.configVersion
      let unavailableForSend = collabUi.advisorUnavailableReason
      if (!sessionId) {
        sessionId = genWsSessionId()
        createdSession = {
          id: sessionId,
          title: sessionTitle,
          ownerUserId: user.id,
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          // 项目下新建：草稿建行即归属目标项目（侧栏首帧正确分组；服务端归属在下方首发收尾 PATCH）。
          ...(sendProjectId ? { projectId: sendProjectId } : {}),
          // 首发定格会话模型:当前有效模型(含空态显式选择)落为该会话的 per-session 选择,
          // 之后 default_model 变更/其它会话换模都不影响它(与 teamMode 的会话级落地同理)。
          ...(modelId ? { modelId } : {}),
        }
        // 空会话态用户可能已在全能助手卡上开/关了团队模式;把当前 intent 落地为新会话的
        // per-session 键 —— 否则该会话只靠全局默认,会被其它会话的开关翻动(切走再回来变样)。
        writeTeamMode(sessionId, collabMode === 'team')
        // 显式档位选择存在才落地(未选择 = 继续继承全局偏好,不写键)。
        if (sessionEffort !== undefined) writeSessionEffort(sessionId, sessionEffort)
        writeContextTier(sessionId, contextTier)
        writeSessionServiceTier(sessionId, serviceTier)
        sockRef.current?.ensureSession(sessionId, agent.id, sessionTitle)
        if (modelId) sockRef.current?.setSessionModel(sessionId, modelId)
        if (auth && (collabMode !== 'solo' || collabAsDefault)) {
          const collabAuth = auth
          const identityEpoch = collabAuth.snapshot().epoch
          const ensured = await sockRef.current?.ensureServerSession(
            sessionId,
            agent.id,
            sessionTitle,
          )
          if (!ensured) {
            toast('会话尚未创建成功，请检查网络后重试', 'error')
            return
          }
          try {
            const doc = await api.putCollaborationConfig(
              collabAuth,
              collaborationPutBody({
                sessionId,
                mode: collabMode,
                advisorModel:
                  collabMode === 'advisor'
                    ? (collabUi.advisorModel ?? recommendedAdvisorModel(collabUi))
                    : null,
                expectedRev: collabUi.rev,
                asDefault: collabAsDefault,
              }),
            )
            if (collabAuth.snapshot().epoch !== identityEpoch) return
            applyCollabDoc(doc)
            modeForSend = doc.session.mode
            advisorModelForSend = doc.session.advisorModel
            configVersionForSend = doc.session.configVersion
            unavailableForSend = doc.advisorUnavailableReason
          } catch (err) {
            if (collabAuth.snapshot().epoch !== identityEpoch) return
            const msg = apiErrorMessage(err, '协作配置保存失败')
            setCollabSaveError(msg)
            toast(msg, 'error')
            return
          }
        }
        setSessions((c) => [createdSession!, ...c])
        setActiveId(sessionId)
      }
      const sendCollab = sendCollabFields({
        agentId: agent.id,
        mode: modeForSend,
        advisorModel: advisorModelForSend,
        configVersion: configVersionForSend,
        advisorUnavailableReason: unavailableForSend,
        parentEngine: models.find((row) => row.id === modelId)?.engine ?? collabUi.parentEngine,
        advisorConsultParents: collabUi.advisorConsultParents,
        advisorConsultAllowed: collabUi.advisorConsultAllowed,
        advisorConsultParentReason: collabUi.advisorConsultParentReason,
      })
      if (sendCollab.blockedReason) {
        toast(sendCollab.blockedReason, 'error')
        return
      }
      const materializedDraft =
        !createdSession &&
        (sessions.some((session) => session.id === sessionId && session.messageCount === 0) ||
          (!!target && (sockRef.current?.getMessages(sessionId).length ?? 0) === 0))
      // 项目草稿被首轮前操作（Goal / GitHub 绑定）物化成会话行的场景：归属同样在首发落定。
      if (materializedDraft && sendProjectId) {
        const draftPid = sendProjectId
        setSessions((c) =>
          c.map((x) => (x.id === sessionId && !x.projectId ? { ...x, projectId: draftPid } : x)),
        )
      }
      sockRef.current?.ensureSession(sessionId, agent.id, sessionTitle)
      if (materializedDraft) {
        // Goal/GitHub 可在首条消息前物化服务端行。首发时须同步收敛真正标题；否则
        // 后端幂等 INSERT 不更新既有行，刷新后 listSessions 会把「新对话」盖回来。
        sockRef.current?.renameSession(sessionId, sessionTitle)
        void api.patchSessionTitle(authRef.current, sessionId, sessionTitle).catch(() => {
          // 行尚未建时 PATCH 可 404；随后 send 的幂等 PUT 会使用上面已更新的 socket 标题。
        })
      }
      // model / effortLevel 都是 inbound.message 顶层路由字段。用户未设置 effort 或
      // 当前模型不支持时省略(null=显式清除回模型默认),让模型沿用自身默认。
      // effort 来源:本会话显式选择(sessionEffort,聊天头档位选择器)优先,缺省回落
      // 用户全局偏好(preferences.default_effort);effortForModel 负责按当前执行模型
      // 的支持集过滤(不支持 → null 发送,不硬塞)。
      // media：已上传附件（图片/文件等），随 inbound.message.content.media 发送。
      // teamMode 只对 main 队长生效(其它 agent 无委派语义),故非 main 恒 false。
      const teamLeaderTurn = sendCollab.teamMode
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
        collabMode: sendCollab.collabMode,
        ...(sendCollab.collabMode === 'advisor'
          ? {
              advisorModel: sendCollab.advisorModel,
              collabConfigVersion: sendCollab.collabConfigVersion,
            }
          : {}),
        // Cursor Opus/Fable 上下文档位:只在当前模型支持分档时随帧发送;其它模型不带该字段
        // (master 对非分档模型本就忽略,但不发送可以让路由快照/日志更干净)。
        ...(cursorModelSupportsContextTier(modelId) ? { contextTier } : {}),
        // OCV5-434 GPT Fast:只在当前模型支持且用户开着时随帧发送;不带 = 标准。
        ...(serviceTier === 'fast' && supportsFastServiceTier(modelId) ? { serviceTier } : {}),
      })
      // 侧栏：提到顶 + 更新标题/时间/计数（计数仅作排序提示，权威消息在 WS service）。
      setSessions((c) => {
        const sid = sessionId!
        const found = c.find((s) => s.id === sid)
        const base: Session = found ??
          createdSession ?? {
            id: sid,
            title: sessionTitle,
            ownerUserId: user.id,
            updatedAt: '',
            messageCount: 0,
          }
        const updated: Session = {
          ...base,
          id: sid,
          title: found?.title && found.messageCount > 0 ? found.title : sessionTitle,
          updatedAt: new Date().toISOString(),
          messageCount: (found?.messageCount ?? 0) + 1,
        }
        return [updated, ...c.filter((s) => s.id !== sid)]
      })
      // 首发收尾：把「项目下新建」的归属落到服务端 canonical。行由 WS 受理 / 幂等 PUT 建立，
      // PATCH 可能在建行前到达（404），补一次延迟重试；仍失败则放弃——本地归属已正确，
      // 用户可手动移动，下次 listSessions server-wins 会盖回，不阻塞首发。
      if (sendProjectId && sessionId) {
        const draftPid = sendProjectId
        if (createdSession || materializedDraft) {
          if (
            draftProjectRef.current === draftPid &&
            (!target || selectedSessionIdRef.current === sessionId)
          )
            setDraftProject(null)
          const applyProject = (retries: number) => {
            api
              .patchSessionMeta(authRef.current, sessionId!, { projectId: draftPid })
              .catch((e: unknown) => {
                if (retries > 0) window.setTimeout(() => applyProject(retries - 1), 1500)
                else console.warn('patchSessionMeta(projectId) failed', e)
              })
          }
          applyProject(1)
        }
      }
    },
    // teamMode 不再入依赖:自 08326136f 起 send 只从 collabUi/collabMode 取模式(sendCollabFields),
    // 不读 teamMode 本身(OCV5-376)。applyCollabDoc/toast/setDraftProject 都是稳定引用,补齐不改重建时机。
    // setSessions/setActiveId 是 useSessionList 透传的 useState dispatcher(恒稳定),入 deps
    // 仅为满足 lint(跨 hook 返回值 biome 不再推断稳定性),不改变 send 的重建时机。
    [
      activeId,
      auth,
      demo,
      user,
      agent,
      modelId,
      models,
      preferenceEffort,
      sessionEffort,
      contextTier,
      serviceTier,
      collabMode,
      collabUi,
      collabAsDefault,
      sessions,
      setSessions,
      setActiveId,
      applyCollabDoc,
      toast,
      setDraftProject,
    ],
  )

  // 项目主页「在 X 里开始…」/ 快捷开始：先进入该项目的空白草稿，再在草稿就位后发送首条消息。
  // 不能与 newSessionInProject 同一拍调用 send：send 同步读 draftProjectRef，但 activeId、模型、
  // 思考档位、上下文档位、团队模式都取自闭包；它们由「activeId 变化」触发的 effect 重置为新会话
  // 的默认值，同一轮 effect 里拿到的 send 仍是旧会话的配置(会把旧会话的模型定格进新会话)。
  // 所以分两拍：①草稿就位(对话工作区 + 无选中 + 草稿归属该项目)时只「上膛」——此时各重置 effect
  // 的 setState 与上膛同批提交；②下一次渲染后的 effect 用新的 send 发送，与手动新建会话后再发一致。
  // nonce 保证只发一次；任一拍发现草稿不在(用户已走开 / 未登录 newSession 直接返回)即丢弃，
  // 不把消息发进别的会话。
  const [pendingProjectStart, setPendingProjectStart] = useState<{
    projectId: string
    text: string
    nonce: number
    armed: boolean
  } | null>(null)
  const consumedProjectStartRef = useRef(0)
  const startInProject = useCallback(
    (projectId: string, text: string) => {
      const t = text.trim()
      if (!t) return
      setBoardOpen(false)
      newSessionInProject(projectId)
      setPendingProjectStart({
        projectId,
        text: t,
        nonce: Date.now() + Math.random(),
        armed: false,
      })
    },
    [setBoardOpen, newSessionInProject],
  )
  useEffect(() => {
    const p = pendingProjectStart
    if (!p || consumedProjectStartRef.current === p.nonce) return
    // demo 的 newSession 会立即建一条本地会话并选中，所以 demo 不要求 activeId 为空。
    const draftReady =
      (demo || activeId === undefined) &&
      !boardOpen &&
      !projectHome &&
      draftProjectId === p.projectId
    if (!draftReady) {
      consumedProjectStartRef.current = p.nonce
      setPendingProjectStart(null)
      return
    }
    if (!p.armed) {
      if (demo && activeId) {
        // demo 的 send 不建会话也不落项目：把刚建的本地会话直接归入项目，侧栏与主页才看得到。
        const title = p.text.slice(0, 40)
        setSessions((c) =>
          c.map((x) =>
            x.id === activeId ? { ...x, projectId: p.projectId, title, messageCount: 1 } : x,
          ),
        )
      }
      setPendingProjectStart({ ...p, armed: true })
      return
    }
    consumedProjectStartRef.current = p.nonce
    setPendingProjectStart(null)
    void send(p.text)
  }, [
    pendingProjectStart,
    activeId,
    boardOpen,
    projectHome,
    draftProjectId,
    send,
    demo,
    setSessions,
  ])

  // 上传单文件 → MediaRef（kind 以服务端 mimeType 为准，退回 file.type）。供 Composer 附件。
  const uploadMedia = useCallback(async (file: File): Promise<MediaRef> => {
    const r = await api.uploadFile(authRef.current, file)
    const mime = r.mimeType || file.type || ''
    const kind: MediaRef['kind'] = mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('video/')
          ? 'video'
          : 'file'
    // 乐观本地渲染:上传时 File 字节在手,建 blob URL 让气泡先渲(消除服务端回显/签名前的裂图
    // 窗口)。仅可预览媒体(image/video/audio)需要;file 走下载卡无预览。localSrc 仅本机 UI:
    // socket.sendMessage 出站帧 + 跨设备持久化 + toStored(IndexedDB)都显式剥离,刷新即回落签名管线。
    const localSrc = kind !== 'file' ? URL.createObjectURL(file) : undefined
    return {
      kind,
      url: r.url,
      mimeType: mime || undefined,
      filename: file.name,
      ...(localSrc ? { localSrc } : {}),
    }
  }, [])

  // 统一图片编辑提交 handler（需求 B/§5）：编辑/评论/调整大小三态联合 → 进主对话生成。
  // 复用 send()→乐观 user 行 + 生成占位卡（socket 注入）。持久化天然满足（guide 非 hidden、
  // 结果走 recordExternalTurn）。ImageAnnotationEditor.onSubmit（无 mode 的 ImageAnnotationExport）
  // 天然落 annotated 分支，向后兼容。
  const submitImageEdit = useCallback(
    async (value: ImageEditSubmit) => {
      if (value.mode === 'resize') {
        // 调整大小（outpaint）：源图（hidden）+ guide（可见），无 mask；带目标比例 targetAspect。
        const [sourceMedia, guideMedia] = await Promise.all([
          uploadMedia(value.source),
          uploadMedia(value.guide),
        ])
        const media: MediaRef[] = [{ ...sourceMedia, hidden: true }, guideMedia]
        await send(value.prompt, media, {
          mode: 'outpaint',
          targetAspect: value.targetAspect,
          clientJobId: value.clientJobId,
          sourceIndex: 0,
          guideIndex: 1,
          width: value.width,
          height: value.height,
        })
        toast('已提交调整大小，成功生成后扣 50 积分', 'success')
        return
      }
      // 编辑/评论（annotated）：源图 + mask（均 hidden）+ guide 三件套（既有链路，逐字保留）。
      const [sourceMedia, maskMedia, guideMedia] = await Promise.all([
        uploadMedia(value.source),
        uploadMedia(value.mask),
        uploadMedia(value.guide),
      ])
      const media: MediaRef[] = [
        { ...sourceMedia, hidden: true },
        { ...maskMedia, hidden: true },
        guideMedia,
      ]
      await send(value.prompt, media, {
        mode: 'annotated',
        clientJobId: value.clientJobId,
        sourceIndex: 0,
        maskIndex: 1,
        guideIndex: 2,
        width: value.width,
        height: value.height,
      })
      toast('已提交精确修改，成功生成后扣 50 积分', 'success')
    },
    [send, toast, uploadMedia],
  )

  // 评论模式提交（ChatGPT 同款「模型驱动精确修改」）：不再合成 mask/guide,而是一条**普通对话
  // 消息** —— media=[原图(可见)] + text=固定前导 + 每锚点百分比坐标行。原图能复用持久
  // /api/media 引用就直接复用(reuseUrl),否则用 ImageCommentMode 取到的字节(sourceFile)上传
  // 一次。由 GPT 看图+坐标调它自己的原生 imagegen 完成精确修改。
  const submitImageComment = useCallback(
    async (value: ImageCommentSubmit) => {
      const ref: MediaRef = value.reuseUrl
        ? { kind: 'image', url: value.reuseUrl }
        : await uploadMedia(value.sourceFile as File)
      await send(value.text, [ref])
      toast('已提交标注修改，模型将按坐标精确修改', 'success')
    },
    [send, uploadMedia, toast],
  )

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
  const image2FeatureOff = publicCfg != null && publicCfg.featureImage2 !== true
  const modelKnownUnsupported = !!modelId && !isCodexEngineModel(modelId)
  const image2Available = !demo && !image2FeatureOff && !modelKnownUnsupported

  return {
    activeId,
    activeIdRef,
    agent,
    applySessionTerminal,
    archiveError,
    archiveLoading,
    archiveRequestTokenRef,
    archiveScrollAnchorRef,
    auth,
    authed,
    authError,
    authLoading,
    authMode,
    authRecoveryAvailable,
    authRef,
    bannersExpanded,
    batchUpdateSessions,
    bindChatScroll,
    boardOpen,
    boardTicketId,
    boardTicketType,
    boardView,
    booting,
    busy,
    chatError,
    chatGptProxyEnabled,
    chatGptProxyOpen,
    chatScrollParent,
    chatViewActiveId,
    chipsBoardProjectId,
    chipsProjectName,
    clearAuth,
    collabAsDefault,
    collabMode,
    collabSaveError,
    collabUi,
    collapsed,
    collapsedProjectIds,
    composerPrefill,
    composerPrefs,
    confirmDialog,
    confirmDialogEl,
    confirmReset,
    containerPreviewUrl,
    contextTier,
    createProject,
    createProjectFrom,
    createProjectMounted,
    cycle,
    deleteProjectConfirm,
    deleteSessionConfirm,
    demo,
    desktopEnroll,
    dismissedSuggestions,
    draftProjectId,
    draftProjectRef,
    findOpen,
    goalOpenNonce,
    handleNew,
    hasMoreSessions,
    historyError,
    historyLoading,
    homeProject,
    image2Available,
    image2FeatureOff,
    imageAnnotationSource,
    inboxMounted,
    inboxOpen,
    isMdViewport,
    isWideViewport,
    laneReady,
    listDeletedProjects,
    liveMediaJob,
    loadArchivedSessions,
    loadingArchived,
    loadingMoreSessions,
    loadMoreError,
    loadMoreSessions,
    lockedModels,
    login,
    logout,
    manageAutoAuthorizePluginSlug,
    manageOpen,
    manageTab,
    marketplaceBrowseKind,
    marketplaceOpen,
    marketplaceTab,
    mediaTasksAvailable,
    mediaTasksOpen,
    messageFeedback,
    messageFeedbackMounted,
    messageFeedbackTriggerRef,
    messageReplyTarget,
    messages,
    mobileNavOpen,
    modelId,
    modelPickerOpen,
    models,
    modelsLoading,
    modelSwitchPreparing,
    moveSessionToProject,
    myAgents,
    newSession,
    newSessionInProject,
    onHydrated,
    openPane,
    openProject,
    orgOpen,
    orgSection,
    paletteMounted,
    paletteOpen,
    paletteSearchAssets,
    paletteSearchMessages,
    paletteUserId,
    paneActive,
    paneOpen,
    paneRequest,
    paneSheetOpen,
    paneToggleRef,
    paneWidth,
    pendingRouteProject,
    pendingRouteSession,
    persistCollab,
    pickerOpen,
    preferenceEffort,
    prepareProjectBoard,
    projectArchiveMounted,
    projectArchiveOpen,
    projectHome,
    projects,
    projectSettings,
    projectSettingsMounted,
    projectSettingsOpen,
    projectsLoaded,
    promptTextEl,
    publicCfg,
    publicCfgRetryNonce,
    queueModelPatch,
    refreshMe,
    register,
    renameProjectPrompt,
    renameSessionPrompt,
    reorderProjects,
    repoBindErrorHandlerRef,
    repoModalMounted,
    repoModalOpen,
    repoStatusHandlerRef,
    requestReset,
    resendVerification,
    resetToken,
    restoreProject,
    retryBoot,
    retryHistory,
    routingEnabled,
    saveToProject,
    saveToProjectMounted,
    scrollRef,
    searchSessionMessages,
    selectModel,
    selectSession,
    send,
    sendImplicitRatingRef,
    serverFeatures,
    serverListSettled,
    serviceTier,
    sessionEffort,
    sessions,
    setActiveId,
    setAgent,
    setArchiveError,
    setArchiveLoading,
    setAuthMode,
    setBannersExpanded,
    setBoardOpen,
    setBoardOpenState,
    setBoardTicketId,
    setBoardTicketType,
    setBoardView,
    setBusy,
    setChatError,
    setChatGptProxyEnabled,
    setChatGptProxyOpen,
    setCollabAsDefault,
    setCollabMode,
    setCollapsed,
    setComposerPrefill,
    setContainerPreviewUrl,
    setContextTier,
    setCreateProjectFrom,
    setDismissedSuggestions,
    setDraftProject,
    setFindOpen,
    setGoalOpenNonce,
    setImageAnnotationSource,
    setInboxOpen,
    setLiveMediaJob,
    setLockedModels,
    setManageAutoAuthorizePluginSlug,
    setManageOpen,
    setManageTab,
    setMarketplaceBrowseKind,
    setMarketplaceOpen,
    setMarketplaceTab,
    setMediaTasksAvailable,
    setMediaTasksOpen,
    setMessageFeedback,
    setMessageReplyTarget,
    setMessages,
    setMobileNavOpen,
    setModelPickerOpen,
    setModelPrefs,
    setModels,
    setModelsLoading,
    setMyAgents,
    setOrgOpen,
    setOrgSection,
    setPaletteOpen,
    setPaneActive,
    setPaneOpen,
    setPaneSheetOpen,
    setPendingRouteProject,
    setPendingRouteSession,
    setPickerOpen,
    setPreferenceEffort,
    setProjectArchived,
    setProjectArchiveOpen,
    setProjectHome,
    setProjectPinned,
    setProjectSettings,
    setPublicCfg,
    setPublicCfgRetryNonce,
    setRepoModalOpen,
    setSaveToProject,
    setServiceTier,
    setSessionEffort,
    setSessions,
    setSettingsOpen,
    setSettingsSection,
    setShareOpen,
    setStreamText,
    setSubscribeOpenSignal,
    setTeamMode,
    setTheme,
    settingsOpen,
    settingsSection,
    settleArchiveAnchor,
    setTutorialCase,
    setTutorialCommunity,
    setTutorialOpen,
    setTutorialStep,
    setTutorialTab,
    setTutorialTopic,
    setTutorialWork,
    setUngroupedAssetsOpen,
    setView,
    shareOpen,
    sidebarWidth,
    sockRef,
    startInProject,
    stoppedTurnRef,
    stopRef,
    streamText,
    submitImageComment,
    submitImageEdit,
    subscribeOpenSignal,
    teamMode,
    theme,
    toast,
    toggleArchiveSession,
    togglePinSession,
    toggleProjectCollapsed,
    toolCards,
    tutorialCase,
    tutorialCommunity,
    tutorialOpen,
    tutorialStep,
    tutorialTab,
    tutorialTopic,
    tutorialWork,
    ungroupedAssetsOpen,
    unreadSessions,
    updateBannerVisible,
    updateProject,
    uploadMedia,
    user,
    verifyEmail,
    view,
  }
}

export type AppState = ReturnType<typeof useAppState>

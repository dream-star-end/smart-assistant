/**
 * App actions, effects and routing: the second half of the App() hook section.
 *
 * Split out of App() verbatim (FINDINGS §7.6 A1, OCV5-472): App calls
 * useAppActions(useAppState()) where its hook section used to be, so React sees the same hooks in
 * the same order and every value is the same binding as before.
 */
import { createGoalStarter } from '../lib/goalStart'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeMessageReplyQuote } from '@openclaude/protocol'
import { applyIntelligentUiSnapshot, useInputPredictionEnabled } from '../lib/intelligentUi'
import { moveComposerAttachments } from '../components/Composer'
import { accountDraftKey, moveDraft, NEW_COMPOSER_DRAFT_KEY } from '../lib/composerDraft'
import type { ImageEditActions } from '../components/chat/imageEditActions'
import { extractLatestTodos } from '../components/chat/PinnedTaskTracker'
import { deriveActivePlanStep, type TurnActivityInfo } from '../components/chat/TurnActivity'
import { isDialogLayerOpen, resolveGlobalHotkey } from '../lib/hotkeys'
import { type ManageTab, normalizeManageTab } from '../lib/manageTabs'
import type { SettingsSection } from '../components/SettingsCenter'
import type { OrgSection } from '../components/OrgCenter'
import type { MarketplaceKind, MarketplaceTab } from '../components/MarketplaceCenter'
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
} from '../components/chat/archivePaging'
import { createStickToBottomController } from '../components/chat/stickToBottom'
import { attachWheelFence } from '../components/chat/wheelFence'
import type { CardCallbacks, FeedbackContext } from '../components/chat/cards'
import type { ArtifactInspectTarget, ChatInteraction } from '../components/tool/context'
import { isBrowserStepMessage } from '../components/tool/browserDetect'
import {
  type DeferredPayloadLoader,
  type PaneTab,
  paneRequestForSession,
} from '../components/InspectorPanel'
import type { ToolLike } from '../components/tool/format'
import { useAgentGate } from '../hooks/useAgentGate'
import { useHistorySkeleton } from '../hooks/useHistorySkeleton'
import { activePanelOf, replaceSearchParams, useAppRoute } from '../hooks/useAppRoute'
import { genWsSessionId } from '../hooks/useSessionList'
import { useChatSocket } from '../hooks/useChatSocket'
import { useResponseRatings } from '../hooks/useResponseRatings'
import { useInbox } from '../hooks/useInbox'
import { useInflightDelegates } from '../hooks/useInflightDelegates'
import { useRepoBinding } from '../hooks/useRepoBinding'
import { githubErrorText } from '../lib/github'
import { connectorErrorText } from '../lib/connectors'
import type { MediaJobWire } from '../lib/chat/frames'
import type { ChatMessage } from '../lib/chat/model'
import {
  exactUserReplayPayload,
  interruptedContinuationTarget,
  preciseRetryEligible,
} from '../lib/chat/socket'
import { findStopTarget } from '../lib/implicitFeedback'
import { CONTINUE_PROMPT } from '../lib/chat/render'
import { deriveLiveTerminalFromMessages } from '../lib/sessionStatus'
import { deriveConnBanner, isPlatedAssistantMessage, lastRealUserTurn } from '../lib/chat/pure'
import { useDelayedConnBanner } from '../hooks/useDelayedConnBanner'
import { DEFAULT_AGENT, agentFromApiRow, type Agent } from '../lib/agents'
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from '../lib/productCapabilities'
import { resolveTutorialAction } from '../lib/tutorialActions'
import type { TutorialCase } from '../lib/tutorialCaseCatalog'
import { api, apiErrorMessage } from '../lib/api'
import { reportClientFriction } from '../lib/clientFriction'
import { effectiveEffortModelId, extractPrefs, type PrefsView } from '../lib/modelPreferences'
import type { Session, SessionLastOutcome } from '../lib/types'
import type { LockedSelectInfo } from '../components/ModelSelector'
import { lockedModelUnlockNotice } from '../lib/cursorModelPicker'
import { TASKBOARD_ENABLED } from '../lib/taskboardFeature'
import { EMPTY_WS_MESSAGES, type PredictInput, replyQuoteText } from './appHelpers'
import type { AppState } from './useAppState'

export function useAppActions(state: AppState) {
  const {
    activeId,
    activeIdRef,
    agent,
    applySessionTerminal,
    archiveLoading,
    archiveRequestTokenRef,
    archiveScrollAnchorRef,
    auth,
    authed,
    authRef,
    boardOpen,
    boardTicketId,
    boardTicketType,
    boardView,
    busy,
    chatScrollParent,
    chipsBoardProjectId,
    chipsProjectName,
    confirmDialog,
    demo,
    draftProjectRef,
    handleNew,
    historyError,
    historyLoading,
    image2Available,
    image2FeatureOff,
    isWideViewport,
    laneReady,
    manageOpen,
    marketplaceOpen,
    messageFeedbackTriggerRef,
    messageReplyTarget,
    messages,
    modelId,
    models,
    myAgents,
    newSession,
    onHydrated,
    openPane,
    orgOpen,
    paneOpen,
    paneRequest,
    paneSheetOpen,
    paneToggleRef,
    pendingRouteProject,
    pendingRouteSession,
    preferenceEffort,
    projectHome,
    projects,
    projectsLoaded,
    publicCfgRetryNonce,
    queueModelPatch,
    refreshMe,
    repoBindErrorHandlerRef,
    repoStatusHandlerRef,
    routingEnabled,
    scrollRef,
    selectSession,
    send,
    sendImplicitRatingRef,
    serverListSettled,
    sessionEffort,
    sessions,
    setActiveId,
    setAgent,
    setArchiveError,
    setArchiveLoading,
    setAuthMode,
    setBoardOpen,
    setBoardOpenState,
    setBoardTicketId,
    setBoardTicketType,
    setBoardView,
    setBusy,
    setChatError,
    setChatGptProxyEnabled,
    setChatGptProxyOpen,
    setCollapsed,
    setComposerPrefill,
    setFindOpen,
    setImageAnnotationSource,
    setInboxOpen,
    setLiveMediaJob,
    setLockedModels,
    setManageOpen,
    setManageTab,
    setMarketplaceBrowseKind,
    setMarketplaceOpen,
    setMarketplaceTab,
    setMediaTasksAvailable,
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
    setPaneOpen,
    setPaneSheetOpen,
    setPendingRouteProject,
    setPendingRouteSession,
    setPickerOpen,
    setPreferenceEffort,
    setProjectHome,
    setPublicCfg,
    setPublicCfgRetryNonce,
    setRepoModalOpen,
    setSaveToProject,
    setSessions,
    setSettingsOpen,
    setSettingsSection,
    setShareOpen,
    setStreamText,
    setSubscribeOpenSignal,
    settingsOpen,
    settleArchiveAnchor,
    setTutorialCase,
    setTutorialCommunity,
    setTutorialOpen,
    setTutorialStep,
    setTutorialTab,
    setTutorialTopic,
    setTutorialWork,
    setView,
    sockRef,
    stoppedTurnRef,
    stopRef,
    streamText,
    submitImageComment,
    submitImageEdit,
    teamMode,
    toast,
    tutorialCase,
    tutorialCommunity,
    tutorialOpen,
    tutorialStep,
    tutorialTab,
    tutorialTopic,
    tutorialWork,
    user,
    view,
  } = state

  const image2UnavailableReason = image2Available
    ? undefined
    : image2FeatureOff
      ? 'Image 2 暂未开放或正在维护'
      : '当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型'
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const imageEditActions = useMemo<ImageEditActions>(
    () => ({
      submitImageEdit: image2Available ? submitImageEdit : undefined,
      submitImageComment: image2Available ? submitImageComment : undefined,
      annotate: image2Available ? setImageAnnotationSource : undefined,
      annotateUnavailableReason: image2UnavailableReason,
    }),
    [image2Available, submitImageEdit, submitImageComment, image2UnavailableReason],
  )

  // 会话物化:新建按钮本身只进入空白草稿态；GitHub 绑定 / 设定目标这类明确依赖
  // per-session 身份的首轮前操作，才在用户确认操作时物化一个会话 id。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const ensureActiveSession = useCallback((): string | undefined => {
    if (demo || !user) return activeId
    if (activeId) return activeId
    const id = genWsSessionId()
    const s: Session = {
      id,
      title: '新对话',
      ownerUserId: user.id,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      ...(modelId ? { modelId } : {}),
    }
    // 首轮前操作会紧接着 ensureServerSession/sendRepoBind；先把空白态显式模型写入
    // ChatSession，确保建行 PUT 与后续首发都携带同一选择，不被 activeId effect 回落默认值。
    sockRef.current?.ensureSession(id, agent.id, '新对话')
    if (modelId) sockRef.current?.setSessionModel(id, modelId)
    setSessions((c) => [s, ...c])
    // This is an identity promotion, not navigation to another conversation. Preserve
    // the unsent draft; normal send consumes/clears it in Composer instead.
    moveDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, user.id), accountDraftKey(id, user.id))
    moveComposerAttachments(
      accountDraftKey(NEW_COMPOSER_DRAFT_KEY, user.id),
      accountDraftKey(id, user.id),
    )
    setActiveId(id)
    return id
  }, [demo, user, activeId, agent.id, modelId, setSessions, setActiveId])

  // 打开 GitHub 绑定 modal:先确保有承载会话,否则「确认绑定」因 !sessionId 恒禁用
  // (输入框底部入口 → 发消息前即可绑定)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openRepo = useCallback(() => {
    ensureActiveSession()
    setRepoModalOpen(true)
  }, [ensureActiveSession])

  /** Resolve a lazy user locator to its immutable persisted row for one
   * action. The hydrated object stays on the stack; it is never merged into
   * ChatSocket/IndexedDB, so even a huge prompt does not bloat hot history. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const loadExactUserMessage = useCallback(
    async (message: ChatMessage): Promise<ChatMessage | null> => {
      if (message._userPayloadDeferred !== true) return message
      if (!activeId) return null
      const payloadId = message._userPayloadId ?? message.id
      const records = await sockRef.current?.fetchUserMessagePayload(activeId, payloadId, {
        recordId: payloadId,
        role: 'user',
        ...(message._payloadSha256 ? { contentSha256: message._payloadSha256 } : {}),
      })
      const exact = records?.find((record) => record.id === payloadId && record.role === 'user')
      if (!exact) return null
      return {
        ...exact,
        // Actions target the current logical/dispatch row while payload reads
        // continue using the immutable sidecar id above.
        id: message.id,
        _userPayloadId: payloadId,
        status: message.status ?? exact.status,
        _routing: exact._routing ?? message._routing,
        _sendAttempt: message._sendAttempt ?? exact._sendAttempt,
      }
    },
    [activeId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const regenerate = useCallback(async () => {
    // demo 用本地 messages；非 demo 找 WS 末条 user 重发。
    if (demo) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          await send(messages[i].content ?? '')
          return
        }
      }
      return
    }
    // 保真重发:_modelText 是"含附件的完整模型可见文本"(权威,regen 专用字段),text 只是
    // 显示文案;media 一并透传 —— 此前只回发显示文本,带附件的提问 regen 后附件全丢。
    // 跳过恢复/续跑控制行:那是系统续接指令,不是用户的真实提问。判定走持久血缘,
    // 不依赖会在 refresh / server-wins 中丢失的 `_isAutoRetry`。
    const src = sockRef.current?.getMessages(activeId) ?? []
    const m = lastRealUserTurn(src)
    if (!m) return
    const exact = await loadExactUserMessage(m)
    if (!exact) {
      toast('原始消息加载失败，请重试', 'error')
      return
    }
    const replay = exactUserReplayPayload(exact)
    await send(replay.text, replay.media, replay.imageEdit, replay.displayText)
  }, [demo, messages, activeId, send, loadExactUserMessage, toast])

  // 打开设置中心并顺带刷新余额（顶栏 pill / 侧栏 / AgentGate 充值入口统一走此）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openSettings = useCallback(
    (section: SettingsSection = 'account') => {
      void refreshMe()
      setSettingsSection(section)
      setSettingsOpen(true)
    },
    [refreshMe],
  )

  // OCV5-86:锁定模型先弹说明(为什么锁、任意订阅即可解锁),用户确认后才跳订阅面板;
  // 之前一句 toast 直接跳转,用户不知道任何一档订阅都够。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const handleLockedSelect = useCallback(
    (info: LockedSelectInfo) => {
      const notice = lockedModelUnlockNotice(info)
      void (async () => {
        const go = await confirmDialog({
          title: notice.title,
          body: (
            <div className="space-y-2 text-sm text-muted" data-testid="locked-model-unlock-notice">
              {notice.paragraphs.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ),
          confirmText: notice.confirmText,
          cancelText: notice.cancelText,
        })
        if (go !== true) return
        openSettings('account')
        setSubscribeOpenSignal((n) => n + 1)
      })()
    },
    [confirmDialog, openSettings],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const applyConversationPreferences = useCallback(
    (prefs: PrefsView, _patch?: Record<string, unknown>) => {
      setPreferenceEffort(prefs.default_effort)
      // default_model 变更经 modelPrefs → resolver effect 传导:只影响「无自有持久化选择」
      // 的会话与空会话态;已显式选过模型的会话保持自身选择(per-session 隔离语义)。
      setModelPrefs(prefs)
    },
    [],
  )

  // 打开管理中心到指定分区（侧栏入口 + 工具卡「打开记忆/技能/定时」按钮统一走此）。
  // 归一化：已下线分区（文献 / 优化）或未知值从旧入口进来时回落默认分区，不开空白页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openManage = useCallback((tab: ManageTab) => {
    setManageTab(normalizeManageTab(tab))
    setManageOpen(true)
  }, [])

  // 打开 AI 市场到指定分区（侧栏入口 / 「从市场添加智能体」)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openMarketplace = useCallback((tab: MarketplaceTab, kind: MarketplaceKind = 'skill') => {
    setMarketplaceTab(tab)
    setMarketplaceBrowseKind(kind)
    setMarketplaceOpen(true)
  }, [])

  // 打开组织中心(企业版第四中心;仅 owner/admin 有入口)。顺带刷新余额/归属。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openOrg = useCallback(
    (section: OrgSection = 'overview') => {
      void refreshMe()
      setOrgSection(section)
      setOrgOpen(true)
    },
    [refreshMe],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from useAppState() are the same stable setters/refs
  const openTutorial = useCallback((id?: ProductFeatureId) => {
    // 教程是单一顶层中心：打开前收起其他中心，避免多层 Radix Dialog 叠加与焦点陷阱互抢。
    setSettingsOpen(false)
    setManageOpen(false)
    setMarketplaceOpen(false)
    setOrgOpen(false)
    setTutorialTopic(id ?? null)
    setTutorialCase(null)
    setTutorialCommunity(null)
    setTutorialTab(null)
    setTutorialWork(null)
    setTutorialStep(null)
    setTutorialOpen(true)
  }, [])

  // 键盘快捷键：⌘/Ctrl+K 新会话；Esc 停止当前（demo）流式。仅在进入工作区后生效。
  const inWorkspace = demo || (view === 'app' && !!auth && !!user)
  const settingsFeedbackContext = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'assistant' && message.traceId) {
        return { sessionId: activeId ?? null, requestId: message.traceId }
      }
    }
    return { sessionId: activeId ?? null, requestId: null }
  }, [activeId, messages])

  const tutorialActionContext = useMemo(
    () => ({
      authenticated: inWorkspace,
      featureImage2: image2Available,
      microphone:
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== 'undefined',
      orgRole: user?.org?.role ?? null,
      // 商业构建关掉任务面板时「任务面板」教程的 CTA 不再可点却什么都不发生（tutorials TU-32）；
      // 与下方 runTutorialAction 的 taskboard 分支同一开关。
      taskboardEnabled: TASKBOARD_ENABLED,
    }),
    [inWorkspace, image2Available, user?.org?.role],
  )

  const focusProductFeature = useCallback((id: string) => {
    const focus = (attempt = 0) => {
      // 若用户已在等待期间主动聚焦别处，不再抢焦点；只有 body/目标本身才允许重试。
      const active = document.activeElement as HTMLElement | null
      if (
        attempt > 0 &&
        active &&
        active !== document.body &&
        active.dataset.productFeature !== id
      ) {
        return
      }
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-product-feature="${id}"]`),
      )
      const target = candidates.find((element) => element.getClientRects().length > 0)
      target?.focus({ preventScroll: false })
      // Radix Dialog 的 inert/focus-scope 清理可能跨帧完成；首次 focus 被浏览器拒绝时小步重试。
      if (target && document.activeElement !== target && attempt < 3) {
        window.setTimeout(() => focus(attempt + 1), 160)
        return
      }
      target?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    }
    // Dialog 卸载后的 Radix 焦点恢复会晚于当前 click 栈；等关闭过渡/门户清理完成再把焦点
    // 交给真实功能，否则最终会落回 <body>，视觉上“跳过去了”但键盘用户没有抵达。
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(() => focus(), 120)))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const runTutorialAction = useCallback(
    (feature: ProductCapability) => {
      const resolved = resolveTutorialAction(feature, tutorialActionContext)
      if (!resolved.enabled) return
      setTutorialOpen(false)
      const destination = feature.destination
      switch (destination.kind) {
        case 'new-chat':
          handleNew()
          focusProductFeature(PRODUCT_CAPABILITIES.chatBasics.id)
          break
        case 'focus':
          if (destination.target === PRODUCT_CAPABILITIES.sessions.id) {
            if (window.matchMedia('(max-width: 767px)').matches) setMobileNavOpen(true)
            else setCollapsed(false)
          }
          focusProductFeature(destination.target)
          break
        case 'agent-picker':
          setPickerOpen(true)
          break
        case 'settings':
          openSettings(destination.section)
          break
        case 'manage':
          openManage(destination.tab)
          break
        case 'market':
          openMarketplace(destination.tab, destination.marketKind ?? 'skill')
          break
        case 'inbox':
          setInboxOpen(true)
          break
        case 'github':
          openRepo()
          break
        case 'org':
          openOrg(destination.section)
          break
        case 'taskboard':
          if (TASKBOARD_ENABLED) {
            setCollapsed(false)
            setBoardOpen(true)
          }
          break
      }
    },
    [
      tutorialActionContext,
      handleNew,
      focusProductFeature,
      openSettings,
      openManage,
      openMarketplace,
      openRepo,
      openOrg,
      setBoardOpen,
    ],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const runTutorialCase = useCallback(
    (item: TutorialCase) => {
      setTutorialOpen(false)
      if (!inWorkspace) {
        try {
          sessionStorage.setItem(
            'oc_v5_pending_case',
            JSON.stringify({ caseId: item.id, starterPrompt: item.starterPrompt }),
          )
        } catch {
          /* quota / private mode */
        }
        setAuthMode('login')
        setView('app')
        return
      }
      handleNew()
      setComposerPrefill({ text: item.starterPrompt, nonce: Date.now() })
    },
    [inWorkspace, handleNew],
  )

  // 登录后消费待跑案例：只在 inWorkspace false→true 时读一次；有键先删再预填，禁止自动发送。
  const wasInWorkspaceRef = useRef(inWorkspace)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    const entered = inWorkspace && !wasInWorkspaceRef.current
    wasInWorkspaceRef.current = inWorkspace
    if (!entered) return
    let raw: string | null = null
    try {
      raw = sessionStorage.getItem('oc_v5_pending_case')
      if (!raw) return
      sessionStorage.removeItem('oc_v5_pending_case')
    } catch {
      return
    }
    let text = ''
    let fromLanding = false
    try {
      const parsed = JSON.parse(raw) as { starterPrompt?: unknown; source?: unknown }
      if (typeof parsed.starterPrompt === 'string') text = parsed.starterPrompt
      fromLanding = parsed.source === 'landing'
    } catch {
      return
    }
    if (!text) return
    handleNew()
    setComposerPrefill({ text, nonce: Date.now() })
    toast(
      fromLanding ? '已带入你在首页写下的任务，不会自动发送' : '已带入案例指令，不会自动发送',
      'info',
    )
  }, [inWorkspace, handleNew, toast])

  // 站内信未读轮询（铃铛红点）。demo / 未登录不发请求。
  const inbox = useInbox(auth, inWorkspace && !demo)

  // GitHub OAuth 回调返回：URL 带 ?github_linked / ?github_error → toast + 清 query（仅一次，
  // 对齐 v3 handleBootGithubParams）。redirect 回 /?github_linked=1，全局 toast 即时反馈。
  const githubReturnHandledRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo || githubReturnHandledRef.current) return
    githubReturnHandledRef.current = true
    const sp = new URLSearchParams(window.location.search)
    let touched = false
    if (sp.has('github_linked')) {
      toast('GitHub 账号已连接', 'success')
      sp.delete('github_linked')
      touched = true
    }
    if (sp.has('github_error')) {
      toast(`GitHub 连接失败：${githubErrorText(sp.get('github_error'))}`, 'error')
      sp.delete('github_error')
      touched = true
    }
    // 应用连接器 BYOA OAuth 回调（照 github_linked 模式）：/?connector_linked=<provider> 或
    // /?connector_error=<code>（错误码经 connectorErrorText 映射中文，不裸露码）。
    if (sp.has('connector_linked')) {
      // 用户向名词全链路统一为「插件」（市场品类 / 管理中心 Tab / 本 toast 同名）。
      toast('插件已连接', 'success')
      setManageTab('connectors')
      setManageOpen(true)
      sp.delete('connector_linked')
      touched = true
    }
    if (sp.has('connector_error')) {
      toast(`插件连接失败：${connectorErrorText(sp.get('connector_error'))}`, 'error')
      sp.delete('connector_error')
      touched = true
    }
    if (touched) replaceSearchParams(sp)
  }, [demo, toast])

  // 组织邀请接受流:URL 带 ?orgInvite=<token>。已登录 → 确认弹层 → accept → 刷新 /api/me;
  // 未登录 → token 留在 URL(不清),先走 AuthGate 登录/注册,进工作区后本 effect 再触发续接。
  const orgInviteTokenRef = useRef<string | null>(
    !demo && routingEnabled ? new URLSearchParams(location.search).get('orgInvite') : null,
  )
  const orgInviteHandledRef = useRef(false)
  useEffect(() => {
    if (demo || orgInviteHandledRef.current) return
    const token = orgInviteTokenRef.current
    if (!token) return
    // 未进工作区(未登录)→ 保留 token,等登录完成后再处理(effect 依赖变化会重跑)。
    if (!inWorkspace || !auth || !user) return
    orgInviteHandledRef.current = true
    const a = auth
    void (async () => {
      const ok = await confirmDialog({
        title: '接受组织邀请?',
        body: '你被邀请加入一个组织。接受后你的对话用量将可计入该组织钱包。',
        confirmText: '接受邀请',
      })
      // 无论接受与否都清掉 query,避免刷新重复弹层。
      const sp = new URLSearchParams(window.location.search)
      sp.delete('orgInvite')
      replaceSearchParams(sp)
      if (!ok) return
      try {
        await api.acceptOrgInvitation(a, token)
        await refreshMe()
        toast('已加入组织', 'success')
      } catch (e) {
        toast(apiErrorMessage(e, '接受组织邀请失败'), 'error')
      }
    })()
  }, [demo, inWorkspace, auth, user, confirmDialog, refreshMe, toast])

  // 进入登录页（view=app 且未认证）时拉公开配置：决定 AuthGate 是否渲染真 Turnstile
  // widget。短暂失败自动重试；停在首页（home）/demo/已登录均不拉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo || authed || view !== 'app') return
    void publicCfgRetryNonce
    let cancelled = false
    let retryTimer: number | undefined
    api
      .getPublicConfig()
      .then((c) => {
        if (!cancelled) {
          setPublicCfg(c)
        }
      })
      .catch(() => {
        if (!cancelled) {
          /* 拿不到 config：publicCfg 维持 null → AuthGate fail-closed（bypass 未知时点击只
           * 登记 intent，绝不发占位 token）。短暂失败自动恢复，不形成永久灰锁。 */
          retryTimer = window.setTimeout(() => setPublicCfgRetryNonce((n) => n + 1), 1000)
        }
      })
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [demo, authed, view, publicCfgRetryNonce])

  // 进入工作区后拉取模型列表（公开端点；登录态带 Bearer 走 grants 视图）。失败不阻断
  // 对话前置——选择器降级为「暂无可用模型」，对话仍可在订阅就绪后进行。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo || !auth) return
    let cancelled = false
    setModelsLoading(true)
    Promise.all([
      api.getPublicModels(auth),
      api
        .getPreferences(auth)
        .then((snap) => {
          // Intelligent UI 开关(OCV5-361)与模型偏好同批水合。
          applyIntelligentUiSnapshot(snap)
          return extractPrefs(snap)
        })
        .catch(() => ({}) as PrefsView),
    ])
      .then(([catalog, prefs]) => {
        if (cancelled) return
        setModels(catalog.models)
        setLockedModels(catalog.lockedModels)
        // 初始 modelId 不在此直接写:models/modelPrefs 落定会触发 per-session resolver
        // effect,按「活动会话持久化选择 > default_model > 首个健康模型」统一解析。
        setModelPrefs(prefs)
        setPreferenceEffort(prefs.default_effort)
      })
      .catch(() => {
        /* 公开端点失败：保持空列表，选择器禁用，不弹错误打断前置流程 */
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [demo, auth])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const fetchMyAgents = useCallback(async (): Promise<Agent[]> => {
    if (demo || !auth) return [DEFAULT_AGENT]
    const rows = await api.listMyAgents(authRef.current)
    return rows.map(agentFromApiRow)
  }, [demo, auth])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const refreshMyAgents = useCallback(async (): Promise<Agent[]> => {
    const rows = await fetchMyAgents()
    setMyAgents(rows)
    return rows
  }, [fetchMyAgents])

  // 已装智能体目录:登录后拉一次(会话 agent 归属解析用;失败留默认,解析回落 stub 不阻断)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo || !auth) return
    let cancelled = false
    fetchMyAgents()
      .then((rows) => {
        if (!cancelled) setMyAgents(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [demo, auth, fetchMyAgents])

  // 对话前置态机：检查订阅/容器、引导开通、轮询容器至就绪。gate.access=false 时由
  // AgentGate 面板占据对话区并禁用 Composer；gate.ready 是 P4 useChatSocket 连接的硬前置。
  const gate = useAgentGate(auth, inWorkspace && !demo)

  // P4 真实 WS 对话引擎。gate.ready（容器 running）是连接硬前置；refreshMe 供
  // cost_charged / 余额不足时刷新顶栏余额。demo 不连真实 WS。
  const chat = useChatSocket({
    auth,
    ready: gate.ready,
    // cohort lane 就绪（P3 RFC D1）：与 gate.ready 正交的 WS 连接前置，防首连落错 slot。
    laneReady,
    enabled: inWorkspace && !demo,
    defaultAgentId: 'main',
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
  })
  sockRef.current = chat // 回填稳定句柄（供上方 send/regenerate/历史方法引用）。

  // GitHub 仓库绑定：当前活动会话的 selection + 克隆进度 + 版本门控（v5 版 github.js）。
  const repo = useRepoBinding({
    auth,
    activeId,
    agentId: agent.id,
    enabled: inWorkspace && !demo,
    sendRepoBind: chat.sendRepoBind,
    sendRepoUnbind: chat.sendRepoUnbind,
    toast,
  })
  // 回填帧处理器（稳定 useCallback；render 期赋值幂等，与 useChatSocket persistRef 同模式）。
  repoStatusHandlerRef.current = repo.onRepoStatus
  repoBindErrorHandlerRef.current = repo.onRepoBindError

  // agent 归属单一权威 = 活动会话的 sess.agentId。此前"当前 agent"是独立全局态,切会话
  // 不 reconcile → 在会话 A 切到编程助手后选中旧会话 B(agentId=main),header/send 显示
  // 编程助手而 sess.agentId 仍是 main:stopTurn/hello 续传游标用错 agent(停止停不掉本轮)、
  // §11 跨 agent 污染守卫也未打戳。收口:切会话/历史合并后把 App.agent 同步为会话归属。
  const activeSessAgentId = !demo && activeId ? chat.getSession(activeId)?.agentId : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (!activeSessAgentId) return
    const resolved =
      activeSessAgentId === DEFAULT_AGENT.id
        ? DEFAULT_AGENT
        : (myAgents.find((a) => a.id === activeSessAgentId && a.ready !== false) ?? DEFAULT_AGENT)
    if (resolved.id === DEFAULT_AGENT.id && activeSessAgentId !== DEFAULT_AGENT.id && activeId) {
      chat.switchAgent(activeId, DEFAULT_AGENT.id)
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
      setAgent(resolved)
    }
  }, [activeSessAgentId, activeId, agent.id, agent.name, agent.avatarEmoji, myAgents, chat])

  // 非 demo：展示的消息来自 WS service 快照（就地 mutation + version 触发重渲）。
  const wsMessages = !demo && activeId ? chat.getMessages(activeId) : EMPTY_WS_MESSAGES
  // 分享对话框只针对打开时的会话;切会话(返回键/深链)就关掉,不拿旧快照配新标题。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId 是触发条件
  useEffect(() => {
    setShareOpen(false)
  }, [activeId])
  const wsSending = !demo && chat.isSending(activeId)
  // 统一“本轮进行中”信号：demo 用本地 busy，非 demo 用 WS in-flight。
  const sending = demo ? busy : wsSending
  activeIdRef.current = activeId ?? null
  // 详情面板可用 = 对话视图(非任务看板 / 项目主页)里有会话内容;demo 只在点了某张工具卡时出现。
  const paneAvailable =
    !boardOpen &&
    !projectHome &&
    (demo ? !!paneRequest?.message : !!activeId && wsMessages.length > 0)
  const paneRequestHere = paneRequestForSession(paneRequest, activeId)
  const paneInline = paneAvailable && isWideViewport && paneOpen
  const paneShown = paneInline || (paneAvailable && !isWideViewport && paneSheetOpen)
  const togglePane = () => {
    if (paneShown) {
      if (isWideViewport) setPaneOpen(false)
      else setPaneSheetOpen(false)
      return
    }
    openPane()
  }
  paneToggleRef.current = paneAvailable && !demo ? togglePane : null
  const inflightDelegates = useInflightDelegates({
    sessionId: !demo && activeId ? activeId : null,
    messages: wsMessages,
    enabled: !demo && gate.access && !!activeId,
    auth,
  })

  const sendingIdsRef = useRef(new Set<string>())
  const liveTerminalsRef = useRef(
    new Map<string, { lastOutcome: SessionLastOutcome; lastErrorCode: string | null }>(),
  )
  const liveTerminals = useMemo(() => {
    void chat.version
    if (demo) return liveTerminalsRef.current
    const now = new Set(sessions.filter((s) => chat.isSending(s.id)).map((s) => s.id))
    for (const id of now) liveTerminalsRef.current.delete(id)
    for (const id of sendingIdsRef.current) {
      if (!now.has(id)) {
        const t = deriveLiveTerminalFromMessages(chat.getSession(id)?.messages)
        if (t) liveTerminalsRef.current.set(id, t)
      }
    }
    sendingIdsRef.current = now
    return new Map(liveTerminalsRef.current)
  }, [demo, chat, sessions])
  useEffect(() => {
    for (const [id, t] of liveTerminals) applySessionTerminal(id, t)
  }, [liveTerminals, applySessionTerminal])

  const liveTerminal = useCallback((id: string) => liveTerminals.get(id), [liveTerminals])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveGlobalHotkey(e)
      if (action === 'search') {
        if (!inWorkspace) return
        e.preventDefault()
        // Toggle. Another dialog layer (settings, drawer, …) keeps Esc/focus; don't stack on it.
        const otherLayer = isDialogLayerOpen()
        setPaletteOpen((o) => (o ? false : !otherLayer))
        return
      }
      if (action === 'new') {
        e.preventDefault()
        setBoardOpen(false)
        handleNew()
      }
      if (action === 'find') {
        if (!inWorkspace || demo || wsMessages.length <= 0) return
        e.preventDefault()
        setFindOpen(true)
      }
      if (action === 'pane') {
        if (!inWorkspace || !paneToggleRef.current) return
        e.preventDefault()
        paneToggleRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNew, inWorkspace, demo, wsMessages.length, setBoardOpen])

  // 当前选中会话（对账/本轮活动指示的数据源）。告知 WS service 供 S1 对账无条件优先拉它。
  const activeSess = !demo && activeId ? chat.getSession(activeId) : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo) return
    sockRef.current?.setActiveSession(activeId)
  }, [demo, activeId])

  // Goal state is platform-owned (PG), not part of the browser session blob.
  // Fetch on session selection; live updates arrive through sys.goal_snapshot.
  // Draft sessions with no client_sessions row used to 404; the route now
  // returns 200 {goal:null}, and a missing goal is a no-op here.
  // 只随登录身份变化重拉(user 对象 refreshMe 会换引用,不应触发)。
  const goalUserId = user?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (demo || !activeId || !goalUserId) return
    let cancelled = false
    void api
      .getSessionGoal(authRef.current, activeId)
      .then((goal) => {
        if (!cancelled) sockRef.current?.setGoalState(activeId, goal)
      })
      .catch(() => {
        // A just-created session can briefly race its first server upsert. The
        // next selection or goal action retries; do not poison chat readiness.
      })
    return () => {
      cancelled = true
    }
  }, [demo, activeId, goalUserId])

  const goalStarterRef = useRef(createGoalStarter())
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const setSessionGoal = useCallback(
    async (input: {
      objective: string
      tokenBudget: number | null
      creditBudget: string | null
      expectedStateRevision: number
    }) => {
      const auth = authRef.current
      if (!auth) throw new Error('请先登录后再设置目标')
      const sessionId = activeId ?? ensureActiveSession()
      if (!sessionId) throw new Error('会话尚未就绪，请稍后重试')
      const sessionTitle =
        activeSess?.title ?? sessions.find((session) => session.id === sessionId)?.title ?? '新对话'
      const projectId = draftProjectRef.current
      await goalStarterRef.current(sessionId, {
        isBusy: () => !!sockRef.current?.isSending(sessionId),
        save: async () => {
          const ensured = await sockRef.current?.ensureServerSession(
            sessionId,
            agent.id,
            sessionTitle,
          )
          if (!ensured) throw new Error('会话尚未创建成功，请检查网络后重试')
          return api.setSessionGoal(auth, sessionId, input)
        },
        apply: (goal) => sockRef.current?.setGoalState(sessionId, goal),
        start: (goal) => {
          if (authRef.current !== auth || !sockRef.current?.getSession(sessionId)) {
            throw new Error('登录状态已变化或原会话已关闭')
          }
          return send(goal.objective, undefined, undefined, undefined, undefined, {
            sessionId,
            projectId,
          })
        },
      })
    },
    [activeId, activeSess?.title, agent.id, ensureActiveSession, sessions, send],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const transitionSessionGoal = useCallback(
    async (action: 'pause' | 'resume' | 'complete' | 'clear') => {
      const auth = authRef.current
      if (!auth || !activeId) return
      const revision = sockRef.current?.getSession(activeId)?.goalState?.stateRevision
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) {
        throw new Error('目标状态尚未加载，请稍后重试')
      }
      const goal = await api.transitionSessionGoal(auth, activeId, action, revision)
      sockRef.current?.setGoalState(activeId, goal)
    },
    [activeId],
  )

  // 本轮活动快照（喂给 MessageList → TurnActivity）：模型慢时把阶段反馈显性化，取代裸三个点。
  // 团队模式额外带队长当前 plan step（消息区常长时间纯空白时用它填充等待文案）。
  const teamLeaderActive = !demo && teamMode && agent.id === 'main'
  // 思考档位选择器数据:按当前**执行**模型(团队模式下 = 队长引擎,与 send 同口径)
  // 的支持集渲染选项;生效档 = 会话显式选择 ?? 全局偏好,不被当前模型支持时如实
  // 显示「跟随」(发送层 effortForModel 同样过滤,所见 = 所发)。
  const effortModel = models.find((m) => m.id === effectiveEffortModelId(modelId, teamLeaderActive))
  const effortSupported = effortModel?.supported_efforts ?? []
  const effortCandidate = sessionEffort !== undefined ? sessionEffort : preferenceEffort
  const effortActive =
    effortCandidate != null && effortSupported.includes(effortCandidate) ? effortCandidate : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.version 是就地 mutation 会话的刷新触发器(见末行注释)。
  const turnActivity = useMemo<TurnActivityInfo | null>(() => {
    if (demo || !activeSess) return null
    // OCV5-428: a message still in the local journal (transport down, or on the wire
    // without the server's admission ACK) gets its own row; 「思考中」 waits for admission.
    const dispatch = chat.dispatchStatus(activeSess.id)
    if (!activeSess._sendingInFlight && !dispatch) return null
    return {
      dispatch,
      startedAt: activeSess._turnStartedAt ?? null,
      lastFrameAt: activeSess._lastFrameAt,
      progressHint: activeSess._turnProgressHint,
      hasPlated: wsMessages.some(
        (m) =>
          isPlatedAssistantMessage(m) &&
          (!activeSess._activeClientMessageId ||
            m._clientMessageId === activeSess._activeClientMessageId),
      ),
      turnStatus: activeSess._turnStatus ?? null,
      recoveryStatus: activeSess._recoveryStatus ?? null,
      hasVisibleProcess:
        activeSess._liveUnitsPackApplied === true ||
        wsMessages.some(
          (m) =>
            m._liveUnit === true ||
            m.role === 'thinking' ||
            m.role === 'tool' ||
            m.role === 'agent-group' ||
            m.role === 'plan',
        ),
      coldStart: !!activeSess._isFirstTurnAfterReady,
      agentName: agent.name || '助手',
      leaderStep: teamLeaderActive ? deriveActivePlanStep(extractLatestTodos(wsMessages)) : null,
    }
    // chat.version 是就地 mutation 会话的变更权威信号（同引用，须显式入依赖才随帧刷新）。
  }, [
    demo,
    activeSess,
    teamLeaderActive,
    agent.name,
    wsMessages,
    chat.version,
    chat.dispatchStatus,
  ])

  // 对话前置门：非 demo 且尚无访问权（容器未就绪/未订阅/出错等）→ 由 AgentGate 占据对话区
  // 并禁用 Composer。demo 与已就绪（ready|dormant）放行正常对话。
  const gated = !demo && !gate.access
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
  })

  // 会话级 transient 软提示（"较长时间未收到新内容…"）：非消息卡片、不落库；随快照读回。
  const transientNotice = !demo && activeId ? chat.getTransientNotice(activeId) : null
  // 弱网/重连状态条三态分流（离线 / 环境启动中 / 服务端重连中）。文案与 tone 收口在
  // deriveConnBanner（纯函数，单测锁定）；返回 null 时不显条。demo 恒不显（本地回放无 WS）。
  const rawConnBanner = demo
    ? null
    : deriveConnBanner({
        cls: chat.status.cls,
        label: chat.status.label,
        browserOnline: chat.browserOnline,
        provisioning: chat.provisioning,
      })
  // 横幅 2s 延迟（P3 RFC D6）：断开 >2s 才点亮，2s 内重连成功零闪烁。只作用于横幅显示——
  // deriveConnBanner 仍即时反映断线真相，断线排队/禁发等发送语义不受影响。
  const connBanner = useDelayedConnBanner(rawConnBanner)
  // 停止当前轮：demo 本地停回放；非 demo 发 inbound.control.stop 并本地收尾。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const stopTurn = useCallback(() => {
    if (demo) {
      stopRef.current = true
      setBusy(false)
      setStreamText('')
    } else if (activeId) {
      // 隐式负反馈（中途打断）：过秒停窗后 Stop → 对本轮末条 assistant 静默记 implicit down。
      // 现场取消息（chat 已在依赖内），不捕获每帧刷新的 wsMessages。
      const stopTarget = findStopTarget(chat.getMessages(activeId), Date.now())
      if (stopTarget) sendImplicitRatingRef.current?.(stopTarget, { reason: '中途打断' })
      // 本轮由用户主动打断 → 不做完成脉冲高亮（nudge effect 消费该标记后清）。
      stoppedTurnRef.current = true
      chat.stop(activeId)
    }
    setChatError(null)
  }, [demo, activeId, chat])

  // ── P5 渲染层接线 ──────────────────────────────────────────────────────
  // 媒体签名单一权威：把 api.mediaSign 注入渲染树（demo 无网络 → null）。容器内路径
  // 经此换签名 URL，图片/视频/音频才不停在占位。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const signMedia = useCallback(
    (paths: string[]) => api.mediaSign(authRef.current, paths).then((r) => r.urls),
    [],
  )
  // 权限审批回送：绑定当前会话，桥接 useChatSocket.respondPermission。
  // 走稳定 sockRef（非 chat），避免依赖每帧重建的 chat 引用 —— 否则该回调每个流式帧
  // 都换新引用，会击穿 MessageRenderer 的 memo（防闪失效，全列表逐帧重渲）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const onRespondPermission = useCallback(
    (p: {
      requestId: string
      behavior: 'allow' | 'deny'
      message?: string
      updatedInput?: Record<string, unknown>
    }) => {
      if (!activeId) return
      sockRef.current?.respondPermission({ sessId: activeId, ...p })
    },
    [activeId],
  )

  // 逐条反馈：打开显式反馈弹窗。上下文发送白名单由 MessageFeedbackDialog 收口，
  // 不再把诊断串静默写入剪贴板。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const onFeedback = useCallback((ctx: FeedbackContext) => {
    messageFeedbackTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMessageFeedback(ctx)
  }, [])
  // 工具卡上下文动作（记忆/技能/定时任务卡上的「打开…」按钮 + 连接器写操作确认卡的
  // 鉴权动作）。稳定引用经 context 注入，不污染 ToolCard 数据契约。demo 无网络 → 不提供
  //（按钮自动隐藏 / 确认卡降级纯展示）。authRef 是稳定 ref，不入依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const toolActions = useMemo(
    () =>
      demo
        ? {}
        : {
            onOpenMemory: () => openManage('memory'),
            onOpenSkills: () => openManage('skills'),
            onOpenTasks: () => openManage('cron'),
            connectorConfirm: {
              getDetail: (id: string) => api.getConnectorConfirmation(authRef.current, id),
              decide: (id: string, decision: 'approve' | 'deny') =>
                api.decideConnectorConfirmation(authRef.current, id, decision),
            },
            ...(TASKBOARD_ENABLED
              ? {
                  taskApproval: {
                    getTicket: async (id: string) => {
                      const { taskboardApi } = await import('../lib/taskboard')
                      return taskboardApi.getTicket(authRef.current, id)
                    },
                    approve: async (id: string, expectedVersion: number) => {
                      const { taskboardApi } = await import('../lib/taskboard')
                      return taskboardApi.approve(authRef.current, id, expectedVersion)
                    },
                    reject: async (id: string, expectedVersion: number, reason: string) => {
                      const { taskboardApi } = await import('../lib/taskboard')
                      return taskboardApi.reject(authRef.current, id, expectedVersion, reason)
                    },
                  },
                  onOpenTaskboard: () => {
                    setCollapsed(false)
                    setBoardOpen(true)
                  },
                }
              : {}),
          },
    [demo, openManage, setBoardOpen],
  )

  // 对话交互(```options 选择卡片等):点选即替用户发送。demo 不给发送能力(纯展示),
  // 但带上 reason 让交互块说清「演示模式仅供浏览」,而不是笼统的「此会话中不可交互」(misc-p3 D-08)。
  const chatInteraction = useMemo<ChatInteraction>(
    () => (demo ? { reason: 'demo' } : { sendUserText: (t: string) => send(t), busy: sending }),
    [demo, send, sending],
  )

  // 产物详情列 open 回调:引用稳定,不随面板开合变化,避免打穿 MessageList 的 sig-memo。
  const artifactInspect = useMemo(
    () => ({
      // 浏览器操作(OCV5-374)进「浏览器」页看截图和整轮操作记录;其余工具进步骤详情。
      open: (t: ArtifactInspectTarget) =>
        openPane(isBrowserStepMessage(t.message) ? 'browser' : 'steps', t.message),
      openPane: (tab: PaneTab, message?: ToolLike | null) => openPane(tab, message),
    }),
    [openPane],
  )

  // 发送失败重试：复用原消息 payload（含附件引用）走 WS service 既有发送收口原地重发；
  // model/teamMode/effort 由 socket 复用失败首发的 routing 快照,不读取当前偏好。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const retrySend = useCallback(
    async (msg: ChatMessage) => {
      if (demo || !activeId) return
      const exact = await loadExactUserMessage(msg)
      if (!exact) {
        toast('原始消息加载失败，请重试', 'error')
        return
      }
      // A deferred red-card CTA was admitted only when the sidecar recorded
      // complete routing/media evidence. Re-check the decoded row before
      // dispatch so a corrupt/mismatched payload can never degrade to text-only.
      if (msg._userPayloadDeferred === true && !preciseRetryEligible(exact)) {
        toast('原消息的完整重试信息不可用，请使用重新生成', 'error')
        return
      }
      sockRef.current?.retryMessage({
        sessId: activeId,
        msgId: msg.id,
        agentId: agent.id,
        sourceOverride: exact,
      })
    },
    [demo, activeId, agent.id, loadExactUserMessage, toast],
  )

  // 红卡 CTA 硬门(任务④ / Codex 审计 R4)的精确重试目标解析:按 assistant 错误行的
  // _clientMessageId 在当前会话里定位可**原样重发**的 user 行。现场取 messages(稳定句柄 sockRef,
  // 不捕获每帧刷新的 wsMessages),与 retrySend 同 deps(仅随会话切换变)。资格三条:
  //   (a) 该 user 行存在且 status='error'(有完整 payload、确实失败);
  //   (b)(c) 自带 _routing 快照 + 附件重发证据仍在 —— 见 preciseRetryEligible(与 retryMessage
  //   实际读取的字段严格对齐,防止借用别轮 _lastRouting / 静默丢附件)。任一不满足 → 返回
  //   undefined,红卡落回 onRegenerate 兜底(见 AssistantCard 的 R5 末轮门控)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const resolveRetryTarget = useCallback(
    (clientMessageId: string): ChatMessage | undefined => {
      if (demo || !activeId) return undefined
      const msgs = sockRef.current?.getMessages(activeId) ?? []
      const target = msgs.find(
        (m) => m.role === 'user' && m.id === clientMessageId && m.status === 'error',
      )
      return target && preciseRetryEligible(target) ? target : undefined
    },
    [demo, activeId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const resolveInterruptedContinuation = useCallback(
    (error: ChatMessage): ChatMessage | undefined => {
      if (demo || !activeId) return undefined
      const msgs = sockRef.current?.getMessages(activeId) ?? []
      return interruptedContinuationTarget(msgs, error, activeId)?.user
    },
    [demo, activeId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const continueInterrupted = useCallback(
    (error: ChatMessage) => {
      if (demo || !activeId) return
      sockRef.current?.continueInterruptedTurn({
        sessId: activeId,
        errorMessageId: error.id,
        agentId: agent.id,
      })
    },
    [demo, activeId, agent.id],
  )

  // 卡片回调集（稳定引用：作为 MessageRenderer memo 比较键之一，避免无谓重渲）。
  // True tape process paging + oversized-record loading. Hook methods are stable;
  // demo/readonly surfaces leave the cursor disabled rather than inventing content.
  const {
    fetchTapeRecordPayload,
    peekTapeRecordPayload,
    fetchUserMessagePayload,
    peekUserMessagePayload,
  } = chat
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const cardCallbacks: CardCallbacks = useMemo(
    () => ({
      onRegenerate: regenerate,
      onContinue: () => send(CONTINUE_PROMPT),
      onTopUp: demo
        ? undefined
        : () => {
            openSettings('account')
            setSubscribeOpenSignal((n) => n + 1)
          },
      onStartNewSession: demo ? undefined : newSession,
      onFeedback,
      onFirstTextPaint: demo
        ? undefined
        : (input) => {
            reportClientFriction(
              {
                surface: 'webchat',
                stage: 'first_text_paint',
                code: input.backgroundAtFrame
                  ? 'FIRST_TEXT_PAINT_AFTER_BACKGROUND'
                  : 'FIRST_TEXT_PAINT',
                outcome: 'succeeded',
                latencyMs: input.latencyMs,
                traceId: input.traceId,
                sessionId: input.sessionId,
              },
              authRef.current?.snapshot().token,
            )
          },
      onTimelineBlank: demo
        ? undefined
        : ({ sessionId, report }) => {
            // Bounded counters only; the full geometry stays in localStorage
            // (`oc.timelineBlank.last`) / `window.__ocTimelineDump()` for the
            // user to hand over when the blank shows up again.
            const snap = report.snapshot
            reportClientFriction(
              {
                surface: 'webchat',
                stage: 'timeline_paint',
                code: `TIMELINE_BLANK_${report.classification.toUpperCase()}`,
                outcome: 'failed',
                attempts: snap.rowsMounted,
                latencyMs: Math.max(0, Math.round(snap.distBottom)),
                sessionId,
              },
              authRef.current?.snapshot().token,
            )
            if (typeof console !== 'undefined') {
              console.warn('[oc-timeline] blank viewport detected', report.classification, snap)
            }
          },
      onRetrySend: demo ? undefined : retrySend,
      onEditResend: (m) => setComposerPrefill({ text: m.text || '', nonce: Date.now() }),
      onEditQueued: (m) => {
        const text = activeId
          ? (sockRef.current?.editQueuedMessage(activeId, m.id) ?? m.text ?? '')
          : m.text || ''
        setComposerPrefill({ text, nonce: Date.now() })
      },
      onDeleteQueued: (m) => {
        if (!activeId) return
        sockRef.current?.discardQueuedMessage(activeId, m.id)
      },
      onSendQueuedNow: (m) => {
        if (!activeId) return
        sockRef.current?.sendQueuedNow(activeId, m.id)
      },
      onOpenModelPicker: () => setModelPickerOpen(true),
      onContinueInterrupted: demo ? undefined : continueInterrupted,
      resolveInterruptedContinuation: demo ? undefined : resolveInterruptedContinuation,
      onQuote:
        demo || !activeId
          ? undefined
          : (message) => {
              if (message.role !== 'user' && message.role !== 'assistant') return
              const text = replyQuoteText(message)
              if (!text) return
              const quote = normalizeMessageReplyQuote({
                messageId: message.id,
                role: message.role,
                text,
              })
              if (!quote) return
              setMessageReplyTarget({
                sessionId: activeId,
                quote,
              })
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
        : (messageId, expected) => peekUserMessagePayload(activeId, messageId, expected),
      resolveRetryTarget: demo ? undefined : resolveRetryTarget,
      onSaveToProject:
        chipsBoardProjectId && activeId
          ? (message, kind) => {
              const text = (message.text ?? '').trim()
              if (!text) return
              const a = authRef.current
              setSaveToProject({
                kind,
                text,
                sessionId: activeId,
                boardProjectId: chipsBoardProjectId,
                projectName: chipsProjectName,
                auth: a,
                epoch: a.snapshot().epoch,
                nonce: Date.now(),
              })
            }
          : undefined,
    }),
    [
      regenerate,
      send,
      demo,
      openSettings,
      newSession,
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
      chipsBoardProjectId,
      chipsProjectName,
    ],
  )
  // 详情面板里点开大记录(>1 MiB 定位桩)时,与聊天区共用同一套正文取数与页面缓存。
  const paneDeferredLoader = useMemo<DeferredPayloadLoader>(
    () => ({
      peek: cardCallbacks.onPeekTapeRecordPayload,
      fetch: cardCallbacks.onFetchTapeRecordPayload,
    }),
    [cardCallbacks],
  )

  const composerReplyTo =
    messageReplyTarget && messageReplyTarget.sessionId === activeId
      ? messageReplyTarget.quote
      : null

  let lastUserText: string | undefined
  if (demo) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content) {
        lastUserText = messages[i].content
        break
      }
    }
  } else {
    for (let i = wsMessages.length - 1; i >= 0; i--) {
      const message = wsMessages[i]
      if (message.role === 'user' && message.status !== 'queued' && message.text) {
        lastUserText = message.text
        break
      }
    }
  }
  // 输入预测(OCV5-375):回答末尾模型写的 next 块 → 输入框浅色预测;打字时按本会话说过的话补全。
  // 设置里关掉时 master 也不再下发这段提示词。demo 不开。
  // 解析器按需加载,不进首屏包(首屏只有输入框的补全和浮层);加载失败就没有预测。
  const inputPredictionOn = useInputPredictionEnabled()
  const [predictInput, setPredictInput] = useState<PredictInput | null>(null)
  useEffect(() => {
    if (demo || !inputPredictionOn || predictInput) return
    let alive = true
    void import('../lib/inputPrediction').then(
      (m) => {
        if (alive) setPredictInput(() => m.predictInput)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [demo, inputPredictionOn, predictInput])
  const inputPrediction = useMemo(
    () => (demo || !inputPredictionOn || !predictInput ? null : predictInput(wsMessages)),
    [demo, inputPredictionOn, predictInput, wsMessages],
  )
  const timelineMessages = wsMessages.filter(
    (message) => message.role !== 'user' || message.status !== 'queued',
  )
  const queuedOutgoing = wsMessages.filter(
    (message) => message.role === 'user' && message.status === 'queued',
  )

  // 视频任务能力探测:登录后拉一次。仅在服务端明确回答 available:false 时隐藏入口;
  // 请求失败/未知保持可见(任务中心内部有「暂未开放」兜底),避免网络抖动误藏功能。
  const mediaGateEnabled = !demo && !!user
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (!mediaGateEnabled) {
      setMediaTasksAvailable(null)
      return
    }
    let cancelled = false
    api
      .getMediaCapabilities(authRef.current)
      .then((cap) => {
        if (!cancelled) setMediaTasksAvailable(cap?.available !== false)
      })
      .catch(() => {
        if (!cancelled) setMediaTasksAvailable(null)
      })
    return () => {
      cancelled = true
    }
  }, [mediaGateEnabled])

  // ChatGPT 直连授权探测:登录后拉一次。与视频任务相反,这里默认隐藏、只有服务端明确
  // enabled:true 才显示入口 —— 未授权用户看不到任何代理信息。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  useEffect(() => {
    if (!mediaGateEnabled) {
      setChatGptProxyEnabled(false)
      setChatGptProxyOpen(false)
      return
    }
    let cancelled = false
    api
      .getChatGptProxyAccess(authRef.current)
      .then((access) => {
        if (!cancelled) setChatGptProxyEnabled(access.enabled === true)
      })
      .catch(() => {
        if (!cancelled) setChatGptProxyEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [mediaGateEnabled])

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
  })
  sendImplicitRatingRef.current = sendImplicitRating

  // autoscroll: controller 是 scrollTop 的唯一写入方。正确性来自 check-before-write,
  // 输入 mark 只立刻挂起写入以降低抖动,没有 400ms 手势寿命。
  const stick = useRef(createStickToBottomController()).current
  const stickToBottomRef = useMemo(
    () => ({
      get current() {
        return stick.following.current
      },
      set current(value: boolean) {
        stick.following.current = value
      },
      scrollToBottom: stick.scrollToBottom,
      jumpToBottom: stick.jumpToBottom,
      correctTo: stick.correctTo,
      releaseUserIntent: stick.releaseUserIntent,
    }),
    [stick],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const scrollToChatBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) stick.scrollToBottom(el)
  }, [stick])
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const cancelArchiveCorrection = useCallback(() => {
    const anchor = archiveScrollAnchorRef.current
    if (anchor) anchor.cancelled = true
  }, [])
  const markUserChatScroll = useCallback(() => {
    stick.markUserIntent()
    cancelArchiveCorrection()
  }, [stick, cancelArchiveCorrection])
  // Wheel / trackpad fence (see wheelFence.ts). The React `onWheel` above keeps
  // the zero-tolerance leave mark; the fence itself lives in native listeners so
  // begin and release share one ordering with the browser's scrollend.
  useEffect(() => {
    const el = chatScrollParent
    if (!el) return
    return attachWheelFence(el, stick)
  }, [chatScrollParent, stick])
  const beginDirectUserChatScroll = useCallback(() => {
    stick.beginDirectManipulation()
    cancelArchiveCorrection()
  }, [stick, cancelArchiveCorrection])
  const endDirectUserChatScroll = useCallback(() => {
    stick.endDirectManipulation()
  }, [stick])
  // Native scrollbar capture may deliver pointerup outside the scroller. Keep
  // the direct-manipulation lifetime tied to the actual press, not to whether
  // React happens to receive the matching end event on the chat element.
  useEffect(() => {
    const end = () => endDirectUserChatScroll()
    // Native touch scrolling intentionally emits pointercancel when the browser
    // takes ownership of panning. The finger is still down at that point; the
    // matching touchend/touchcancel is the actual direct-manipulation boundary.
    const endPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') end()
    }
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
      window.removeEventListener('blur', end)
    }
  }, [endDirectUserChatScroll])
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stick.onScroll(el)
    const anchor = archiveScrollAnchorRef.current
    if (
      anchor &&
      !anchor.cancelled &&
      !anchor.restoring &&
      Math.abs(el.scrollTop - anchor.capturedScrollTop) > 1
    ) {
      // 用户已经离开点击位置：响应仍须等 DOM 提交后释放 FIFO，但不再把视口拉回旧坐标。
      anchor.cancelled = true
    }
  }, [stick])
  // 切会话:重置粘滞并瞬时跳底(历史回看从底部开始);同时清归档按钮子态与视口锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId 是切会话触发器,函数体不读它。
  useLayoutEffect(() => {
    stick.reset()
    scrollToChatBottom()
    setArchiveLoading(false)
    setArchiveError(false)
    archiveRequestTokenRef.current += 1
    settleArchiveAnchor()
    return () => {
      archiveRequestTokenRef.current += 1
      settleArchiveAnchor()
    }
  }, [activeId, scrollToChatBottom, settleArchiveAnchor, stick])
  // 内容变更跟随:demo 走 messages/streamText,真实路径走 version/wsSending。
  // 流式期间高频触发,用瞬时赋值而非 smooth(60fps 下排队的平滑动画反而卡顿)。
  // layout 阶段贴底,避免普通 DOM 时间线先画出旧顶部再跳到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/streamText/chat.version/wsSending 是内容变更触发器;stickToBottomRef.current 是稳定对象上的 getter,执行时现读。
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    scrollToChatBottom()
  }, [messages, streamText, chat.version, wsSending, scrollToChatBottom])

  // 归档「查看更早历史记录」:记录点击时屏幕里真实可见的消息行。前插渲染后持续把
  // 该行恢复到原位置；底部仍在增长的实时 Agent 响应不会污染这次校正。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list moved verbatim from App() (OCV5-472); values destructured from the app hooks are the same stable setters/refs
  const onLoadOlderHistory = useCallback(async () => {
    if (demo || !activeId) return
    stick.following.current = false
    settleArchiveAnchor()
    const token = ++archiveRequestTokenRef.current
    const el = scrollRef.current
    let resolveAnchor: (() => void) | null = null
    const anchorSettled = el
      ? new Promise<void>((resolve) => {
          resolveAnchor = resolve
        })
      : Promise.resolve()
    const settle = () => {
      const resolve = resolveAnchor
      resolveAnchor = null
      resolve?.()
    }
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
      : null
    setArchiveError(false)
    setArchiveLoading(true)
    try {
      // loadOlderHistory 是非抛出式契约:失败以 {ok:false} 返回(hasMore 不封死,可重试)。
      const res = await chat.loadOlderHistory(activeId)
      if (archiveRequestTokenRef.current !== token) return
      if (!res.ok) {
        setArchiveError(true)
        settleArchiveAnchor(token)
      } else if (res.loaded > 0) {
        const anchor = archiveScrollAnchorRef.current
        if (anchor?.token === token) anchor.ready = true
      } else {
        settleArchiveAnchor(token)
      }
    } catch {
      if (archiveRequestTokenRef.current !== token) return
      setArchiveError(true)
      settleArchiveAnchor(token)
    } finally {
      if (archiveRequestTokenRef.current === token) setArchiveLoading(false)
    }
    // Keep the shared history FIFO occupied until this request's DOM insertion
    // has either been anchored or deliberately cancelled by user navigation.
    await anchorSettled
  }, [demo, activeId, chat, settleArchiveAnchor, stick])
  // 对应归档响应完成且前插行渲染后(paint 前)才校正 scrollTop。请求在途时的 tape/live
  // 增长没有 ready token，不能冒领这个锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: archiveLoading/chat.version 是前插渲染完成的触发器,函数体经 ref 读锚点。
  useLayoutEffect(() => {
    const anchor = archiveScrollAnchorRef.current
    if (!anchor?.ready) return
    const el = scrollRef.current
    if (!el) {
      settleArchiveAnchor(anchor.token)
      return
    }
    if (
      anchor.cancelled ||
      !anchor.row ||
      anchor.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration
    ) {
      settleArchiveAnchor(anchor.token)
      return
    }
    if (anchor.restoring) return
    anchor.restoring = true
    void restoreVisibleVirtualRowAnchor(
      el,
      anchor.row,
      () => {
        const current = archiveScrollAnchorRef.current
        return (
          !current ||
          current.token !== anchor.token ||
          current.cancelled ||
          current.timelineGeneration !== sockRef.current?.getSession(activeId)?._timelineGeneration
        )
      },
      undefined,
      stick.correctTo,
    ).finally(() => settleArchiveAnchor(anchor.token))
  }, [activeId, archiveLoading, chat.version, settleArchiveAnchor, stick])

  // iOS Safari 的地址栏/底栏/截图/输入键盘会触发 visualViewport 高度与 offset 抖动。
  // CSS dvh 仍可能短暂大于真实可视区；键盘弹起时 Safari 还会 pan visual viewport,
  // 让 fixed root 的 top:0 看起来被顶到屏幕上方。这里把实测 height + offsetTop
  // 写入 CSS var；若用户本就在底部或本轮正在生成，下一帧重新贴底。
  // biome-ignore lint/correctness/useExhaustiveDependencies: stickToBottomRef.current 是稳定对象上的 getter,事件发生时现读,不是依赖。
  useEffect(() => {
    if (!inWorkspace) return
    let raf: number | null = null
    const setVisualViewportVars = () => {
      const vv = window.visualViewport
      const h = vv?.height || window.innerHeight
      if (Number.isFinite(h) && h > 0) {
        document.documentElement.style.setProperty('--oc-visual-height', `${Math.round(h)}px`)
        document.documentElement.style.setProperty(
          '--oc-visual-height-85',
          `${Math.round(h * 0.85)}px`,
        )
      }
      const top = vv?.offsetTop || 0
      if (Number.isFinite(top)) {
        document.documentElement.style.setProperty(
          '--oc-visual-offset-top',
          `${Math.max(0, Math.round(top))}px`,
        )
      }
    }
    const realign = () => {
      setVisualViewportVars()
      if (!stickToBottomRef.current) return
      if (typeof requestAnimationFrame === 'function') {
        if (raf !== null) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          raf = null
          scrollToChatBottom()
        })
      } else {
        scrollToChatBottom()
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') realign()
    }
    realign()
    window.visualViewport?.addEventListener('resize', realign)
    window.visualViewport?.addEventListener('scroll', realign)
    window.addEventListener('resize', realign)
    window.addEventListener('pageshow', realign)
    window.addEventListener('focus', realign)
    document.addEventListener('focusin', realign)
    document.addEventListener('focusout', realign)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      window.visualViewport?.removeEventListener('resize', realign)
      window.visualViewport?.removeEventListener('scroll', realign)
      window.removeEventListener('resize', realign)
      window.removeEventListener('pageshow', realign)
      window.removeEventListener('focus', realign)
      document.removeEventListener('focusin', realign)
      document.removeEventListener('focusout', realign)
      document.removeEventListener('visibilitychange', onVisible)
      document.documentElement.style.removeProperty('--oc-visual-height')
      document.documentElement.style.removeProperty('--oc-visual-height-85')
      document.documentElement.style.removeProperty('--oc-visual-offset-top')
    }
  }, [inWorkspace, scrollToChatBottom])

  useEffect(() => {
    if (!inWorkspace) return
    const onKey = (e: KeyboardEvent) => {
      // Esc 的第一持有方是打开着的弹层(Radix Dialog / AlertDialog / DropdownMenu):生成中在对话框里
      // 按 Esc 只该关对话框,不该连带掐掉这一轮(shell 审计 S-02)。按事件时刻的 DOM 判断,不逐个面板维护布尔量。
      if (resolveGlobalHotkey(e, { sending, dialogOpen: isDialogLayerOpen() }) === 'stop') {
        e.preventDefault()
        stopTurn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inWorkspace, sending, stopTurn])

  // ── P7 最小路由接线：URL 单向镜像（会话路径 + 面板 query）/ popstate / 深链恢复 ──
  // 面板深链单选优先级见 activePanelOf（同一时刻仅镜像一个顶层中心）。
  const activePanel = activePanelOf({
    help: tutorialOpen,
    settings: settingsOpen,
    market: marketplaceOpen,
    manage: manageOpen,
    org: orgOpen,
  })
  const routeProjectIds = useMemo(() => projects.map((p) => p.id), [projects])
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
      setActiveId(undefined)
      setMessages([])
      setChatError(null)
    },
    activePanel,
    activeTopic: tutorialOpen ? tutorialTopic : null,
    activeCase: tutorialOpen ? tutorialCase : null,
    activeCommunity: tutorialOpen ? tutorialCommunity : null,
    activeTutorialTab: tutorialOpen ? tutorialTab : null,
    activeTutorialWork: tutorialOpen ? tutorialWork : null,
    activeTutorialStep: tutorialOpen ? tutorialStep : null,
    onPopPanel: (panel, topic, caseId, communityId, extras) => {
      setSettingsOpen(panel === 'settings')
      setMarketplaceOpen(panel === 'market')
      setManageOpen(panel === 'manage')
      setOrgOpen(panel === 'org')
      setTutorialOpen(panel === 'help')
      if (panel === 'help') {
        setTutorialTopic(topic)
        setTutorialCase(caseId)
        setTutorialCommunity(communityId)
        setTutorialTab(extras.tab)
        setTutorialWork(extras.work)
        setTutorialStep(extras.step)
      } else {
        setTutorialTopic(null)
        setTutorialCase(null)
        setTutorialCommunity(null)
        setTutorialTab(null)
        setTutorialWork(null)
        setTutorialStep(null)
      }
    },
    workspace: TASKBOARD_ENABLED && boardOpen ? 'board' : projectHome ? 'project' : 'chat',
    boardView,
    boardTicket: boardTicketId,
    boardTicketType,
    projectRoute: projectHome,
    pendingProject: pendingRouteProject,
    clearPendingProject: () => setPendingRouteProject(null),
    projectIds: routeProjectIds,
    projectListSettled: projectsLoaded,
    onOpenProject: (route) => {
      setBoardOpenState(false)
      setProjectHome(route)
    },
    onPopWorkspace: (ws) => {
      setBoardOpenState(TASKBOARD_ENABLED && ws === 'board')
      if (ws !== 'project') setProjectHome(null)
    },
    onPopBoardParams: (nextView, ticket, ticketType) => {
      setBoardView(nextView)
      setBoardTicketId(ticket)
      setBoardTicketType(ticketType)
    },
  })

  return {
    ...state,
    activeSess,
    applyConversationPreferences,
    artifactInspect,
    beginDirectUserChatScroll,
    cardCallbacks,
    chat,
    chatInteraction,
    composerReplyTo,
    connBanner,
    effortActive,
    effortSupported,
    endDirectUserChatScroll,
    gate,
    gated,
    handleLockedSelect,
    historySurface,
    imageEditActions,
    inbox,
    inflightDelegates,
    inputPrediction,
    lastUserText,
    liveTerminal,
    loadingHistory,
    markUserChatScroll,
    onChatScroll,
    onLoadOlderHistory,
    onRespondPermission,
    openManage,
    openMarketplace,
    openOrg,
    openRepo,
    openSettings,
    openTutorial,
    paneAvailable,
    paneDeferredLoader,
    paneInline,
    paneRequestHere,
    paneShown,
    queuedOutgoing,
    ratingCtx,
    refreshMyAgents,
    regenerate,
    repo,
    runTutorialAction,
    runTutorialCase,
    sending,
    setSessionGoal,
    settingsFeedbackContext,
    signMedia,
    stickToBottomRef,
    stopTurn,
    timelineMessages,
    togglePane,
    toolActions,
    transientNotice,
    transitionSessionGoal,
    turnActivity,
    tutorialActionContext,
    wsMessages,
    wsSending,
  }
}

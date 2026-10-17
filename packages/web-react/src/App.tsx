import { AgentGate } from './components/AgentGate'
import { LazyBoundary } from './components/ChunkErrorBoundary'
import { AgentPicker } from './components/AgentPicker'
import { AuthGate } from './components/AuthGate'
import { DesktopEnrollPage } from './components/DesktopEnrollPage'
import { ChatHeader } from './components/ChatHeader'
import { saveBlob } from './lib/chat/download'
import { exportSessionMarkdown, sessionExportFilename } from './lib/chat/exportMarkdown'
import { ProjectScopeProvider } from './hooks/useProjectScope'
import { Composer } from './components/Composer'
import { ComposerProjectPill } from './components/ComposerProjectPill'
import { accountDraftKey, NEW_COMPOSER_DRAFT_KEY } from './lib/composerDraft'
import { ImageEditActionsContext } from './components/chat/imageEditActions'
import { extractLatestTodos, PinnedTaskTracker } from './components/chat/PinnedTaskTracker'
import { QueuedSendList } from './components/chat/QueuedSendList'
import { PinnedDelegateTracker } from './components/chat/PinnedDelegateTracker'
import { PinnedGoalBar } from './components/chat/PinnedGoalBar'
import { EmptyState, greetingName } from './components/EmptyState'
import { ErrorBanner } from './components/ErrorBanner'
import { SessionTimelineBoundary } from './components/SessionTimelineBoundary'
import { UpdateBanner } from './components/UpdateBanner'
import { RepoStatusBanner } from './components/github/RepoStatusBanner'
import { PendingPaymentRecovery } from './components/payment/PendingPaymentRecovery'
import { CHAT_CREATE_TEMPLATES } from './lib/chatCreateTemplates'
import { type BannerKind, collapsedBannersLabel, resolveBanners } from './lib/bannerStack'
import { DEFAULT_MANAGE_TAB, normalizeManageTab } from './lib/manageTabs'
import { AssistantMessage, UserMessage } from './components/Message'
import { MessageList, type MessageListArchive } from './components/MessageRenderer'
import { MessageListSkeleton } from './components/chat/HistorySkeleton'
import { TurnCostReminder } from './components/chat/TurnCostReminder'
import { currentTurnSettled } from './components/chat/turnSegment'
import { ResponseRatingProvider } from './components/chat/ResponseRating'
import { MediaSignProvider } from './components/chat/media'
import { ArtifactInspectActiveContext, ArtifactInspectContext, ChatInteractionContext, ToolCardActionsContext } from './components/tool/context'
import { DETAIL_PANE_WIDTH, InspectorPanel, InspectorPanelContent } from './components/InspectorPanel'
import { Sidebar } from './components/Sidebar'
import { Alert, Button, Sheet } from './components/ui'
import { BootSplash } from './components/BootSplash'
import { DEFAULT_AGENT } from './lib/agents'
import { resolveTutorialAction } from './lib/tutorialActions'
import { uploadFilesToProject } from './lib/projectFileUpload'
import type { ChatProject, Session } from './lib/types'
import { TASKBOARD_ENABLED } from './lib/taskboardFeature'
import { dismissSuggestion, suggestProjectForChat } from './lib/unfiledSuggest'
import { ChatGptProxyDialog, CommandPalette, ContainerWebPreview, CreateProjectDialog, DialogFallback, GithubRepoModal, ImageAnnotationEditor, InboxDialog, Landing, ManageCenter, MarketplaceCenter, MediaTaskCenter, MessageFeedbackDialog, OrgCenter, ProjectArchiveDialog, ProjectHome, ProjectSettingsDialog, SaveToProjectDialog, SettingsCenter, ShareDialog, SplashFallback, TaskboardView, TutorialCenter } from './app/appHelpers'
import { useAppActions } from './app/useAppActions'
import { useAppState } from './app/useAppState'
export { prefetchLazyCentersOnIdle } from './app/appHelpers'

export function App() {
  // State, effects and actions: app/useAppState.tsx + app/useAppActions.tsx (FINDINGS §7.6 A1).
  const app = useAppActions(useAppState())
  const {
    activeId,
    activeSess,
    agent,
    applyConversationPreferences,
    archiveError,
    archiveLoading,
    artifactInspect,
    auth,
    authed,
    authError,
    authLoading,
    authMode,
    authRecoveryAvailable,
    authRef,
    bannersExpanded,
    batchUpdateSessions,
    beginDirectUserChatScroll,
    bindChatScroll,
    boardOpen,
    boardTicketId,
    boardTicketType,
    boardView,
    booting,
    busy,
    cardCallbacks,
    chat,
    chatError,
    chatGptProxyEnabled,
    chatGptProxyOpen,
    chatInteraction,
    chatScrollParent,
    chatViewActiveId,
    clearAuth,
    collabAsDefault,
    collabMode,
    collabSaveError,
    collabUi,
    collapsed,
    collapsedProjectIds,
    composerPrefill,
    composerPrefs,
    composerReplyTo,
    confirmDialogEl,
    confirmReset,
    connBanner,
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
    effortActive,
    effortSupported,
    endDirectUserChatScroll,
    findOpen,
    gate,
    gated,
    goalOpenNonce,
    handleLockedSelect,
    handleNew,
    hasMoreSessions,
    historyError,
    historyLoading,
    historySurface,
    homeProject,
    imageAnnotationSource,
    imageEditActions,
    inbox,
    inboxMounted,
    inboxOpen,
    inflightDelegates,
    inputPrediction,
    isMdViewport,
    isWideViewport,
    lastUserText,
    listDeletedProjects,
    liveMediaJob,
    liveTerminal,
    loadArchivedSessions,
    loadingArchived,
    loadingHistory,
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
    markUserChatScroll,
    mediaTasksAvailable,
    mediaTasksOpen,
    messageFeedback,
    messageFeedbackMounted,
    messageFeedbackTriggerRef,
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
    onChatScroll,
    onLoadOlderHistory,
    onRespondPermission,
    openManage,
    openMarketplace,
    openOrg,
    openProject,
    openRepo,
    openSettings,
    openTutorial,
    orgOpen,
    orgSection,
    paletteMounted,
    paletteOpen,
    paletteSearchAssets,
    paletteSearchMessages,
    paletteUserId,
    paneActive,
    paneAvailable,
    paneDeferredLoader,
    paneInline,
    paneRequestHere,
    paneSheetOpen,
    paneShown,
    paneWidth,
    persistCollab,
    pickerOpen,
    prepareProjectBoard,
    projectArchiveMounted,
    projectArchiveOpen,
    projectHome,
    projects,
    projectSettings,
    projectSettingsMounted,
    projectSettingsOpen,
    promptTextEl,
    publicCfg,
    queuedOutgoing,
    ratingCtx,
    refreshMe,
    refreshMyAgents,
    regenerate,
    register,
    renameProjectPrompt,
    renameSessionPrompt,
    reorderProjects,
    repo,
    repoModalMounted,
    repoModalOpen,
    requestReset,
    resendVerification,
    resetToken,
    restoreProject,
    retryBoot,
    retryHistory,
    runTutorialAction,
    runTutorialCase,
    saveToProject,
    saveToProjectMounted,
    searchSessionMessages,
    selectModel,
    selectSession,
    send,
    sending,
    serverFeatures,
    serviceTier,
    sessions,
    setAgent,
    setAuthMode,
    setBannersExpanded,
    setBoardOpen,
    setBoardOpenState,
    setBoardTicketId,
    setBoardTicketType,
    setBoardView,
    setChatError,
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
    setManageAutoAuthorizePluginSlug,
    setManageOpen,
    setManageTab,
    setMarketplaceOpen,
    setMarketplaceTab,
    setMediaTasksOpen,
    setMessageFeedback,
    setMessageReplyTarget,
    setMobileNavOpen,
    setModelPickerOpen,
    setMyAgents,
    setOrgOpen,
    setPaletteOpen,
    setPaneActive,
    setPaneOpen,
    setPaneSheetOpen,
    setPendingRouteProject,
    setPickerOpen,
    setProjectArchived,
    setProjectArchiveOpen,
    setProjectHome,
    setProjectPinned,
    setProjectSettings,
    setPublicCfgRetryNonce,
    setRepoModalOpen,
    setSaveToProject,
    setServiceTier,
    setSessionEffort,
    setSessionGoal,
    setSettingsOpen,
    setShareOpen,
    setSubscribeOpenSignal,
    setTeamMode,
    setTheme,
    settingsFeedbackContext,
    settingsOpen,
    settingsSection,
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
    signMedia,
    startInProject,
    stickToBottomRef,
    stopTurn,
    streamText,
    submitImageEdit,
    subscribeOpenSignal,
    teamMode,
    theme,
    timelineMessages,
    toast,
    toggleArchiveSession,
    togglePane,
    togglePinSession,
    toggleProjectCollapsed,
    toolActions,
    toolCards,
    transientNotice,
    transitionSessionGoal,
    turnActivity,
    tutorialActionContext,
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
    wsMessages,
    wsSending,
  } = app


  // 启动续期检查中:极简 splash(避免"闪一下首页又跳工作区"的割裂;通常 <300ms)。
  if (!demo && booting) {
    return <BootSplash />;
  }
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

      <AgentPicker
        open={pickerOpen}
        current={agent}
        auth={demo ? null : auth}
        teamMode={teamMode}
        collabMode={collabMode}
        advisorModels={collabUi.advisorModels}
        advisorModel={collabUi.advisorModel}
        advisorUnavailableReason={collabUi.advisorUnavailableReason}
        advisorConsultParents={collabUi.advisorConsultParents}
        advisorConsultParentReason={collabUi.advisorConsultParentReason}
        advisorConsultAllowed={collabUi.advisorConsultAllowed}
        parentEngine={models.find((row) => row.id === modelId)?.engine ?? collabUi.parentEngine}
        collabSaveError={collabSaveError}
        asDefault={collabAsDefault}
        onAsDefaultChange={demo ? undefined : setCollabAsDefault}
        onToggleTeamMode={demo ? undefined : setTeamMode}
        onCollabModeChange={demo ? undefined : setCollabMode}
        onAdvisorModelChange={
          demo
            ? undefined
            : (id) => {
                void persistCollab("advisor", { advisorModel: id, asDefault: collabAsDefault });
              }
        }
        onAddFromMarket={
          demo
            ? undefined
            : () => {
                setPickerOpen(false);
                openMarketplace("browse", "agent");
              }
        }
        onOpenPluginAuth={
          demo
            ? undefined
            : (a) => {
                // composer C-06:未就绪智能体「去授权」→ 管理中心「插件」页;带上第一枚待授权的
                // Plugin slug 让 ConnectorsTab 直接进入授权(与市场 onOpenConnectors 同一条路)。
                setPickerOpen(false);
                setManageAutoAuthorizePluginSlug(a.needsAuthorization?.[0] ?? null);
                openManage("connectors");
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
            onOpenManage={() => openManage("connectors")}
            onOpenRepo={demo ? undefined : openRepo}
            onOpenProjectSettings={() => {
              const pid = sessions.find((s) => s.id === activeId)?.projectId;
              const p = pid ? projects.find((x) => x.id === pid) : null;
              if (!p) return;
              setUngroupedAssetsOpen(false);
              setProjectSettings(p);
            }}
            subscribeOpenSignal={subscribeOpenSignal}
          />
        </LazyBoundary>
      )}

      {/* 下列对话框是懒块(见顶部 lazy 声明):首次打开前不挂载;打开过后常驻,open 显隐语义同前。
          DialogFallback 只在首次拉块的空窗出现。 */}
      {!demo && auth && messageFeedbackMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
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
        </LazyBoundary>
      )}

      {projectArchiveMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ProjectArchiveDialog
            open={projectArchiveOpen}
            onOpenChange={setProjectArchiveOpen}
            archived={projects.filter((p) => p.archivedAt)}
            loadDeleted={listDeletedProjects}
            onUnarchive={(p) => setProjectArchived(p, false)}
            onRestore={restoreProject}
          />
        </LazyBoundary>
      )}
      {paletteMounted && (
        <LazyBoundary fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            userId={paletteUserId}
            projects={projects}
            sessions={sessions}
            currentProjectId={
              homeProject?.id ??
              (boardOpen
                ? null
                : ((chatViewActiveId ? sessions.find((x) => x.id === chatViewActiveId)?.projectId : null) ??
                  draftProjectId))
            }
            onProjectHome={!!homeProject}
            activeSession={chatViewActiveId ? (sessions.find((x) => x.id === chatViewActiveId) ?? null) : null}
            searchMessages={paletteSearchMessages}
            searchAssets={paletteSearchAssets}
            onOpenProject={(projectId, tab) => {
              if (!projects.some((x) => x.id === projectId)) return;
              setPendingRouteProject(null);
              setBoardOpenState(false);
              setProjectHome({ projectId, tab: tab ?? "overview" });
            }}
            onOpenSession={(id) => {
              setDraftProject(null);
              setBoardOpen(false);
              selectSession(id);
            }}
            onOpenUngroupedAssets={() => {
              setProjectSettings(null);
              setUngroupedAssetsOpen(true);
            }}
            onNewSession={() => {
              setBoardOpen(false);
              handleNew();
            }}
            onNewSessionInProject={(projectId) => {
              setBoardOpen(false);
              newSessionInProject(projectId);
            }}
            onCreateProject={(name) => setCreateProjectFrom(name ? { title: name } : {})}
            onMoveSession={(sess, projectId) => void moveSessionToProject(sess, projectId)}
            onOpenBoard={demo || !TASKBOARD_ENABLED ? undefined : () => setBoardOpen(true)}
          />
        </LazyBoundary>
      )}
      {saveToProjectMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
          <SaveToProjectDialog
            request={saveToProject}
            onClose={() => setSaveToProject(null)}
            currentAuth={() => authRef.current}
            prepareBoard={prepareProjectBoard}
            onShowSurface={(surface) => {
              setProjectHome(null);
              setBoardOpen(false);
              openManage(surface);
            }}
          />
        </LazyBoundary>
      )}
      {createProjectMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
          <CreateProjectDialog
            open={createProjectFrom !== null}
            onOpenChange={(o) => {
              if (!o) setCreateProjectFrom(null);
            }}
            fromSessionTitle={createProjectFrom?.sessionId ? (createProjectFrom.title ?? "") : null}
            initialName={createProjectFrom && !createProjectFrom.sessionId ? (createProjectFrom.title ?? null) : null}
            onSubmit={async (input) => {
              const from = createProjectFrom;
              // 上传与之后的落位都绑定发起创建时的身份:中途换号/登出则停,不把文件传进另一个账号。
              const createAuth = authRef.current;
              const createEpoch = createAuth.snapshot().epoch;
              const identityChanged = () =>
                authRef.current !== createAuth || createAuth.snapshot().epoch !== createEpoch;
              const created = await createProject({
                name: input.name,
                instructions: input.instructions,
                ...(input.color ? { color: input.color } : {}),
              });
              if (!created) return false;
              if (identityChanged()) return true;
              if (input.files.length > 0 && !demo && auth) {
                const result = await uploadFilesToProject({
                  auth: createAuth,
                  projectId: created.id,
                  files: input.files,
                  identityChanged,
                });
                if (result.aborted) return true;
                if (result.failed > 0) {
                  toast(`有 ${result.failed} 个文件没有上传成功，可以在项目设置的「文件」里重新上传`, "error");
                }
              }
              const moving = from?.sessionId ? sessions.find((x) => x.id === from.sessionId) : undefined;
              if (moving) moveSessionToProject(moving, created.id);
              else {
                setBoardOpen(false);
                newSessionInProject(created.id);
              }
              return true;
            }}
          />
        </LazyBoundary>
      )}
      {projectSettingsMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ProjectSettingsDialog
            project={projectSettings}
            assetsOnly={ungroupedAssetsOpen}
            open={projectSettingsOpen}
            onClose={() => {
              setProjectSettings(null);
              setUngroupedAssetsOpen(false);
            }}
            onSave={async (patch) => {
              if (!projectSettings) return;
              await updateProject(projectSettings.id, patch);
            }}
            demo={demo}
            auth={auth}
            authSession={authRef.current}
            sessions={sessions}
            onOpenSession={(sessionId) => {
              setProjectSettings(null);
              setUngroupedAssetsOpen(false);
              setBoardOpen(false);
              selectSession(sessionId);
            }}
          />
        </LazyBoundary>
      )}

      {inboxMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
          <InboxDialog
            open={inboxOpen}
            auth={auth}
            onClose={() => setInboxOpen(false)}
            onUnreadChange={inbox.refreshUnread}
          />
        </LazyBoundary>
      )}

      {!demo && mediaTasksOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <MediaTaskCenter
            open={mediaTasksOpen}
            auth={auth}
            liveJob={liveMediaJob}
            onOpenChange={setMediaTasksOpen}
            onReusePrompt={(prompt) => {
              // media M-17 / X-M4:失败任务「重新发起」→ 关任务中心,提示词写进 Composer 草稿
              //(与教程 starterPrompt / 编辑重发同一条 prefill 路),用户改一改就能再发。
              setMediaTasksOpen(false);
              setComposerPrefill({ text: prompt, nonce: Date.now() });
            }}
          />
        </LazyBoundary>
      )}

      {/* OCV5-369:右上角「分享会话」。原 Markdown 导出收进对话框的次要入口。 */}
      {!demo && shareOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ShareDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            messages={wsMessages}
            sending={sending}
            title={activeSess?.title}
            agentName={agent.name || "助手"}
            onExportMarkdown={async () => {
              const md = await exportSessionMarkdown(wsMessages);
              saveBlob(
                new Blob([md], {
                  type: "text/markdown;charset=utf-8",
                }),
                sessionExportFilename(activeSess?.title),
              );
            }}
          />
        </LazyBoundary>
      )}

      {!demo && auth && chatGptProxyEnabled && chatGptProxyOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ChatGptProxyDialog open={chatGptProxyOpen} auth={auth} onOpenChange={setChatGptProxyOpen} />
        </LazyBoundary>
      )}

      {repoModalMounted && (
        <LazyBoundary fallback={<DialogFallback />}>
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
        </LazyBoundary>
      )}

      {manageOpen && (
        <LazyBoundary fallback={<DialogFallback />}>
          <ManageCenter
            open={manageOpen}
            tab={manageTab}
            auth={auth}
            agentId={agent.id}
            agents={myAgents}
            autoAuthorizePluginSlug={manageAutoAuthorizePluginSlug}
            onAutoAuthorizeConsumed={() => setManageAutoAuthorizePluginSlug(null)}
            onTabChange={(next) => setManageTab(normalizeManageTab(next))}
            onOpenMarketplace={(kind) => {
              setManageOpen(false);
              openMarketplace("browse", kind);
            }}
            onAskInChat={(text) => {
              // 与市场「在对话中试用」同构：关管理中心 → 新会话 → 预填输入框；不自动发送。
              setManageOpen(false);
              newSession();
              setComposerPrefill({ text, nonce: Date.now() });
            }}
            // 「怎么用」：openTutorial 自己会先收起管理中心，避免两层弹层叠加。
            onOpenHelp={(featureId) => openTutorial(featureId)}
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
            onRequireLogin={() => {
              // market K-24 / X-01:未登录空态「去登录」真的去登录,与 ManageCenter 同款契约
              //(回调自己负责关市场 + 切登录;正常路径进不来,属深链兜底)。
              setMarketplaceOpen(false);
              if (demo) {
                window.location.href = "/";
                return;
              }
              setAuthMode("login");
              setView("app");
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

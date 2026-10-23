/**
 * App-level dialogs and lazy panels (settings, feedback, palette, projects, inbox, media, share, repo, manage, marketplace, org, tutorial)
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { AgentPicker } from "./AgentPicker";
import { PendingPaymentRecovery } from "./payment/PendingPaymentRecovery";
import { LazyBoundary } from "./ChunkErrorBoundary";
import { DialogFallback } from "./DialogFallback";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import { uploadFilesToProject } from "../lib/projectFileUpload";
import { normalizeManageTab } from "../lib/manageTabs";
import { CHAT_CREATE_TEMPLATES } from "../lib/chatCreateTemplates";
import { DEFAULT_AGENT } from "../lib/agents";
import { lazy } from "react";
import type { ChatMessage, ChatSession } from "../lib/chat/model";
import type { Agent } from "../lib/agents";
import type { PrefsView } from "../lib/modelPreferences";
import type { AuthSession, ChatProject, DeletedChatProject, ProjectAsset, PublicModel, RepoSelection, Session, SessionSearchHit, User } from "../lib/types";
import type { UseChatSocket } from "../hooks/useChatSocket";
import type { CollabMode, CollabUiState } from "../lib/collaborationConfig";
import type { CreateProjectInput } from "../hooks/useChatProjects";
import type { ManageTab } from "../lib/manageTabs";
import type { MarketplaceKind, MarketplaceTab } from "./MarketplaceCenter";
import type { FeedbackContext } from "./chat/cards";
import type { OrgSection } from "./OrgCenter";
import type { RepoBindErrorWire, RepoStatusWire } from "../lib/chat/frames";
import type { SaveToProjectRequest } from "./project/SaveToProjectDialog";
import type { AuthMode } from "./AuthGate";
import type { ChatError } from "./ErrorBanner";
import type { ProjectRoute } from "../hooks/useAppRoute";
import type { Theme } from "../hooks/useTheme";
import type { SettingsDestinationSection } from "../lib/productCapabilities";
import type { ToastFn } from "./ui/Toast";

const SettingsCenter = lazy(() =>
  import("./SettingsCenter").then((m) => ({ default: m.SettingsCenter })),
);

const MessageFeedbackDialog = lazy(() =>
  import("./chat/MessageFeedbackDialog").then((m) => ({ default: m.MessageFeedbackDialog })),
);

const ProjectArchiveDialog = lazy(() =>
  import("./ProjectArchiveDialog").then((m) => ({ default: m.ProjectArchiveDialog })),
);

// Ctrl/⌘K palette: lazy, mounted on first open (first-screen budget).
const CommandPalette = lazy(() =>
  import("./CommandPalette").then((m) => ({ default: m.CommandPalette })),
);

// P5b「记住这条 / 存为项目技能」弹窗：点了才下载（带 lib/taskboard）。
const SaveToProjectDialog = lazy(() =>
  import("./project/SaveToProjectDialog").then((m) => ({ default: m.SaveToProjectDialog })),
);

const CreateProjectDialog = lazy(() =>
  import("./CreateProjectDialog").then((m) => ({ default: m.CreateProjectDialog })),
);

const ProjectSettingsDialog = lazy(() =>
  import("./ProjectSettingsDialog").then((m) => ({ default: m.ProjectSettingsDialog })),
);

const InboxDialog = lazy(() => import("./InboxDialog").then((m) => ({ default: m.InboxDialog })));

const MediaTaskCenter = lazy(() =>
  import("./MediaTaskCenter").then((m) => ({ default: m.MediaTaskCenter })),
);

const ShareDialog = lazy(() => import("./ShareDialog").then((m) => ({ default: m.ShareDialog })));

const ChatGptProxyDialog = lazy(() =>
  import("./ChatGptProxyDialog").then((m) => ({ default: m.ChatGptProxyDialog })),
);

const GithubRepoModal = lazy(() =>
  import("./github/GithubRepoModal").then((m) => ({ default: m.GithubRepoModal })),
);

const ManageCenter = lazy(() => import("./ManageCenter").then((m) => ({ default: m.ManageCenter })));

const MarketplaceCenter = lazy(() =>
  import("./MarketplaceCenter").then((m) => ({ default: m.MarketplaceCenter })),
);

// 企业版(P3.1)第四中心。仅 org owner/admin 有入口(成员在设置·账户页只读展示)。
const OrgCenter = lazy(() => import("./OrgCenter").then((m) => ({ default: m.OrgCenter })));

export type AppDialogsProps = {
  activeId: string | undefined;
  activeSess: ChatSession | undefined;
  agent: Agent;
  applyConversationPreferences: (prefs: PrefsView, _patch?: Record<string, unknown> | undefined) => void;
  auth: AuthSession | null;
  authRef: React.RefObject<AuthSession>;
  authed: boolean;
  boardOpen: boolean;
  chat: UseChatSocket;
  chatGptProxyEnabled: boolean;
  chatGptProxyOpen: boolean;
  chatViewActiveId: string | undefined;
  collabAsDefault: boolean;
  collabMode: CollabMode;
  collabSaveError: string | null;
  collabUi: CollabUiState;
  createProject: (input: CreateProjectInput) => Promise<ChatProject | null>;
  createProjectFrom: { sessionId?: string | undefined; title?: string | undefined; } | null;
  createProjectMounted: boolean;
  demo: boolean;
  draftProjectId: string | null;
  handleNew: () => void;
  homeProject: ChatProject | undefined;
  inbox: { unreadCount: number; refreshUnread: () => Promise<void>; setUnreadCount: React.Dispatch<React.SetStateAction<number>>; };
  inboxMounted: boolean;
  inboxOpen: boolean;
  listDeletedProjects: () => Promise<DeletedChatProject[]>;
  liveMediaJob: { prompt?: string | undefined; sessionId?: string | null | undefined; projectId?: string | null | undefined; projectShotId?: string | null | undefined; durationSeconds?: number | undefined; aspect?: string | undefined; currentStep?: number | null | undefined; totalSteps?: number | null | undefined; queuePosition?: number | null | undefined; resultUrl?: string | null | undefined; resultSha256?: string | null | undefined; resultSize?: number | null | undefined; errorCode?: string | null | undefined; errorMessage?: string | null | undefined; id: string; requestId: string; kind: "h3_generate" | "video_compose"; resourceClass: "gpu-h3" | "cpu-compose"; status: "queued" | "dispatching" | "running" | "reconnecting" | "completed" | "failed" | "canceled"; phase: string; createdAt: string; updatedAt: string; } | null;
  manageAutoAuthorizePluginSlug: string | null;
  manageOpen: boolean;
  manageTab: ManageTab;
  marketplaceBrowseKind: MarketplaceKind;
  marketplaceOpen: boolean;
  marketplaceTab: MarketplaceTab;
  mediaTasksOpen: boolean;
  messageFeedback: FeedbackContext | null;
  messageFeedbackMounted: boolean;
  messageFeedbackTriggerRef: React.RefObject<HTMLElement | null>;
  modelId: string | undefined;
  models: PublicModel[];
  moveSessionToProject: (s: Session, projectId: string | null) => Promise<void>;
  myAgents: Agent[];
  newSession: () => void;
  newSessionInProject: (projectId: string) => void;
  openManage: (tab: ManageTab) => void;
  openMarketplace: (tab: MarketplaceTab, kind?: MarketplaceKind) => void;
  openRepo: () => void;
  openTutorial: (id?: "preferences" | "connectors" | "chat-basics" | "inbox" | "taskboard" | "session-goal" | "sessions-history" | "models-reasoning" | "files-media" | "voice-input" | "web-research" | "artifacts-download" | "container-web-preview" | "image-create-edit" | "github-repository" | "agents" | "team-mode" | "advisor-mode" | "memory-auto-dream" | "schedules-reminders" | "skills-training" | "marketplace-discovery" | "marketplace-publishing" | "billing-usage" | "organization" | "feedback-support" | undefined) => void;
  orgOpen: boolean;
  orgSection: OrgSection;
  paletteMounted: boolean;
  paletteOpen: boolean;
  paletteSearchAssets: ((q: string, signal: AbortSignal, limit: number) => Promise<ProjectAsset[]>) | undefined;
  paletteSearchMessages: ((q: string, signal: AbortSignal) => Promise<SessionSearchHit[]>) | undefined;
  paletteUserId: string | null;
  persistCollab: (mode: CollabMode, opts?: { advisorModel?: string | null | undefined; asDefault?: boolean | undefined; } | undefined) => Promise<void>;
  pickerOpen: boolean;
  prepareProjectBoard: (boardProjectId: string) => Promise<boolean>;
  projectArchiveMounted: boolean;
  projectArchiveOpen: boolean;
  projectSettings: ChatProject | null;
  projectSettingsMounted: boolean;
  projectSettingsOpen: boolean;
  projects: ChatProject[];
  refreshMe: () => Promise<void>;
  refreshMyAgents: () => Promise<Agent[]>;
  repo: { selection: RepoSelection | null; progressPct: number; showBanner: boolean; confirm: (owner: string, repo: string, branch: string) => Promise<void>; unbind: () => Promise<void>; refresh: () => void; dismissBanner: () => void; onRepoStatus: (frame: RepoStatusWire) => void; onRepoBindError: (frame: RepoBindErrorWire) => void; };
  repoModalMounted: boolean;
  repoModalOpen: boolean;
  restoreProject: (projectId: string) => Promise<boolean>;
  saveToProject: SaveToProjectRequest | null;
  saveToProjectMounted: boolean;
  selectSession: (id: string) => void;
  sending: boolean;
  sessions: Session[];
  setAgent: React.Dispatch<React.SetStateAction<Agent>>;
  setAuthMode: React.Dispatch<React.SetStateAction<AuthMode>>;
  setBoardOpen: (open: boolean) => void;
  setBoardOpenState: React.Dispatch<React.SetStateAction<boolean>>;
  setChatError: React.Dispatch<React.SetStateAction<ChatError | null>>;
  setChatGptProxyOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCollabAsDefault: React.Dispatch<React.SetStateAction<boolean>>;
  setCollabMode: (mode: CollabMode) => void;
  setComposerPrefill: React.Dispatch<React.SetStateAction<{ text: string; nonce: number; } | null>>;
  setCreateProjectFrom: React.Dispatch<React.SetStateAction<{ sessionId?: string | undefined; title?: string | undefined; } | null>>;
  setDraftProject: (projectId: string | null) => void;
  setInboxOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setManageAutoAuthorizePluginSlug: React.Dispatch<React.SetStateAction<string | null>>;
  setManageOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setManageTab: React.Dispatch<React.SetStateAction<ManageTab>>;
  setMarketplaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMarketplaceTab: React.Dispatch<React.SetStateAction<MarketplaceTab>>;
  setMediaTasksOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMessageFeedback: React.Dispatch<React.SetStateAction<FeedbackContext | null>>;
  setMyAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  setOrgOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingRouteProject: React.Dispatch<React.SetStateAction<ProjectRoute | null>>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectArchiveOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectArchived: (p: ChatProject, archived: boolean) => Promise<void>;
  setProjectHome: React.Dispatch<React.SetStateAction<ProjectRoute | null>>;
  setProjectSettings: React.Dispatch<React.SetStateAction<ChatProject | null>>;
  setRepoModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSaveToProject: React.Dispatch<React.SetStateAction<SaveToProjectRequest | null>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTeamMode: (enabled: boolean) => void;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  setUngroupedAssetsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setView: React.Dispatch<React.SetStateAction<"home" | "app">>;
  settingsFeedbackContext: { sessionId: string | null; requestId: string; } | { sessionId: string | null; requestId: null; };
  settingsOpen: boolean;
  settingsSection: SettingsDestinationSection;
  shareOpen: boolean;
  subscribeOpenSignal: number;
  teamMode: boolean;
  theme: Theme;
  toast: ToastFn;
  ungroupedAssetsOpen: boolean;
  updateProject: (id: string, patch: { name?: string | undefined; color?: string | null | undefined; instructions?: string | null | undefined; }) => Promise<void>;
  user: User | null;
  wsMessages: ChatMessage[];
};

export function AppDialogs({
  activeId,
  activeSess,
  agent,
  applyConversationPreferences,
  auth,
  authRef,
  authed,
  boardOpen,
  chat,
  chatGptProxyEnabled,
  chatGptProxyOpen,
  chatViewActiveId,
  collabAsDefault,
  collabMode,
  collabSaveError,
  collabUi,
  createProject,
  createProjectFrom,
  createProjectMounted,
  demo,
  draftProjectId,
  handleNew,
  homeProject,
  inbox,
  inboxMounted,
  inboxOpen,
  listDeletedProjects,
  liveMediaJob,
  manageAutoAuthorizePluginSlug,
  manageOpen,
  manageTab,
  marketplaceBrowseKind,
  marketplaceOpen,
  marketplaceTab,
  mediaTasksOpen,
  messageFeedback,
  messageFeedbackMounted,
  messageFeedbackTriggerRef,
  modelId,
  models,
  moveSessionToProject,
  myAgents,
  newSession,
  newSessionInProject,
  openManage,
  openMarketplace,
  openRepo,
  openTutorial,
  orgOpen,
  orgSection,
  paletteMounted,
  paletteOpen,
  paletteSearchAssets,
  paletteSearchMessages,
  paletteUserId,
  persistCollab,
  pickerOpen,
  prepareProjectBoard,
  projectArchiveMounted,
  projectArchiveOpen,
  projectSettings,
  projectSettingsMounted,
  projectSettingsOpen,
  projects,
  refreshMe,
  refreshMyAgents,
  repo,
  repoModalMounted,
  repoModalOpen,
  restoreProject,
  saveToProject,
  saveToProjectMounted,
  selectSession,
  sending,
  sessions,
  setAgent,
  setAuthMode,
  setBoardOpen,
  setBoardOpenState,
  setChatError,
  setChatGptProxyOpen,
  setCollabAsDefault,
  setCollabMode,
  setComposerPrefill,
  setCreateProjectFrom,
  setDraftProject,
  setInboxOpen,
  setManageAutoAuthorizePluginSlug,
  setManageOpen,
  setManageTab,
  setMarketplaceOpen,
  setMarketplaceTab,
  setMediaTasksOpen,
  setMessageFeedback,
  setMyAgents,
  setOrgOpen,
  setPaletteOpen,
  setPendingRouteProject,
  setPickerOpen,
  setProjectArchiveOpen,
  setProjectArchived,
  setProjectHome,
  setProjectSettings,
  setRepoModalOpen,
  setSaveToProject,
  setSettingsOpen,
  setShareOpen,
  setTeamMode,
  setTheme,
  setUngroupedAssetsOpen,
  setView,
  settingsFeedbackContext,
  settingsOpen,
  settingsSection,
  shareOpen,
  subscribeOpenSignal,
  teamMode,
  theme,
  toast,
  ungroupedAssetsOpen,
  updateProject,
  user,
  wsMessages,
}: AppDialogsProps) {
  return (
    <>
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
            activeSessionId={activeId}
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
      
    </>
  );
}

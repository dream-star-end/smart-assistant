/**
 * App navigation and open actions, settings feedback context and product tutorial actions
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { useDraftSessionMaterialization } from "./useDraftSessionMaterialization";
import { useCallback, useMemo } from "react";
import type { ChatMessage } from "../lib/chat/model";
import { lastRealUserTurn } from "../lib/chat/pure";
import { exactUserReplayPayload } from "../lib/chat/socket";
import type { SettingsSection } from "../components/SettingsCenter";
import type { LockedSelectInfo } from "../components/ModelSelector";
import { lockedModelUnlockNotice } from "../lib/cursorModelPicker";
import type { PrefsView } from "../lib/modelPreferences";
import { type ManageTab, normalizeManageTab } from "../lib/manageTabs";
import type { MarketplaceTab, MarketplaceKind } from "../components/MarketplaceCenter";
import type { OrgSection } from "../components/OrgCenter";
import { type ProductFeatureId, type ProductCapability, PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import { resolveTutorialAction } from "../lib/tutorialActions";
import type { TutorialCase } from "../lib/tutorialCaseCatalog";
import type { Agent } from "../lib/agents";
import type { AuthSession, Message, Session, User } from "../lib/types";
import type { ConfirmChoice, ConfirmOpts } from "../components/ui/ConfirmDialog";
import type { PreferenceEffort } from "../lib/modelPreferences";
import type { AuthMode } from "../components/AuthGate";
import type { SettingsDestinationSection } from "../lib/productCapabilities";
import type { TutorialTab } from "./useAppRoute";
import type { UseChatSocket } from "./useChatSocket";
import type { ToastFn } from "../components/ui/Toast";

export type AppNavigationActionsInput = {
  activeId: string | undefined;
  agent: Agent;
  auth: AuthSession | null;
  promoteDraftCollab: (sessionId: string) => void;
  confirmDialog: (opts: ConfirmOpts) => Promise<ConfirmChoice>;
  contextTier: "300k" | "1m";
  demo: boolean;
  draftSessionId: string;
  handleNew: () => void;
  image2Available: boolean;
  messages: Message[];
  modelId: string | undefined;
  refreshMe: () => Promise<void>;
  send: (text: string, media?: { url?: string | undefined; base64?: string | undefined; mimeType?: string | undefined; filename?: string | undefined; hidden?: boolean | undefined; localSrc?: string | undefined; kind: "image" | "audio" | "video" | "file"; }[] | undefined, imageEdit?: { mode?: "annotated" | "outpaint" | undefined; maskIndex?: number | undefined; targetAspect?: "16:9" | "4:3" | "9:16" | "3:4" | "1:1" | undefined; clientJobId: string; sourceIndex: number; guideIndex: number; width: number; height: number; } | undefined, displayText?: string | undefined, replyTo?: { text: string; messageId: string; role: "user" | "assistant"; } | undefined, target?: { sessionId: string; projectId?: string | null | undefined; } | undefined) => Promise<unknown>;
  serviceTier: "fast" | null;
  sessionEffort: PreferenceEffort | null | undefined;
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setAuthMode: React.Dispatch<React.SetStateAction<AuthMode>>;
  setBoardOpen: (open: boolean) => void;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPrefill: React.Dispatch<React.SetStateAction<{ text: string; nonce: number; } | null>>;
  setInboxOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setManageOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setManageTab: React.Dispatch<React.SetStateAction<ManageTab>>;
  setMarketplaceBrowseKind: React.Dispatch<React.SetStateAction<MarketplaceKind>>;
  setMarketplaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMarketplaceTab: React.Dispatch<React.SetStateAction<MarketplaceTab>>;
  setMobileNavOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModelPrefs: React.Dispatch<React.SetStateAction<PrefsView>>;
  setOrgOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOrgSection: React.Dispatch<React.SetStateAction<OrgSection>>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPreferenceEffort: React.Dispatch<React.SetStateAction<PreferenceEffort | undefined>>;
  setRepoModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsSection: React.Dispatch<React.SetStateAction<SettingsDestinationSection>>;
  setSubscribeOpenSignal: React.Dispatch<React.SetStateAction<number>>;
  setTutorialCase: React.Dispatch<React.SetStateAction<"research-evidence-map" | "research-bike-demand" | "research-systematic-screening" | "research-open-peer-review" | "research-replication-audit" | "coding-swe-bench-fix" | "coding-feature-delivery" | "coding-regression-rescue" | "coding-frontend-quality" | "coding-dependency-upgrade" | "general-meeting-actions" | "general-public-data-brief" | null>>;
  setTutorialCommunity: React.Dispatch<React.SetStateAction<string | null>>;
  setTutorialOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTutorialStep: React.Dispatch<React.SetStateAction<number | null>>;
  setTutorialTab: React.Dispatch<React.SetStateAction<TutorialTab | null>>;
  setTutorialTopic: React.Dispatch<React.SetStateAction<"connectors" | "preferences" | "chat-basics" | "inbox" | "taskboard" | "session-goal" | "sessions-history" | "models-reasoning" | "files-media" | "voice-input" | "web-research" | "artifacts-download" | "container-web-preview" | "image-create-edit" | "github-repository" | "agents" | "team-mode" | "advisor-mode" | "memory-auto-dream" | "schedules-reminders" | "skills-training" | "marketplace-discovery" | "marketplace-publishing" | "billing-usage" | "organization" | "feedback-support" | null>>;
  setTutorialWork: React.Dispatch<React.SetStateAction<"planet" | "gravity" | null>>;
  setView: React.Dispatch<React.SetStateAction<"home" | "app">>;
  sockRef: React.RefObject<UseChatSocket | null>;
  stopPreparing: () => void;
  toast: ToastFn;
  user: User | null;
  view: "home" | "app";
};

export function useAppNavigationActions({
  activeId,
  agent,
  auth,
  promoteDraftCollab,
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
}: AppNavigationActionsInput) {
  const ensureActiveSession = useDraftSessionMaterialization({
    demo, userId: user?.id, activeId, draftSessionId, stopPreparing, agentId: agent.id, modelId,
    promoteDraftCollab, sessionEffort, contextTier, serviceTier,
    sockRef, setSessions, setActiveId,
  });

  // 打开 GitHub 绑定 modal:先确保有承载会话,否则「确认绑定」因 !sessionId 恒禁用
  // (输入框底部入口 → 发消息前即可绑定)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setRepoModalOpen is App useState setter/useRef passed in, stable
  const openRepo = useCallback(() => {
    ensureActiveSession();
    setRepoModalOpen(true);
  }, [ensureActiveSession]);

  /** Resolve a lazy user locator to its immutable persisted row for one
   * action. The hydrated object stays on the stack; it is never merged into
   * ChatSocket/IndexedDB, so even a huge prompt does not bloat hot history. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
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
    // 跳过恢复/续跑控制行:那是系统续接指令,不是用户的真实提问。判定走持久血缘,
    // 不依赖会在 refresh / server-wins 中丢失的 `_isAutoRetry`。
    const src = sockRef.current?.getMessages(activeId) ?? [];
    const m = lastRealUserTurn(src);
    if (!m) return;
    const exact = await loadExactUserMessage(m);
    if (!exact) {
      toast("原始消息加载失败，请重试", "error");
      return;
    }
    const replay = exactUserReplayPayload(exact);
    await send(replay.text, replay.media, replay.imageEdit, replay.displayText);
  }, [demo, messages, activeId, send, loadExactUserMessage, toast]);

  // 打开设置中心并顺带刷新余额（顶栏 pill / 侧栏 / AgentGate 充值入口统一走此）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setSettingsOpen, setSettingsSection are App useState setter/useRef passed in, stable
  const openSettings = useCallback((section: SettingsSection = "account") => {
    void refreshMe();
    setSettingsSection(section);
    setSettingsOpen(true);
  }, [refreshMe]);

  // OCV5-86:锁定模型先弹说明(为什么锁、任意订阅即可解锁),用户确认后才跳订阅面板;
  // 之前一句 toast 直接跳转,用户不知道任何一档订阅都够。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setSubscribeOpenSignal is App useState setter/useRef passed in, stable
  const handleLockedSelect = useCallback(
    (info: LockedSelectInfo) => {
      const notice = lockedModelUnlockNotice(info);
      void (async () => {
        const go = await confirmDialog({
          title: notice.title,
          body: (
            <div className="space-y-2 text-sm text-muted" data-testid="locked-model-unlock-notice">
              {notice.paragraphs.map((text) => <p key={text}>{text}</p>)}
            </div>
          ),
          confirmText: notice.confirmText,
          cancelText: notice.cancelText,
        });
        if (go !== true) return;
        openSettings("account");
        setSubscribeOpenSignal((n) => n + 1);
      })();
    },
    [confirmDialog, openSettings],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setModelPrefs, setPreferenceEffort are App useState setter/useRef passed in, stable
  const applyConversationPreferences = useCallback(
    (prefs: PrefsView, patch?: Record<string, unknown>) => {
      setPreferenceEffort(prefs.default_effort);
      // default_model 变更经 modelPrefs → resolver effect 传导:只影响「无自有持久化选择」
      // 的会话与空会话态;已显式选过模型的会话保持自身选择(per-session 隔离语义)。
      // 仅当设置/系统助手显式修改 default_model 时打本地变更戳,打开设置重读或改 theme 不改此水位。
      setModelPrefs((prev) => {
        const modelPatched =
          (patch !== undefined && "default_model" in patch) ||
          (prev.default_model !== undefined && prefs.default_model !== prev.default_model);
        const defaultModelChangedAt = modelPatched
          ? prefs.default_model
            ? Date.now()
            : undefined
          : prev.default_model_updated_at;
        return defaultModelChangedAt !== undefined
          ? { ...prefs, default_model_updated_at: defaultModelChangedAt }
          : prefs;
      });
    },
    [],
  );

  // 打开管理中心到指定分区（侧栏入口 + 工具卡「打开记忆/技能/定时」按钮统一走此）。
  // 归一化：已下线分区（文献 / 优化）或未知值从旧入口进来时回落默认分区，不开空白页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setManageOpen, setManageTab are App useState setter/useRef passed in, stable
  const openManage = useCallback((tab: ManageTab) => {
    setManageTab(normalizeManageTab(tab));
    setManageOpen(true);
  }, []);

  // 打开 AI 市场到指定分区（侧栏入口 / 「从市场添加智能体」)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setMarketplaceBrowseKind, setMarketplaceOpen, setMarketplaceTab are App useState setter/useRef passed in, stable
  const openMarketplace = useCallback((tab: MarketplaceTab, kind: MarketplaceKind = "skill") => {
    setMarketplaceTab(tab);
    setMarketplaceBrowseKind(kind);
    setMarketplaceOpen(true);
  }, []);

  // 打开组织中心(企业版第四中心;仅 owner/admin 有入口)。顺带刷新余额/归属。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setOrgOpen, setOrgSection are App useState setter/useRef passed in, stable
  const openOrg = useCallback((section: OrgSection = "overview") => {
    void refreshMe();
    setOrgSection(section);
    setOrgOpen(true);
  }, [refreshMe]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setManageOpen, setMarketplaceOpen, setOrgOpen, setSettingsOpen, setTutorialCase, setTutorialCommunity, setTutorialOpen, setTutorialStep, setTutorialTab, setTutorialTopic, setTutorialWork are App useState setter/useRef passed in, stable
  const openTutorial = useCallback((id?: ProductFeatureId) => {
    // 教程是单一顶层中心：打开前收起其他中心，避免多层 Radix Dialog 叠加与焦点陷阱互抢。
    setSettingsOpen(false);
    setManageOpen(false);
    setMarketplaceOpen(false);
    setOrgOpen(false);
    setTutorialTopic(id ?? null);
    setTutorialCase(null);
    setTutorialCommunity(null);
    setTutorialTab(null);
    setTutorialWork(null);
    setTutorialStep(null);
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
      // 商业构建关掉任务面板时「任务面板」教程的 CTA 不再可点却什么都不发生（tutorials TU-32）；
      // 与下方 runTutorialAction 的 taskboard 分支同一开关。
      taskboardEnabled: TASKBOARD_ENABLED,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setCollapsed, setInboxOpen, setMobileNavOpen, setPickerOpen, setTutorialOpen are App useState setter/useRef passed in, stable
  const runTutorialAction = useCallback(
    (feature: ProductCapability) => {
      const resolved = resolveTutorialAction(feature, tutorialActionContext);
      if (!resolved.enabled) return;
      setTutorialOpen(false);
      const destination = feature.destination;
      switch (destination.kind) {
        case "new-chat":
          handleNew();
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
        case "taskboard":
          if (TASKBOARD_ENABLED) {
            setCollapsed(false);
            setBoardOpen(true);
          }
          break;
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
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setAuthMode, setComposerPrefill, setTutorialOpen, setView are App useState setter/useRef passed in, stable
  const runTutorialCase = useCallback(
    (item: TutorialCase) => {
      setTutorialOpen(false);
      if (!inWorkspace) {
        try {
          sessionStorage.setItem(
            "oc_v5_pending_case",
            JSON.stringify({ caseId: item.id, starterPrompt: item.starterPrompt }),
          );
        } catch {
          /* quota / private mode */
        }
        setAuthMode("login");
        setView("app");
        return;
      }
      handleNew();
      setComposerPrefill({ text: item.starterPrompt, nonce: Date.now() });
    },
    [inWorkspace, handleNew],
  );

  return {
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
  };
}

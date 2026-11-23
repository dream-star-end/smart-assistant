import * as Dialog from "@radix-ui/react-dialog";
import { Compass, type LucideIcon, PenLine, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/chat/model";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
  capabilityById,
} from "../lib/productCapabilities";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import type { TutorialActionState } from "../lib/tutorialActions";
import {
  TUTORIAL_CASES,
  type TutorialCase,
  type TutorialCaseId,
} from "../lib/tutorialCaseCatalog";
import { type TutorialTopic, tutorialById } from "../lib/tutorialCatalog";
import { markTutorialRead } from "../lib/tutorialProgress";
import { SIGNATURE_WORKS, type SignatureWork } from "../lib/tutorialSignatureWorks";
import type { AuthSession } from "../lib/types";
import { cn } from "../lib/utils";
import { LegacyDeepLinkViews } from "./tutorials/LegacyDeepLinkViews";
import { PracticalGuideView } from "./tutorials/PracticalGuideView";
import { QuickLookupView } from "./tutorials/QuickLookupView";
import { type BlogViewRequest, CommunityBlog } from "./tutorials/blog/CommunityBlog";
import { IconButton } from "./ui";

/**
 * 教程中心 URL 页签值（向后兼容 `?panel=help&tab=` 路由协议）：
 * - `blog` → 经验分享（`blogEnabled=true` 时默认首屏）
 * - `start` / `cases` → 实战指南（`blogEnabled=false` 时默认首屏）
 * - `showcase` → 默认哨兵（`blogEnabled=true` 落经验分享，`false` 落实战指南）
 */
export type TutorialBrowseView = "showcase" | "start" | "cases" | "blog";

type PrimaryTabId = "blog" | "guide" | "lookup";
type ViewMode = PrimaryTabId | "legacy-work" | "legacy-case" | "legacy-community";

export interface TutorialCenterProps {
  open: boolean;
  topicId: ProductFeatureId | null;
  caseId?: TutorialCaseId | null;
  communityId?: string | null;
  onTopicChange: (id: ProductFeatureId) => void;
  onCaseChange?: (id: TutorialCaseId) => void;
  onShowCaseGallery?: () => void;
  onCommunityChange?: (id: string | null) => void;
  browseView?: TutorialBrowseView;
  onBrowseViewChange?: (view: TutorialBrowseView) => void;
  signatureWorkId?: SignatureWork["id"] | null;
  onSignatureWorkChange?: (id: SignatureWork["id"] | null) => void;
  /** 功能速查深链的目标步骤（`?step=`，1 起）：渲染后滚到该步并落焦点。 */
  stepIndex?: number | null;
  caseActionLabel?: string;
  onRunCase?: (item: TutorialCase) => void;
  onClose: () => void;
  actionState: (feature: ProductCapability) => TutorialActionState;
  onRunAction: (feature: ProductCapability) => void;
  auth?: AuthSession | null;
  userId?: string | null;
  onRequireLogin?: () => void;
  activeSessionId?: string | null;
  sessionMessages?: ChatMessage[];
  sending?: boolean;
  sessionTitle?: string;
  sessionProjectId?: string | null;
  /** 「经验分享」页签开关（由 /api/public/config 的 feature_community_blog 传入）。 */
  blogEnabled?: boolean;
  /** 任务面板功能开关（商业版构建 VITE_TASKBOARD_ENABLED=0 为 false）。 */
  taskboardEnabled?: boolean;
  /** 对话内经验分享卡请求打开「我的投稿」或带草稿的编辑器。 */
  blogRequest?: BlogViewRequest | null;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

export function tutorialMatches(feature: ProductCapability, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const topic = tutorialById(feature.id as ProductFeatureId);
  const haystack = normalizeSearch(
    [
      feature.title,
      feature.shortTitle,
      ...feature.aliases,
      topic.intro,
      topic.outcome,
      ...topic.scenarios,
      ...topic.steps.flatMap((step) => [step.title, step.body]),
    ].join(" "),
  );
  return q.split(" ").every((term) => haystack.includes(term));
}

export function tutorialCaseMatches(item: TutorialCase, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const haystack = normalizeSearch(
    [
      item.title,
      item.summary,
      item.audience,
      item.outcome,
      item.suggestion.agentName,
      item.suggestion.agentId,
      item.suggestion.modelId,
      item.suggestion.modelGuidance,
      ...item.requirements,
      ...item.sources.flatMap((source) => [source.title, source.usageNote]),
      ...item.inputMaterials.flatMap((input) => [input.title, input.description]),
      ...item.stages.flatMap((stage) => [
        stage.title,
        stage.input,
        stage.operation,
        stage.output,
        ...stage.visibleProcess,
        ...stage.acceptance,
      ]),
      ...item.artifacts.flatMap((artifact) => [artifact.title, artifact.description, artifact.format]),
      ...item.checks.flatMap((check) => [check.title, check.method, check.passCriterion]),
    ].join(" "),
  );
  return q.split(" ").every((term) => haystack.includes(term));
}

export function TutorialCenter({
  open,
  topicId,
  caseId = null,
  communityId = null,
  onTopicChange,
  onShowCaseGallery = () => {},
  onCommunityChange = () => {},
  caseActionLabel,
  onRunCase,
  onClose,
  actionState,
  onRunAction,
  auth = null,
  userId = null,
  onRequireLogin,
  activeSessionId = null,
  sessionMessages = [],
  sending = false,
  sessionTitle = "",
  sessionProjectId = null,
  browseView: browseViewProp,
  onBrowseViewChange,
  signatureWorkId: signatureWorkIdProp,
  onSignatureWorkChange,
  stepIndex = null,
  blogEnabled = true,
  taskboardEnabled = TASKBOARD_ENABLED,
  blogRequest = null,
}: TutorialCenterProps) {
  const [browseViewState, setBrowseViewState] = useState<TutorialBrowseView>("showcase");
  const [signatureWorkIdState, setSignatureWorkIdState] = useState<SignatureWork["id"] | null>(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [dismissedTopicId, setDismissedTopicId] = useState<ProductFeatureId | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prevBrowseViewProp = useRef(browseViewProp);
  const lastBlogRequestNonce = useRef(blogRequest?.nonce ?? 0);

  const requestedView = browseViewProp ?? browseViewState;
  const setBrowseView = (view: TutorialBrowseView) => {
    if (browseViewProp === undefined) setBrowseViewState(view);
    onBrowseViewChange?.(view);
  };

  const signatureWorkId =
    signatureWorkIdProp === undefined ? signatureWorkIdState : signatureWorkIdProp;
  const setSignatureWorkId = (id: SignatureWork["id"] | null) => {
    if (signatureWorkIdProp === undefined) setSignatureWorkIdState(id);
    onSignatureWorkChange?.(id);
  };

  const signatureWork = signatureWorkId
    ? SIGNATURE_WORKS.find((work) => work.id === signatureWorkId) ?? null
    : null;
  const effectiveTopicId =
    topicId &&
    topicId !== dismissedTopicId &&
    (taskboardEnabled || topicId !== "taskboard")
      ? topicId
      : null;
  // 请求的是 blog 页签时 communityId 是经验分享文章 id，即使 blogEnabled 暂未就绪也不得误入旧教程工作室。
  const isLegacyCommunity = Boolean(communityId && requestedView !== "blog");

  const mode: ViewMode = isLegacyCommunity
    ? "legacy-community"
    : signatureWork
      ? "legacy-work"
      : caseId
        ? "legacy-case"
        : effectiveTopicId || lookupOpen
          ? "lookup"
          : requestedView === "start" || requestedView === "cases"
            ? "guide"
            : blogEnabled
              ? "blog"
              : "guide";

  useEffect(() => {
    setDismissedTopicId(null);
  }, [topicId]);

  useEffect(() => {
    if (prevBrowseViewProp.current !== browseViewProp) {
      prevBrowseViewProp.current = browseViewProp;
      setLookupOpen(false);
    }
  }, [browseViewProp]);

  useEffect(() => {
    if (!blogRequest || blogRequest.nonce === lastBlogRequestNonce.current) return;
    lastBlogRequestNonce.current = blogRequest.nonce;
    setLookupOpen(false);
  }, [blogRequest]);

  useEffect(() => {
    if (!open) {
      setBrowseViewState("showcase");
      setSignatureWorkIdState(null);
      setLookupOpen(false);
      setDismissedTopicId(null);
      return;
    }
    if (!effectiveTopicId) return;
    const timer = window.setTimeout(() => {
      markTutorialRead(effectiveTopicId);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [open, effectiveTopicId]);

  // 切视图 / 切篇回到顶部；带 `?step=` 深链打开功能速查时把目标步骤滚入视口并落焦点。
  useEffect(() => {
    const container = detailRef.current;
    if (!container) return;
    const target =
      mode === "lookup" && effectiveTopicId && stepIndex
        ? container.querySelector<HTMLElement>(`[data-tutorial-step="${stepIndex}"]`)
        : null;
    if (!target) {
      container.scrollTop = 0;
      return;
    }
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mode, caseId, effectiveTopicId, communityId, signatureWorkId, stepIndex]);

  const showBlog = () => {
    setLookupOpen(false);
    setDismissedTopicId(topicId);
    setSignatureWorkId(null);
    setBrowseView("blog");
    onCommunityChange(null);
    onShowCaseGallery();
  };

  const showGuide = () => {
    setLookupOpen(false);
    setDismissedTopicId(topicId);
    setSignatureWorkId(null);
    setBrowseView("start");
    onCommunityChange(null);
    onShowCaseGallery();
  };

  const showLookup = () => {
    setLookupOpen(true);
    setDismissedTopicId(topicId);
    setSignatureWorkId(null);
    onCommunityChange(null);
    onShowCaseGallery();
  };

  const handleSelectTopic = (nextTopicId: ProductFeatureId | null) => {
    setLookupOpen(true);
    setSignatureWorkId(null);
    if (nextTopicId === null) {
      setDismissedTopicId(topicId);
      onShowCaseGallery();
      return;
    }
    setDismissedTopicId(null);
    onCommunityChange(null);
    onTopicChange(nextTopicId);
  };

  const exitLegacyView = () => {
    setLookupOpen(false);
    setSignatureWorkId(null);
    onCommunityChange(null);
    onShowCaseGallery();
    setBrowseView(blogEnabled ? "blog" : "start");
  };

  const handleTryScenario = (scenario: { id: string; title: string; prompt: string }) => {
    if (!onRunCase) return;
    const baseCase = TUTORIAL_CASES[0];
    onRunCase({
      ...baseCase,
      title: scenario.title,
      starterPrompt: scenario.prompt,
    });
  };

  const handleRunTopicAction = (topic: TutorialTopic) => {
    onRunAction(capabilityById(topic.featureId));
  };

  const getTopicActionState = (topic: TutorialTopic) => {
    const cta = actionState(capabilityById(topic.featureId));
    return {
      available: cta.enabled,
      label: cta.label,
      reason: cta.disabledReason,
    };
  };

  const tabs: Array<{ id: PrimaryTabId; label: string; icon: LucideIcon; onSelect: () => void }> = [
    ...(blogEnabled ? [{ id: "blog" as const, label: "经验分享", icon: PenLine, onSelect: showBlog }] : []),
    { id: "guide", label: "实战指南", icon: Compass, onSelect: showGuide },
    { id: "lookup", label: "功能速查", icon: Search, onSelect: showLookup },
  ];

  const activeTab: PrimaryTabId | null =
    mode === "blog" || mode === "guide" || mode === "lookup" ? mode : null;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTab);
    if (currentIndex === -1) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    tabs[nextIndex]?.onSelect();
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--z-modal) bg-black/35 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          ref={dialogRef}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const step =
              mode === "lookup" && effectiveTopicId && stepIndex
                ? detailRef.current?.querySelector<HTMLElement>(
                    `[data-tutorial-step="${stepIndex}"]`,
                  )
                : null;
            if (step) {
              step.scrollIntoView({ block: "start" });
              step.focus({ preventScroll: true });
              return;
            }
            dialogRef.current?.focus();
          }}
          className="tutorial-shell oc-surface-popover fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] top-[max(0.5rem,env(safe-area-inset-top))] z-(--z-modal) flex min-h-0 flex-col overflow-hidden rounded-xl bg-bg focus:outline-none data-[state=open]:animate-in sm:inset-x-4 sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:top-[max(1rem,env(safe-area-inset-top))] sm:rounded-xl2 lg:left-1/2 lg:w-[min(1200px,calc(100vw-2rem))] lg:-translate-x-1/2"
        >
          <header className="relative z-10 grid shrink-0 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2.5 border-b border-border bg-surface px-4 py-3 sm:px-5 lg:min-h-15 lg:grid-cols-[1fr_auto_1fr] lg:gap-y-0 lg:py-2">
            <div className="flex min-w-0 items-center">
              <Dialog.Title className="truncate text-section font-semibold tracking-tight text-fg sm:text-title">
                帮助与经验
              </Dialog.Title>
            </div>

            <div className="col-start-2 row-start-1 justify-self-end lg:col-start-3">
              <Dialog.Close asChild>
                <IconButton
                  aria-label="关闭帮助与经验"
                  variant="muted"
                  shape="square"
                  className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-9"
                >
                  <X size={18} />
                </IconButton>
              </Dialog.Close>
            </div>

            <div
              role="tablist"
              aria-label="帮助与经验导航"
              onKeyDown={handleTabKeyDown}
              className={cn(
                "oc-surface-recessed col-span-2 row-start-2 grid w-full items-center gap-1 rounded-xl p-1 sm:rounded-full lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:inline-grid lg:w-auto",
                tabs.length === 3 ? "grid-cols-3" : "grid-cols-2",
              )}
            >
              {tabs.map((tab, index) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(node) => {
                      tabRefs.current[index] = node;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={active || (activeTab === null && index === 0) ? 0 : -1}
                    onClick={tab.onSelect}
                    className={cn(
                      "oc-btn-tactile inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-meta font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:rounded-full sm:px-4",
                      active ? "oc-segmented-thumb text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    <Icon size={14} strokeWidth={1.8} aria-hidden className="hidden lg:inline-block" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </header>

          {/* relative: 让 main 成为所有 absolute 后代（含 sr-only 节点）的包含块，避免撑出 Dialog.Content 隐藏溢出。 */}
          <main ref={detailRef} className="tutorial-detail relative min-h-0 flex-1 overflow-y-auto bg-bg">
            {mode === "blog" ? (
              <CommunityBlog
                auth={auth}
                userId={userId}
                onRequireLogin={onRequireLogin}
                detailId={communityId}
                onDetailIdChange={onCommunityChange}
                request={blogRequest}
              />
            ) : mode === "guide" ? (
              <PracticalGuideView
                authenticated={caseActionLabel !== "登录后试用"}
                taskboardEnabled={taskboardEnabled}
                onTryScenario={handleTryScenario}
                onOpenTopic={(id) => handleSelectTopic(id)}
                onOpenQuickLookup={showLookup}
              />
            ) : mode === "lookup" ? (
              <QuickLookupView
                topicId={effectiveTopicId}
                stepNumber={stepIndex}
                taskboardEnabled={taskboardEnabled}
                onSelectTopic={handleSelectTopic}
                onRunAction={handleRunTopicAction}
                actionState={getTopicActionState}
                onOpenGuide={showGuide}
              />
            ) : mode === "legacy-work" && signatureWork ? (
              <LegacyDeepLinkViews
                kind="work"
                work={signatureWork}
                onBack={exitLegacyView}
                onRunCase={onRunCase}
                caseActionLabel={caseActionLabel}
              />
            ) : mode === "legacy-case" && caseId ? (
              <LegacyDeepLinkViews
                kind="case"
                caseId={caseId}
                onBack={exitLegacyView}
                onRunCase={onRunCase}
                caseActionLabel={caseActionLabel}
              />
            ) : mode === "legacy-community" && communityId ? (
              <LegacyDeepLinkViews
                kind="community"
                communityId={communityId}
                auth={auth}
                onRequireLogin={onRequireLogin}
                activeSessionId={activeSessionId}
                sessionMessages={sessionMessages}
                sending={sending}
                sessionTitle={sessionTitle}
                sessionProjectId={sessionProjectId}
                onCommunityChange={onCommunityChange}
              />
            ) : null}
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DEFAULT_TUTORIAL_TOPIC = PRODUCT_CAPABILITIES.chatBasics.id;

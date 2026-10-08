import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  Brain,
  Building2,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileInput,
  FileText as FileTextIcon,
  FileOutput,
  GitBranch,
  GraduationCap,
  History,
  Kanban,
  Image,
  Lightbulb,
  ListOrdered,
  type LucideIcon,
  Map,
  MessageCircle,
  MessageSquare,
  Mic,
  Monitor,
  Paperclip,
  Plug,
  Quote,
  Rocket,
  Route,
  Search,
  Settings,
  Sparkles,
  Store,
  Target,
  TestTube2,
  TriangleAlert,
  Trophy,
  Upload,
  Users,
  Wallet,
  Waypoints,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PRODUCT_CAPABILITIES,
  PRODUCT_CAPABILITY_LIST,
  PRODUCT_FEATURE_CATEGORIES,
  type ProductCapability,
  type ProductFeatureCategory,
  type ProductFeatureId,
  capabilityById,
} from "../lib/productCapabilities";
import type { TutorialActionState } from "../lib/tutorialActions";
import {
  TUTORIAL_CASES,
  TUTORIAL_CASE_BY_ID,
  type TutorialCase,
  type TutorialCaseCategory,
  type TutorialCaseId,
} from "../lib/tutorialCaseCatalog";
import {
  TUTORIAL_MEDIA,
  tutorialById,
} from "../lib/tutorialCatalog";
import {
  TUTORIAL_PENDING_CAPTURE_LABEL,
  TUTORIAL_QUICKSTART,
  TUTORIAL_SCENARIO_PATHS,
} from "../lib/tutorialJourneys";
import { SIGNATURE_WORKS, type SignatureWork } from "../lib/tutorialSignatureWorks";
import {
  markTutorialRead,
  readTutorialProgress,
  tutorialIsRead,
} from "../lib/tutorialProgress";
import { cn } from "../lib/utils";
import type { ChatMessage } from "../lib/chat/model";
import type { AuthSession } from "../lib/types";
import { CASE_PRESENTATION, CaseArtwork } from "./tutorials/CaseArtwork";
import { CommunityTutorials } from "./tutorials/CommunityTutorials";
import { CaseShowroom, ShowcaseDetail } from "./tutorials/CaseShowroom";
import { showcaseById } from "../lib/tutorialShowcase";
import { TutorialReplay } from "./tutorials/TutorialReplay";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "./ui";
import { HERO_SURFACE_CLASS } from "./tutorials/heroTheme";

/** 教程中心一级页签。`showcase` 是默认态;后两者可经 `?panel=help&tab=` 深链(TU-17)。 */
export type TutorialBrowseView = "showcase" | "start" | "cases";

const ICONS: Record<string, LucideIcon> = {
  message: MessageCircle,
  history: History,
  cpu: Cpu,
  paperclip: Paperclip,
  mic: Mic,
  search: Search,
  download: Download,
  image: Image,
  git: GitBranch,
  bot: Bot,
  users: Users,
  brain: Brain,
  clock: Clock3,
  sparkles: Sparkles,
  plug: Plug,
  store: Store,
  upload: Upload,
  bell: Bell,
  settings: Settings,
  wallet: Wallet,
  building: Building2,
  "message-square": MessageSquare,
  monitor: Monitor,
  kanban: Kanban,
  target: Target,
};

const CASE_CATEGORIES: readonly {
  id: TutorialCaseCategory;
  label: string;
  description: string;
}[] = [
  { id: "research", label: "科研", description: "检索、证据、数据分析与可复现交付" },
  { id: "coding", label: "编码", description: "真实仓库中的定位、修改、测试与审查" },
  { id: "general", label: "通用", description: "跨工具、长任务与日常工作流" },
];

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
      ...(item.fieldReport
        ? [
            item.fieldReport.sourceLabel,
            item.fieldReport.userScene,
            item.fieldReport.obstacle,
            item.fieldReport.input,
            item.fieldReport.duration,
            item.fieldReport.result,
            ...item.fieldReport.journey.flatMap((step) => [step.title, step.evidence]),
            ...item.fieldReport.metrics.flatMap((metric) => [metric.label, metric.value, metric.detail]),
            ...item.fieldReport.limitations,
          ]
        : []),
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
  onCaseChange = () => {},
  onShowCaseGallery = () => {},
  onCommunityChange = () => {},
  caseActionLabel,
  onRunCase,
  onClose,
  actionState,
  onRunAction,
  auth = null,
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
}: {
  open: boolean;
  topicId: ProductFeatureId | null;
  caseId?: TutorialCaseId | null;
  communityId?: string | null;
  onTopicChange: (id: ProductFeatureId) => void;
  onCaseChange?: (id: TutorialCaseId) => void;
  onShowCaseGallery?: () => void;
  onCommunityChange?: (id: string | null) => void;
  /**
   * 一级页签（案例展厅 / 快速上手 / 案例脚本）与精选作品详情的受控态（审计 TU-17 / TU-02 深链）：
   * App 把它们镜像到 `?panel=help&tab=` / `&work=`。不传则退回组件内部 state，ui-preview 与旧调用方零改动。
   */
  browseView?: TutorialBrowseView;
  onBrowseViewChange?: (view: TutorialBrowseView) => void;
  signatureWorkId?: SignatureWork["id"] | null;
  onSignatureWorkChange?: (id: SignatureWork["id"] | null) => void;
  /** 功能教程深链的目标步骤（`?step=`，1 起）：渲染后把该步滚到顶部并落焦点；越界 / 无 topic 时回到正文顶部。 */
  stepIndex?: number | null;
  caseActionLabel?: string;
  onRunCase?: (item: TutorialCase) => void;
  onClose: () => void;
  actionState: (feature: ProductCapability) => TutorialActionState;
  onRunAction: (feature: ProductCapability) => void;
  auth?: AuthSession | null;
  onRequireLogin?: () => void;
  activeSessionId?: string | null;
  sessionMessages?: ChatMessage[];
  sending?: boolean;
  sessionTitle?: string;
  sessionProjectId?: string | null;
}) {
  const [communityOpen, setCommunityOpen] = useState(!!communityId);
  // 页签与精选作品选中态:传了受控 prop 就以 prop 为准(App 镜像到 URL,TU-17),否则用内部 state。
  const [browseViewState, setBrowseViewState] = useState<TutorialBrowseView>("showcase");
  const browseView = browseViewProp ?? browseViewState;
  const setBrowseView = (view: TutorialBrowseView) => {
    if (browseViewProp === undefined) setBrowseViewState(view);
    onBrowseViewChange?.(view);
  };
  // 精选作品详情的选中态提到这里(审计 TU-02):放在 CaseShowroom 内部时,点导航「案例展厅」没有任何
  // state 变化、页面停在作品详情;现在 clearToBrowse 一并清掉,页签就能回到画廊。
  const [signatureWorkIdState, setSignatureWorkIdState] = useState<SignatureWork["id"] | null>(null);
  const signatureWorkId = signatureWorkIdProp === undefined ? signatureWorkIdState : signatureWorkIdProp;
  const setSignatureWorkId = (id: SignatureWork["id"] | null) => {
    if (signatureWorkIdProp === undefined) setSignatureWorkIdState(id);
    onSignatureWorkChange?.(id);
  };
  const mode =
    communityId || communityOpen
      ? "community"
      : topicId
        ? "features"
        : caseId
          ? "cases"
          : browseView;
  const selectedTopicId = topicId ?? PRODUCT_CAPABILITIES.chatBasics.id;
  // 记住最近看过的功能参考主题:点别的页签后 App 侧会把 topicId 清空,再点「功能参考」
  // 页签要回到上次那一篇而不是永远回到「对话入门」(审计 TU-01)。
  const lastTopicRef = useRef<ProductFeatureId>(selectedTopicId);
  useEffect(() => {
    if (topicId) lastTopicRef.current = topicId;
  }, [topicId]);
  const [query, setQuery] = useState("");
  const [featureCategory, setFeatureCategory] = useState<ProductFeatureCategory | "all">("all");
  const [progress, setProgress] = useState(() => readTutorialProgress());
  const [videoFailed, setVideoFailed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  // 切视图 / 切篇回到顶部;带 `?step=` 深链打开功能教程时改为把目标步骤滚到顶并落焦点(TU-17),
  // 键盘 / 读屏用户从链接进来直接停在那一步;越界的 step 找不到节点,自然回退到顶部。
  useEffect(() => {
    const container = detailRef.current;
    if (!container) return;
    const target =
      mode === "features" && stepIndex
        ? container.querySelector<HTMLElement>(`[data-tutorial-step="${stepIndex}"]`)
        : null;
    if (!target) {
      container.scrollTop = 0;
      return;
    }
    // 推后一拍:Radix 的开场自动聚焦在下一次提交才跑(onOpenAutoFocus 已处理开场;这里管的是
    // 打开后经 popstate / 站内链接换 step 的情况),同步 focus 会被它盖掉。
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mode, caseId, topicId, communityId, stepIndex]);

  const feature = capabilityById(selectedTopicId);
  const topic = tutorialById(selectedTopicId);
  const cta = actionState(feature);
  const selectedCase = caseId ? TUTORIAL_CASE_BY_ID[caseId] : null;
  const selectedShowcase = showcaseById(caseId);
  const signatureWork = signatureWorkId
    ? SIGNATURE_WORKS.find((work) => work.id === signatureWorkId) ?? null
    : null;

  const filteredFeatures = useMemo(
    () =>
      PRODUCT_CAPABILITY_LIST.filter(
        (item) =>
          (featureCategory === "all" || item.category === featureCategory) &&
          tutorialMatches(item, query),
      ),
    [featureCategory, query],
  );
  const mobileFeatureOptions = filteredFeatures.some((item) => item.id === selectedTopicId)
    ? filteredFeatures
    : [feature, ...filteredFeatures];
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFeatureCategory("all");
      setCommunityOpen(false);
      // 只重置内部 state:受控时由 App 在关闭 / 反灌时自己清,这里再回调会跟 URL 镜像打架。
      setBrowseViewState("showcase");
      setSignatureWorkIdState(null);
      return;
    }
    if (communityId) setCommunityOpen(true);
    if (!topicId) return;
    const timer = window.setTimeout(() => setProgress(markTutorialRead(topicId)), 900);
    return () => window.clearTimeout(timer);
  }, [open, topicId, communityId]);

  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyText = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  const clearToBrowse = (view: "showcase" | "start" | "cases") => {
    setQuery("");
    setCommunityOpen(false);
    setBrowseView(view);
    setSignatureWorkId(null);
    onCommunityChange(null);
    onShowCaseGallery();
  };

  const showShowroom = () => clearToBrowse("showcase");
  const showStart = () => clearToBrowse("start");
  const showCases = () => clearToBrowse("cases");
  // 「功能参考」页签(审计 TU-01):26 篇功能参考此前在导航里没有入口,只能从快速上手的链接绕进去。
  const showFeatures = () => {
    setQuery("");
    setCommunityOpen(false);
    setSignatureWorkId(null);
    onCommunityChange(null);
    onTopicChange(lastTopicRef.current);
  };

  const showCommunity = () => {
    setQuery("");
    setSignatureWorkId(null);
    setCommunityOpen(true);
  };

  const headerCopy =
    mode === "showcase" && signatureWork
      ? { title: signatureWork.title, subtitle: "精选作品 · 可交互 · 非完整会话回放" }
      : mode === "showcase" || (mode === "cases" && selectedShowcase)
        ? { title: "案例展厅", subtitle: "先看成果，再做一个你的版本" }
        : mode === "start"
          ? { title: "快速上手", subtitle: "大约 10 分钟，走完第一次任务" }
          : mode === "features"
            ? { title: "功能参考", subtitle: "按功能查找用法" }
            : mode === "cases"
              ? { title: "案例脚本", subtitle: "参考材料，不是已完成的案例" }
              : { title: "教程工作室", subtitle: "探索、手写或从当前会话生成可复用教程" };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          ref={dialogRef}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // 带 `?step=` 深链打开时焦点直接落到目标步骤(TU-17),否则落到对话框本体。
            const step =
              mode === "features" && stepIndex
                ? detailRef.current?.querySelector<HTMLElement>(`[data-tutorial-step="${stepIndex}"]`)
                : null;
            if (step) {
              step.scrollIntoView({ block: "start" });
              step.focus({ preventScroll: true });
              return;
            }
            dialogRef.current?.focus();
          }}
          className="tutorial-shell tut-shell fixed inset-x-2 bottom-2 top-2 z-50 flex min-h-0 flex-col overflow-hidden rounded-[22px] border border-border bg-bg shadow-float focus:outline-none data-[state=open]:animate-in sm:inset-x-4 sm:bottom-4 sm:top-4 sm:rounded-[28px] lg:left-1/2 lg:w-[min(1280px,calc(100vw-2rem))] lg:-translate-x-1/2"
        >
          {/* 一条统一的顶栏(OCV5-342 教程重构):标题 · 分段式页签 · 搜索 · 关闭。<lg 自动折成
              「标题+关闭 / 页签 / 搜索」三行;DOM 只有一份,读屏顺序与视觉一致。 */}
          <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border/80 bg-surface/80 px-3 py-3 backdrop-blur-xl sm:px-5 lg:min-h-[68px] lg:flex-nowrap lg:py-2.5">
            <div className="order-1 flex min-w-0 flex-1 items-center gap-3 lg:w-[248px] lg:flex-none">
              <span className={cn("tut-mark flex size-10 shrink-0 items-center justify-center rounded-[14px] text-white", mode === "cases" ? "bg-accent" : "bg-grad-cta")}>
                <GraduationCap size={19} />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="truncate text-[16px] font-semibold tracking-tight text-fg sm:text-[17px]">
                  {headerCopy.title}
                </Dialog.Title>
                <p className="hidden truncate text-caption text-faint sm:block">
                  {headerCopy.subtitle}
                </p>
              </div>
            </div>

            <nav aria-label="案例与帮助" className="order-3 flex min-w-0 basis-full items-center justify-between gap-2 lg:order-2 lg:basis-auto lg:flex-1 lg:justify-start">
              <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full border border-border/70 bg-hover p-1">
                <ViewTab active={mode === "showcase" || (mode === "cases" && Boolean(selectedShowcase))} onClick={showShowroom} icon={Sparkles}>
                  案例展厅
                </ViewTab>
                <ViewTab active={mode === "start"} onClick={showStart} icon={Rocket}>
                  快速上手
                </ViewTab>
                <ViewTab active={mode === "features"} onClick={showFeatures} icon={BookOpen}>
                  功能参考
                </ViewTab>
              </div>
              {/* 「帮助与创作」走 DropdownMenu 原语(审计 TU-03):原生 <details> 没有外点 / Esc 关闭,
                  也没有 menu 语义与方向键;Radix 版本这些都自带,与全站其它下拉一致。 */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" shape="pill" className="shrink-0 text-muted hover:text-fg">
                    帮助与创作 <ChevronDown size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <HelpMenuItem active={mode === "community"} onSelect={showCommunity} icon={Waypoints}>
                    教程工作室
                  </HelpMenuItem>
                  <HelpMenuItem active={mode === "cases" && !selectedShowcase} onSelect={showCases} icon={FileTextIcon}>
                    案例脚本
                  </HelpMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </nav>

            {mode === "features" && (
              // 搜索框只有一份 DOM:桌面端与页签同行,<lg 折成 header 的最后一行占满宽度,
              // 窄屏标题不再被它挤成一列(审计 TU-01 / TU-04)。
              <TutorialSearch
                query={query}
                onQueryChange={setQuery}
                className="order-4 basis-full lg:order-3 lg:w-72 lg:basis-auto lg:flex-none"
              />
            )}
            <Dialog.Close asChild>
              <IconButton aria-label="关闭教程" variant="muted" shape="square" className="order-2 shrink-0 lg:order-4">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </header>

          {mode === "features" && (
            <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-2 lg:hidden">
              <CategoryChip active={featureCategory === "all"} onClick={() => setFeatureCategory("all")}>
                全部
              </CategoryChip>
              {PRODUCT_FEATURE_CATEGORIES.map((item) => (
                <CategoryChip
                  key={item.id}
                  active={featureCategory === item.id}
                  onClick={() => setFeatureCategory(item.id)}
                >
                  {item.label}
                </CategoryChip>
              ))}
            </div>
          )}

          <div className="flex min-h-0 flex-1">
            {mode === "features" && (
              <FeatureSidebar
                items={filteredFeatures}
                activeId={selectedTopicId}
                category={featureCategory}
                progress={progress}
                onCategoryChange={setFeatureCategory}
                onSelect={onTopicChange}
              />
            )}

            <div className="flex min-w-0 flex-1 flex-col bg-bg">
              {mode === "features" && (
                <div className="border-b border-border bg-surface px-3 py-2 lg:hidden">
                  {hasQuery ? (
                    // <lg 有搜索词时,把命中结果直接列出来(审计 TU-04):此前唯一的输出是 <select> 的
                    // option 列表,命中 2 条或 0 条页面都看不出任何变化,「没有匹配教程」分支也永不触发。
                    <nav aria-label="搜索结果" className="flex flex-col gap-1">
                      {filteredFeatures.length > 0 && (
                        // <output>（隐含 role=status）而非 p[role=status]：跟随仓内 ListSkeleton 的写法。
                        <output className="block px-1 text-caption text-faint">
                          {filteredFeatures.length} 篇匹配「{query.trim()}」
                        </output>
                      )}
                      <TopicList
                        items={filteredFeatures}
                        activeId={selectedTopicId}
                        isRead={(id) => tutorialIsRead(progress, id)}
                        onSelect={(id) => {
                          setQuery("");
                          onTopicChange(id);
                        }}
                      />
                    </nav>
                  ) : (
                    <>
                      <select
                        aria-label="选择教程"
                        value={selectedTopicId}
                        onChange={(event) => onTopicChange(event.target.value as ProductFeatureId)}
                        className="h-11 w-full rounded-lg border border-border bg-bg px-3 text-base text-fg outline-none focus:ring-2 focus:ring-ring md:text-body"
                      >
                        {mobileFeatureOptions.map((item) => (
                          <option key={item.id} value={item.id}>{item.shortTitle}</option>
                        ))}
                      </select>
                      {featureCategory !== "all" && (
                        <output className="mt-1.5 block px-1 text-caption text-faint">
                          {filteredFeatures.length > 0
                            ? `「${featureCategoryLabel(featureCategory)}」下共 ${filteredFeatures.length} 篇`
                            : `「${featureCategoryLabel(featureCategory)}」下没有教程，换个分类试试。`}
                        </output>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* relative:让 main 成为所有 absolute 后代(含 sr-only 播报节点)的包含块,否则它们逃到
                  Dialog.Content 上把 overflow-hidden 的对话框撑出隐藏溢出,scrollIntoView 会把 header
                  顶出视口(审计 TU-23)。 */}
              <main ref={detailRef} className="tutorial-detail relative min-h-0 flex-1 overflow-y-auto">
                {mode === "community" ? (
                  <CommunityTutorials
                    auth={auth}
                    onRequireLogin={onRequireLogin}
                    activeSessionId={activeSessionId}
                    sessionMessages={sessionMessages}
                    sending={sending}
                    sessionTitle={sessionTitle}
                    sessionProjectId={sessionProjectId}
                    initialDetailId={communityId}
                    onDetailIdChange={onCommunityChange}
                  />
                ) : mode === "showcase" ? (
                  <CaseShowroom
                    onSelect={onCaseChange}
                    onRun={onRunCase}
                    actionLabel={caseActionLabel}
                    activeWorkId={signatureWorkId}
                    onActiveWorkChange={setSignatureWorkId}
                  />
                ) : mode === "start" ? (
                  <QuickstartView onOpenTopic={onTopicChange} progress={progress} />
                ) : mode === "cases" ? (
                  selectedShowcase ? (
                    <ShowcaseDetail key={selectedShowcase.caseId} item={selectedShowcase} onBack={showShowroom} onRun={onRunCase} actionLabel={caseActionLabel} />
                  ) : selectedCase ? (
                    <CaseDetail
                      item={selectedCase}
                      copied={copied}
                      onCopy={() => copyText(selectedCase.starterPrompt)}
                      onBack={showCases}
                      actionLabel={caseActionLabel}
                      onRun={onRunCase}
                    />
                  ) : (
                    <CaseGallery items={TUTORIAL_CASES} onSelect={onCaseChange} />
                  )
                ) : (
                  <FeatureDetail
                    feature={feature}
                    topicId={selectedTopicId}
                    stepIndex={stepIndex}
                    progress={progress}
                    videoFailed={videoFailed}
                    onVideoFailed={(key) => setVideoFailed((current) => ({ ...current, [key]: true }))}
                    copied={copied}
                    onCopy={() => topic.example && copyText(topic.example)}
                    cta={cta}
                    onRunAction={onRunAction}
                    onTopicChange={onTopicChange}
                  />
                )}
              </main>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // 页签用 aria-current 表达「当前所在」,而不是把它当成开关按钮播报(审计 TU-24);
      // 触屏下补到 44px 命中高(审计 TU-11),桌面态零变化。
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-meta font-semibold outline-none transition-[background-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5 [@media(hover:none)]:min-h-11",
        active ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--border)]" : "text-muted hover:text-fg",
      )}
    >
      {/* 390px 下三个页签 + 「帮助与创作」放不下带图标的版本，第三个会被裁掉一半；窄屏只留文字。 */}
      <Icon size={14} className="max-sm:hidden" /> {children}
    </button>
  );
}

function HelpMenuItem({
  active,
  onSelect,
  icon: Icon,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn("text-meta font-medium [@media(hover:none)]:min-h-11", active ? "text-fg" : "text-muted")}
    >
      <Icon size={14} className={active ? "text-accent" : "text-faint"} />
      <span className="flex-1">{children}</span>
      {active && <Check size={14} className="text-accent" aria-hidden />}
    </DropdownMenuItem>
  );
}

function TutorialSearch({
  query,
  onQueryChange,
  className,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={cn("flex h-10 min-w-0 items-center gap-2 rounded-xl bg-hover px-3 focus-within:ring-2 focus-within:ring-ring lg:h-9", className)}>
      <Search size={15} className="shrink-0 text-faint" />
      <span className="sr-only">搜索教程</span>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索功能、场景或关键词"
        // 16px 起步:iOS Safari 对 <16px 的输入框聚焦时会放大整页(审计 TU-33);md 起回到正文档位。
        className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-body"
      />
    </label>
  );
}

function PendingCaptureBadge() {
  return (
    <span className="rounded-full bg-warning-soft px-2.5 py-1 text-caption font-semibold text-warning">
      {TUTORIAL_PENDING_CAPTURE_LABEL}
    </span>
  );
}

/** 进度环:纯 SVG,读屏读旁边的文字,不读它。 */
function ProgressRing({ value, total }: { value: number; total: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? value / total : 0;
  return (
    <span aria-hidden="true" className="relative grid size-[72px] shrink-0 place-items-center">
    <svg aria-hidden="true" viewBox="0 0 64 64" className="absolute inset-0 size-full -rotate-90">
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-border" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - ratio)}
        className="stroke-accent transition-[stroke-dashoffset] duration-700 ease-standard"
      />
    </svg>
    <span className="text-meta font-semibold tabular-nums text-fg">{Math.round(ratio * 100)}%</span>
    </span>
  );
}

function QuickstartView({
  onOpenTopic,
  progress,
}: {
  onOpenTopic: (id: ProductFeatureId) => void;
  progress: ReturnType<typeof readTutorialProgress>;
}) {
  const steps = TUTORIAL_QUICKSTART.steps;
  const doneCount = steps.filter((step) => tutorialIsRead(progress, step.topicId)).length;
  const nextIndex = steps.findIndex((step) => !tutorialIsRead(progress, step.topicId));
  const allDone = nextIndex === -1;
  return (
    <section className="mx-auto max-w-4xl px-4 pb-14 pt-6 sm:px-8 sm:pt-9">
      {/* 进度 hero:一眼看到「走到哪了、下一步做什么」(OCV5-342 教程重构)。 */}
      <div className="tut-hero relative overflow-hidden rounded-[24px] border border-border p-5 sm:rounded-[28px] sm:p-9">
        <div className="relative flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
          <div className="max-w-xl">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-surface/70 px-3 py-1 text-caption font-semibold text-accent backdrop-blur">
              <Clock3 size={12} aria-hidden /> 约 {TUTORIAL_QUICKSTART.estimatedMinutes} 分钟 · {steps.length} 步
            </p>
            <h1 className="mt-4 text-balance text-[28px] font-bold leading-[1.12] tracking-[-0.03em] text-fg sm:text-[40px]">
              {TUTORIAL_QUICKSTART.title}
            </h1>
            <p className="mt-3 text-[15px] leading-7 text-muted">{TUTORIAL_QUICKSTART.summary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-4 rounded-2xl border border-border bg-surface/80 p-4 shadow-soft backdrop-blur md:w-[300px]">
            <ProgressRing value={doneCount} total={steps.length} />
            <div className="min-w-0">
              <p className="text-caption text-faint">学习进度</p>
              <p className="mt-0.5 text-[20px] font-semibold tabular-nums text-fg">
                {doneCount}
                <span className="text-[14px] font-medium text-faint"> / {steps.length}</span>
              </p>
              {allDone ? (
                <p className="mt-1 inline-flex items-center gap-1 text-caption font-medium text-success">
                  <Trophy size={12} aria-hidden /> 主线已走完
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenTopic(steps[nextIndex].topicId)}
                  className="mt-1 inline-flex items-center gap-1 rounded-md text-caption font-semibold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                >
                  {doneCount === 0 ? "从第 1 步开始" : `继续第 ${nextIndex + 1} 步`}
                  <ArrowRight size={12} aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ol className="relative mt-10 flex flex-col gap-4">
        {/* 时间线导轨:连接各步骤节点,纯装饰。 */}
        <span aria-hidden className="tut-rail absolute bottom-6 left-[19px] top-6 w-px sm:left-[23px]" />
        {steps.map((step, index) => {
          const feature = capabilityById(step.topicId);
          const FeatureGlyph = ICONS[feature.icon] ?? Sparkles;
          const done = tutorialIsRead(progress, step.topicId);
          const isNext = index === nextIndex;
          return (
            <li key={step.id} className="relative flex gap-4 sm:gap-5">
              {/* 步骤对应的教程已读就打勾,不再六步永远一个样(审计 TU-19)。 */}
              <span
                className={cn(
                  "relative z-10 mt-4 flex size-10 shrink-0 items-center justify-center rounded-full text-meta font-semibold ring-4 ring-bg sm:size-12 sm:text-body",
                  done
                    ? "bg-success text-white"
                    : isNext
                      ? "bg-grad-cta text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
                      : "border border-border bg-surface text-muted",
                )}
                aria-label={done ? `第 ${index + 1} 步，已读` : `第 ${index + 1} 步`}
              >
                {done ? <Check size={16} aria-hidden /> : index + 1}
              </span>
              <div
                className={cn(
                  "min-w-0 flex-1 rounded-[20px] border bg-surface p-4 shadow-sm transition-[border-color,box-shadow] sm:p-5",
                  isNext ? "border-accent/35 shadow-soft" : "border-border",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-micro font-semibold uppercase tracking-[0.16em] text-faint">
                      Step {String(index + 1).padStart(2, "0")}
                      {isNext && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 font-sans tracking-normal text-accent normal-case">下一步</span>}
                    </p>
                    <h2 className="mt-1.5 text-[16px] font-semibold leading-snug text-fg sm:text-[17px]">{step.title}</h2>
                  </div>
                  <span aria-hidden className="hidden size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent sm:flex">
                    <FeatureGlyph size={16} />
                  </span>
                </div>
                <p className="mt-2 text-[13.5px] leading-6 text-muted">{step.body}</p>
                <button
                  type="button"
                  onClick={() => onOpenTopic(step.topicId)}
                  aria-label={`打开步骤：${step.title}`}
                  className="mt-3.5 inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1.5 text-meta font-semibold text-fg outline-none transition-colors hover:border-accent/40 hover:text-accent focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                >
                  查看「{feature.shortTitle}」
                  <ArrowRight size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {/* 5 条「按场景学习」路径此前只有数据和测试、没有渲染(审计 TU-14),在主线之后兑现。 */}
      <section className="mt-14" aria-labelledby="scenario-paths-title">
        <p className="inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-[0.14em] text-accent">
          <Route size={12} aria-hidden /> 按场景学习
        </p>
        <h2 id="scenario-paths-title" className="mt-2 text-[21px] font-semibold tracking-tight text-fg sm:text-[26px]">
          走完主线后，挑一条和你工作最像的路
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {TUTORIAL_SCENARIO_PATHS.map((path) => {
            const read = path.topicIds.filter((topicId) => tutorialIsRead(progress, topicId)).length;
            return (
              <article key={path.id} className="tut-card group rounded-[22px] border border-border bg-surface p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[16px] font-semibold text-fg">{path.title}</h3>
                  <span className="shrink-0 rounded-full bg-hover px-2.5 py-0.5 text-caption tabular-nums text-faint">
                    {read}/{path.topicIds.length}
                  </span>
                </div>
                <p className="mt-1.5 text-caption leading-5 text-muted">{path.description}</p>
                <div aria-hidden className="mt-3 h-1 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(read / Math.max(1, path.topicIds.length)) * 100}%` }} />
                </div>
                <ol className="mt-3 flex flex-col gap-0.5">
                  {path.topicIds.map((topicId, index) => {
                    const step = capabilityById(topicId);
                    return (
                      <li key={topicId}>
                        <button
                          type="button"
                          onClick={() => onOpenTopic(topicId)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-meta text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-micro tabular-nums text-faint">{index + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{step.shortTitle}</span>
                          {tutorialIsRead(progress, topicId) && (
                            <Check size={13} className="shrink-0 text-success" aria-label="已读" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function CaseGallery({
  items,
  onSelect,
}: {
  items: readonly TutorialCase[];
  onSelect: (id: TutorialCaseId) => void;
}) {
  // 分类 + 搜索(审计 TU-15):此前 12 张全高卡片一列到底,找案例只能滚;`tutorialCaseMatches`
  // 早已写好却没有渲染路径,这里接上。
  const [category, setCategory] = useState<TutorialCaseCategory | "all">("all");
  const [query, setQuery] = useState("");
  const visible = items.filter(
    (item) => (category === "all" || item.category === category) && tutorialCaseMatches(item, query),
  );
  const filtering = category !== "all" || query.trim().length > 0;
  return (
    <section className="mx-auto max-w-5xl px-3 pb-12 pt-4 sm:px-7 sm:pt-7">
      <div className={cn("overflow-hidden rounded-3xl px-5 py-6 sm:px-8 sm:py-8", HERO_SURFACE_CLASS)} data-tutorial-hero="cases">
        <p className="text-micro font-semibold uppercase tracking-[0.16em] text-cyan-200">
          案例脚本
        </p>
        {/* 「待采集」是采集流水线的内部词,用户看不懂;口径改成人话,且同屏只说一次(审计 TU-10)。 */}
        <h1 className="mt-2 max-w-2xl text-balance text-[25px] font-bold leading-tight tracking-tight sm:text-[34px]">
          这些是任务脚本，还没有真实运行记录
        </h1>
        <p className="mt-3 max-w-2xl text-[13px] leading-6 text-white/72 sm:text-[14px]">
          步骤和材料已经写好，但还没有真实运行回放。记录补齐前，只把它们当参考，不当成品。
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-micro font-medium text-white/85 sm:text-caption">
          <span className="rounded-full bg-white/10 px-3 py-1.5">{items.length} 条脚本</span>
          <span className="rounded-full bg-white/10 px-3 py-1.5">科研 / 编码 / 通用</span>
        </div>
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <fieldset className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto border-0 p-0" aria-label="案例分类">
          <CategoryChip active={category === "all"} onClick={() => setCategory("all")}>
            全部
          </CategoryChip>
          {CASE_CATEGORIES.map((item) => (
            <CategoryChip key={item.id} active={category === item.id} onClick={() => setCategory(item.id)}>
              {item.label}
            </CategoryChip>
          ))}
        </fieldset>
        <label className="flex h-10 min-w-0 items-center gap-2 rounded-xl bg-hover px-3 focus-within:ring-2 focus-within:ring-ring sm:w-64 lg:h-9">
          <Search size={15} className="shrink-0 text-faint" />
          <span className="sr-only">搜索案例</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索案例"
            className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-body"
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <output className="mt-7 block rounded-2xl border border-dashed border-border px-5 py-12 text-center text-section text-faint">
          没有匹配案例，试试“文献”“引用”“回归测试”或清空筛选。
        </output>
      ) : (
        <section className="mt-6" aria-labelledby="case-template-title">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2
              id="case-template-title"
              className="text-[19px] font-semibold tracking-tight text-fg sm:text-[22px]"
            >
              {filtering ? "匹配的案例脚本" : "全部案例脚本"}
            </h2>
            <output className="text-caption text-faint">
              {visible.length} / {items.length} 条
            </output>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {visible.map((item) => (
              <CaseGalleryCard
                key={item.id}
                item={item}
                onSelect={onSelect}
                featured={Boolean(item.fieldReport) && item.replay.status !== "pending_capture"}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function CaseGalleryCard({
  item,
  onSelect,
  featured = false,
}: {
  item: TutorialCase;
  onSelect: (id: TutorialCaseId) => void;
  featured?: boolean;
}) {
  const presentation = CASE_PRESENTATION[item.id];
  const report = item.fieldReport;
  const storyLabel =
    item.category === "research"
      ? "科研实战"
      : item.category === "coding"
        ? "编码实战"
        : "工作实战";
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-label={
        item.replay.status === "pending_capture"
          ? `${TUTORIAL_PENDING_CAPTURE_LABEL}：${item.title}`
          : `${storyLabel}：${presentation.pain} ${item.title}。完成后得到${presentation.result}。看它怎么完成`
      }
      className={cn(
        "group overflow-hidden rounded-3xl border bg-surface text-left shadow-sm outline-none transition-[border-color,box-shadow,transform] hover:-translate-y-1 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring",
        featured
          ? "border-accent/30 hover:border-accent/55"
          : "border-border hover:border-accent/40",
      )}
    >
      <CaseArtwork caseId={item.id} fieldReport={report} pendingCapture={item.replay.status === "pending_capture"} />
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {item.replay.status === "pending_capture" && <PendingCaptureBadge />}
          <span className="rounded-full bg-accent-soft px-2.5 py-1 text-micro font-semibold text-accent">
            {report
              ? `${storyLabel} · 案例脚本`
              : `${caseCategoryLabel(item.category)} · ${item.difficulty}`}
          </span>
          {!report &&
            item.artifacts.slice(0, 2).map((artifact) => (
              <span
                key={artifact.title}
                className="rounded-full bg-hover px-2 py-1 text-micro text-faint"
              >
                {artifact.format}
              </span>
            ))}
        </div>
        <p className="mt-3 text-[13px] font-semibold leading-5 text-accent">
          {presentation.pain}
        </p>
        <h3 className="mt-1.5 text-[18px] font-semibold leading-6 text-fg">
          {item.title}
        </h3>
        {report && item.replay.status !== "pending_capture" ? (
          <ul className="mt-4 grid grid-cols-3 gap-2" aria-label="案例结果">
            {report.metrics.map((metric) => (
              <li
                key={metric.label}
                className="rounded-xl bg-sidebar px-2 py-2.5 text-center"
              >
                <strong className="block text-title font-bold text-fg">
                  {metric.value}
                </strong>
                <span className="mt-1 block text-caption leading-4 text-faint">
                  {metric.label}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 line-clamp-2 text-[12.5px] leading-5 text-muted">
            {presentation.result}
          </p>
        )}
        <span className="mt-4 inline-flex items-center gap-1.5 text-meta font-semibold text-fg transition-colors group-hover:text-accent">
          {item.replay.status === "pending_capture" ? "查看任务脚本" : "看它怎么完成"}
          <ArrowRight
            size={14}
            className="transition-transform group-hover:translate-x-1"
          />
        </span>
      </div>
    </button>
  );
}

function CaseDetail({
  item,
  copied,
  onCopy,
  onBack,
  actionLabel,
  onRun,
}: {
  item: TutorialCase;
  copied: boolean;
  onCopy: () => void;
  onBack: () => void;
  actionLabel?: string;
  onRun?: (item: TutorialCase) => void;
}) {
  const presentation = CASE_PRESENTATION[item.id];
  const storyLabel =
    item.category === "research"
      ? "科研实战"
      : item.category === "coding"
        ? "编码实战"
        : "工作实战";
  return (
    <article
      className="mx-auto max-w-4xl px-3 pb-14 pt-3 sm:px-7 sm:pt-5"
      data-case-id={item.id}
    >
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted hover:text-fg">
        <ArrowLeft size={14} /> 返回案例列表
      </Button>

      {/* 详情页的「尚无真实运行记录」只在这条横幅说一次;卡头徽章与回放区不再重复(审计 TU-10)。 */}
      {item.replay.status === "pending_capture" && (
        <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-meta font-medium text-warning">
          {TUTORIAL_PENDING_CAPTURE_LABEL}。下面是人工编写的任务脚本与观察记录，不是平台验证过的运行回放。
        </p>
      )}

      <section className="mt-3 overflow-hidden rounded-3xl border border-border bg-surface shadow-sm md:grid md:grid-cols-[1.02fr_.98fr]">
        <CaseArtwork
          caseId={item.id}
          fieldReport={item.fieldReport}
          pendingCapture={item.replay.status === "pending_capture"}
          className="order-2 md:order-1 md:h-full md:min-h-[340px] md:aspect-auto"
        />
        <div className="order-1 flex flex-col p-4 sm:p-6 md:order-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-micro font-semibold text-accent">
              {storyLabel} · 案例脚本
            </span>
            <span className="rounded-full bg-hover px-2.5 py-1 text-micro text-muted">
              {item.difficulty}
            </span>
          </div>
          <p className="mt-3 text-[12.5px] font-semibold leading-5 text-accent">
            {presentation.pain}
          </p>
          <h1 className="mt-1 text-balance text-[23px] font-bold leading-[1.18] tracking-tight text-fg sm:text-[30px]">
            {item.title}
          </h1>
          <div className="mt-3 rounded-2xl bg-accent-soft p-3 sm:p-3.5">
            <p className="text-micro font-semibold uppercase tracking-[0.12em] text-accent">
              最后你会拿到
            </p>
            <p className="mt-1 text-[13px] font-semibold leading-5 text-fg">
              {presentation.result}
            </p>
          </div>
          {onRun && (
            <div className="mt-4">
              <Button
                variant="primary"
                onClick={() => onRun(item)}
                aria-label={
                  actionLabel
                    ? `带着我的材料开始，${actionLabel}`
                    : "带着我的材料开始"
                }
                className="w-full justify-center sm:w-auto"
              >
                带着我的材料开始 <ArrowRight size={15} />
              </Button>
              <p className="mt-2 text-caption leading-4 text-faint">
                {actionLabel === "登录后试用"
                  ? "登录后会自动带入这套任务方法"
                  : "会新建对话，并带入可修改的开工指令"}
              </p>
            </div>
          )}
        </div>
      </section>

      <StoryOverview item={item} />
      <ArtifactShowcase key={item.id} item={item} />

      <section className="mt-10" aria-labelledby="case-process-title">
        <p className="text-micro font-semibold uppercase tracking-[0.14em] text-accent">
          过程看得见
        </p>
        <h2
          id="case-process-title"
          className="mt-1 text-[21px] font-semibold tracking-tight text-fg"
        >
          它实际怎样推进
        </h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {item.stages.map((stage, index) => (
            <article
              key={stage.id}
              className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-grad-cta text-meta font-bold text-white">
                  {index + 1}
                </span>
                <h3 className="text-title font-semibold text-fg">
                  {stage.title}
                </h3>
              </div>
              <p className="mt-3 rounded-xl bg-accent-soft p-3 text-[12px] font-medium leading-5 text-fg">
                {stage.output}
              </p>
              <div
                className="mt-3 flex flex-wrap gap-1.5"
                aria-label={`${stage.title}的可见过程`}
              >
                {stage.visibleProcess.map((process) => (
                  <span
                    key={process}
                    className="rounded-full border border-border bg-bg px-2.5 py-1 text-micro text-muted"
                  >
                    {process}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <CaseMethodDetails item={item} copied={copied} onCopy={onCopy} />

      {onRun && (
        <section className={cn("mt-10 rounded-3xl px-5 py-6 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:px-7", HERO_SURFACE_CLASS)} data-tutorial-hero="case-cta">
          <div>
            <p className="text-micro font-semibold uppercase tracking-[0.14em] text-cyan-200">
              轮到你的任务
            </p>
            <h2 className="mt-1 text-[20px] font-semibold">
              不用照抄案例，换成你的材料就能开始
            </h2>
          </div>
          <Button
            variant="primary"
            onClick={() => onRun(item)}
            className="mt-4 w-full justify-center sm:mt-0 sm:w-auto sm:shrink-0"
          >
            带着我的材料开始 <ArrowRight size={15} />
          </Button>
        </section>
      )}
    </article>
  );
}

function StoryOverview({ item }: { item: TutorialCase }) {
  const acts = [
    {
      title: "交给 V5",
      icon: FileInput,
      body: item.inputMaterials.slice(0, 2).map((input) => input.title),
      note: `${item.inputMaterials.length} 类材料`,
    },
    {
      title: "看它工作",
      icon: Sparkles,
      body: item.stages.slice(0, 3).map((stage) => stage.title),
      note: `${item.stages.length} 个关键阶段`,
    },
    {
      title: "拿走成果",
      icon: FileOutput,
      body: item.artifacts.slice(0, 3).map((artifact) => artifact.title),
      note: `${item.artifacts.length} 份可交付文件`,
    },
  ] as const;
  return (
    <section className="mt-9" aria-labelledby="story-overview-title">
      <p className="text-micro font-semibold uppercase tracking-[0.14em] text-accent">
        一眼看懂
      </p>
      <h2
        id="story-overview-title"
        className="mt-1 text-[21px] font-semibold tracking-tight text-fg"
      >
        从材料到成果，只看这三步
      </h2>
      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        {acts.map((act, index) => {
          const Icon = act.icon;
          return (
            <li
              key={act.title}
              className="relative rounded-2xl border border-border bg-surface p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <Icon size={18} />
                </span>
                <span className="text-micro font-semibold text-faint">
                  0{index + 1}
                </span>
              </div>
              <h3 className="mt-3 text-title font-semibold text-fg">
                {act.title}
              </h3>
              <ul className="mt-2 space-y-1.5">
                {act.body.map((line) => (
                  <li
                    key={line}
                    className="flex gap-2 text-meta leading-5 text-muted"
                  >
                    <Check size={12} className="mt-1 shrink-0 text-success" />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-micro font-medium text-accent">
                {act.note}
              </p>
              {index < acts.length - 1 && (
                <ArrowRight
                  aria-hidden
                  className="absolute -right-5 top-1/2 z-10 hidden -translate-y-1/2 text-faint md:block"
                  size={18}
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ArtifactShowcase({ item }: { item: TutorialCase }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const artifact = item.artifacts[selectedIndex];
  return (
    <section className="mt-10" aria-labelledby="artifact-showcase-title">
      <p className="text-micro font-semibold uppercase tracking-[0.14em] text-accent">
        先看成品
      </p>
      {/* 预览区是装饰性示意,不是本案例真实产物,标题与图区都要说清(审计 TU-16)。 */}
      <h2
        id="artifact-showcase-title"
        className="mt-1 text-[21px] font-semibold tracking-tight text-fg"
      >
        你会拿到这些成果
      </h2>
      <div className="mt-5 overflow-hidden rounded-3xl border border-border bg-surface shadow-sm lg:grid lg:grid-cols-[1.35fr_.65fr]">
        <ArtifactPreview item={item} artifactIndex={selectedIndex} />
        <div className="border-t border-border p-3 lg:border-l lg:border-t-0 lg:p-4">
          <p className="px-1 pb-2 text-micro font-semibold text-faint">
            点击查看成果
          </p>
          <div className="grid gap-2">
            {item.artifacts.map((entry, index) => (
              <button
                key={entry.title}
                type="button"
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                className={cn(
                  "rounded-xl border px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  selectedIndex === index
                    ? "border-accent/40 bg-accent-soft"
                    : "border-transparent bg-sidebar hover:border-border hover:bg-hover",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-meta font-semibold text-fg">
                    {entry.title}
                  </strong>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-caption text-faint">
                    {entry.format}
                  </span>
                </span>
                <span className="mt-1 block text-caption leading-4 text-muted">
                  {entry.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        当前预览：{artifact.title}
      </p>
    </section>
  );
}

function ArtifactPreview({
  item,
  artifactIndex,
}: {
  item: TutorialCase;
  artifactIndex: number;
}) {
  const artifact = item.artifacts[artifactIndex];
  return (
    <div
      role="img"
      aria-label={`示意：${artifact.title}，${artifact.description}。这是成果类型的示意图，不是本案例的实际产物`}
      className={cn("relative min-h-[260px] overflow-hidden p-4 sm:min-h-[330px] sm:p-6", HERO_SURFACE_CLASS)}
      data-tutorial-hero="artifact"
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-rose-400" />
          <span className="size-2.5 rounded-full bg-amber-300" />
          <span className="size-2.5 rounded-full bg-emerald-400" />
        </div>
        <div className="flex items-center gap-2">
          {/* 假终端 / 写死柱状图曾被当成真图播报,这里明示「示意」(审计 TU-16)。 */}
          <span className="rounded-full border border-amber-300/40 bg-amber-300/15 px-2.5 py-1 text-micro font-medium text-amber-100">
            示意图 · 非本案例实际产物
          </span>
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-micro font-medium text-white/70">
            {artifact.format}
          </span>
        </div>
      </div>
      <div className="mt-4 grid min-h-[190px] gap-3 sm:mt-6 sm:grid-cols-[.72fr_1.28fr]">
        <div className="rounded-2xl bg-white/[0.07] p-4">
          <FileOutput size={18} className="text-cyan-200" />
          <p className="mt-3 text-[15px] font-semibold leading-5">
            {artifact.title}
          </p>
          <p className="mt-2 text-caption leading-5 text-white/58">
            {artifact.description}
          </p>
        </div>
        {item.category === "coding" ? (
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4 font-mono text-micro leading-5 sm:text-caption">
            <p className="text-white/35">$ 复现 → 定位 → 修复 → 回归</p>
            <p className="mt-2 rounded bg-rose-400/10 px-2 py-1 text-rose-200">
              − 先让失败可以稳定复现
            </p>
            <p className="mt-1 rounded bg-emerald-400/10 px-2 py-1 text-emerald-200">
              + 再交付最小修改与测试
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 font-sans">
              <span className="rounded-xl bg-white/[0.06] p-3 text-center text-white/70">
                {artifact.format}
              </span>
              <span className="rounded-xl bg-emerald-400/15 p-3 text-center font-semibold text-emerald-200">
                {item.checks.length} 项验收
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex h-28 items-end gap-2 border-b border-white/10 pb-2" aria-hidden>
              {[42, 68, 54, 88, 72, 96, 78].map((height) => (
                <span
                  key={height}
                  className="flex-1 rounded-t bg-gradient-to-t from-cyan-500/55 to-emerald-300"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {item.artifacts.slice(0, 3).map((entry) => (
                <span
                  key={entry.title}
                  className="rounded-xl bg-white/[0.06] p-2 text-center text-micro text-white/60"
                >
                  {entry.format}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CaseMethodDetails({
  item,
  copied,
  onCopy,
}: {
  item: TutorialCase;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <details className="group mt-10 overflow-hidden rounded-3xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6 sm:py-5">
        <div>
          <p className="text-title font-semibold text-fg">案例资料与方法</p>
          <p className="mt-1 text-caption leading-4 text-faint">
            材料来源、完整指令、执行细节、验收方法与边界说明
          </p>
        </div>
        <ChevronDown
          size={17}
          className="shrink-0 text-faint transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="space-y-8 border-t border-border px-4 py-5 sm:px-6 sm:py-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-sidebar p-4 sm:col-span-2">
            <h3 className="text-caption font-semibold text-faint">案例说明</h3>
            <p className="mt-1.5 text-caption leading-5 text-muted">{item.summary}</p>
          </div>
          <div className="rounded-2xl bg-sidebar p-4">
            <h3 className="text-caption font-semibold text-faint">适合谁</h3>
            <p className="mt-1.5 text-caption leading-5 text-muted">{item.audience}</p>
          </div>
          <div className="rounded-2xl bg-sidebar p-4 sm:col-span-3">
            <h3 className="text-caption font-semibold text-faint">完整交付目标</h3>
            <p className="mt-1.5 text-caption leading-5 text-muted">{item.outcome}</p>
          </div>
        </section>

        {item.fieldReport && (
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-title font-semibold text-fg">
                案例背景与结果数据
              </h3>
              <a
                href={item.fieldReport.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-micro font-medium text-accent hover:underline"
              >
                {item.fieldReport.sourceLabel} <ExternalLink size={10} />
              </a>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-sidebar p-4">
                <p className="text-micro font-semibold text-accent">
                  用户遇到的问题
                </p>
                <p className="mt-1.5 text-caption leading-5 text-muted">
                  {item.fieldReport.userScene}
                </p>
                <p className="mt-2 text-caption leading-5 text-muted">
                  {item.fieldReport.obstacle}
                </p>
              </div>
              <div className="rounded-2xl bg-sidebar p-4">
                <p className="text-micro font-semibold text-accent">
                  使用的材料
                </p>
                <p className="mt-1.5 text-caption leading-5 text-muted">
                  {item.fieldReport.input}
                </p>
                <p className="mt-2 text-micro text-faint">
                  案例用时：{item.fieldReport.duration}
                </p>
              </div>
            </div>
            <ol className="mt-3 grid gap-2 sm:grid-cols-2">
              {item.fieldReport.journey.map((step, index) => (
                <li
                  key={step.title}
                  className="rounded-xl border border-border p-3"
                >
                  <p className="text-caption font-semibold text-fg">
                    {index + 1}. {step.title}
                  </p>
                  <p className="mt-1 text-caption leading-4 text-muted">
                    {step.evidence}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {item.fieldReport.metrics.map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-xl bg-success-soft p-3 text-center"
                >
                  <strong className="block text-title text-fg">
                    {metric.value}
                  </strong>
                  <span className="mt-1 block text-caption leading-4 text-success">
                    {metric.label}
                  </span>
                  <span className="mt-1 hidden text-caption leading-4 text-muted sm:block">
                    {metric.detail}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-xl bg-accent-soft p-3 text-caption leading-5 text-fg">
              {item.fieldReport.result}
            </p>
          </section>
        )}

        <section>
          <h3 className="text-title font-semibold text-fg">准备材料</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {item.inputMaterials.map((input) => (
              <article key={input.title} className="rounded-2xl bg-sidebar p-4">
                <h4 className="text-meta font-semibold text-fg">
                  {input.title}
                </h4>
                <p className="mt-1 text-caption leading-5 text-muted">
                  {input.description}
                </p>
                <p className="mt-2 text-caption leading-4 text-faint">
                  <strong className="text-muted">怎么准备：</strong>
                  {input.preparation}
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {input.sourceUrl && (
                    <a
                      href={input.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
                    >
                      查看原始材料 <ExternalLink size={11} />
                    </a>
                  )}
                  {input.assetPath?.startsWith("/") && (
                    <a
                      href={input.assetPath}
                      download
                      className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
                    >
                      下载案例副本 <Download size={11} />
                    </a>
                  )}
                </div>
                <details className="group/hash mt-3 border-t border-border pt-2">
                  <summary className="cursor-pointer text-micro text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-ring">
                    查看固定版本与校验值
                  </summary>
                  <p className="mt-2 break-all text-caption leading-4 text-faint">
                    固定版本：{input.revision} · {input.bytes.toLocaleString()}{" "}
                    B<br />
                    SHA-256：{input.sha256}
                  </p>
                </details>
              </article>
            ))}
          </div>
          <ul className="mt-3 grid gap-2 rounded-2xl bg-sidebar p-4 sm:grid-cols-2">
            {item.requirements.map((requirement) => (
              <li
                key={requirement}
                className="flex gap-2 text-caption leading-5 text-muted"
              >
                <Check size={12} className="mt-1 shrink-0 text-success" />
                {requirement}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-title font-semibold text-fg">详细执行步骤</h3>
          <div className="mt-3 space-y-3">
            {item.stages.map((stage, index) => (
              <article
                key={stage.id}
                className="rounded-2xl border border-border p-4"
              >
                <h4 className="text-meta font-semibold text-fg">
                  {index + 1}. {stage.title}
                </h4>
                <StageField label="输入" text={stage.input} />
                <StageField label="操作" text={stage.operation} />
                <StageField label="输出" text={stage.output} />
                <ul className="mt-2 space-y-1.5">
                  {stage.acceptance.map((criterion) => (
                    <li
                      key={criterion}
                      className="flex gap-2 text-caption leading-5 text-muted"
                    >
                      <Check size={12} className="mt-1 shrink-0 text-success" />
                      {criterion}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-title font-semibold text-fg">完整开工指令</h3>
            <Button variant="ghost" size="sm" onClick={onCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制" : "复制指令"}
            </Button>
          </div>
          <blockquote className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-sidebar p-4 text-meta leading-6 text-muted">
            {item.starterPrompt}
          </blockquote>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-title font-semibold text-fg">怎么验收成果</h3>
            <div className="mt-3 space-y-2">
              {item.checks.map((check) => (
                <article
                  key={check.title}
                  className="rounded-2xl bg-success-soft p-4"
                >
                  <h4 className="flex items-center gap-2 text-meta font-semibold text-fg">
                    <Check size={13} className="text-success" />
                    {check.title}
                  </h4>
                  <p className="mt-1.5 text-caption leading-5 text-muted">
                    {check.method}
                  </p>
                  <p className="mt-1.5 text-caption leading-5 text-success">
                    通过：{check.passCriterion}
                  </p>
                </article>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-title font-semibold text-fg">
              推荐配置与能力
            </h3>
            <div className="mt-3 rounded-2xl bg-accent-soft p-4">
              <p className="text-meta font-semibold text-fg">
                {item.suggestion.agentName}
              </p>
              <p className="mt-1 text-caption leading-5 text-muted">
                {item.suggestion.why}
              </p>
              <p className="mt-2 text-micro text-faint">
                {item.suggestion.agentId} · {item.suggestion.modelId} ·{" "}
                {item.suggestion.modelGuidance}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {item.capabilityIds.map((id) => (
                  <span key={id} className="rounded-full bg-surface px-2 py-1 text-caption text-muted">
                    {capabilityById(id).shortTitle}
                  </span>
                ))}
              </div>
            </div>
            {item.fieldReport && (
              <div className="mt-3 rounded-2xl bg-warning-soft p-4">
                <h4 className="flex items-center gap-2 text-meta font-semibold text-fg">
                  <TriangleAlert size={13} className="text-warning" />
                  适用边界
                </h4>
                <ul className="mt-2 space-y-1.5">
                  {item.fieldReport.limitations.map((limitation) => (
                    <li
                      key={limitation}
                      className="text-caption leading-5 text-muted"
                    >
                      • {limitation}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section>
          <h3 className="text-title font-semibold text-fg">来源与授权</h3>
          <div className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {item.sources.map((source) => (
              <article key={`${source.url}-${source.role}`} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-caption font-semibold text-fg hover:text-accent hover:underline"
                  >
                    {source.title} <ExternalLink size={11} />
                  </a>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-caption text-faint">
                    {sourceRoleLabel(source.role)}
                  </span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-caption text-faint">
                    {source.license}
                  </span>
                </div>
                <p className="mt-1 text-caption leading-5 text-muted">
                  {source.usageNote}
                </p>
              </article>
            ))}
          </div>
        </section>

        {item.replay.status === "verified" ? (
          <section>
            <h3 className="text-title font-semibold text-fg">运行过程回放</h3>
            <TutorialReplay caseId={item.id} replay={item.replay} />
            <p className="mt-2 text-caption leading-5 text-faint">
              {item.replay.disclosure}
            </p>
          </section>
        ) : (
          <section>
            <h3 className="text-title font-semibold text-fg">运行过程回放</h3>
            {/* 待采集态只留 TutorialReplay 自己那一段说明,不再在标题下重复一遍标签(审计 TU-10)。 */}
            <TutorialReplay caseId={item.id} replay={item.replay} />
          </section>
        )}
      </div>
    </details>
  );
}

function StageField({ label, text }: { label: string; text: string }) {
  return (
    <p className="mt-2 text-caption leading-5 text-muted">
      <strong className="font-semibold text-fg">{label}：</strong>
      {text}
    </p>
  );
}

function FeatureSidebar({
  items,
  activeId,
  category,
  progress,
  onCategoryChange,
  onSelect,
}: {
  items: ProductCapability[];
  activeId: ProductFeatureId;
  category: ProductFeatureCategory | "all";
  progress: ReturnType<typeof readTutorialProgress>;
  onCategoryChange: (category: ProductFeatureCategory | "all") => void;
  onSelect: (id: ProductFeatureId) => void;
}) {
  const listRef = useRef<HTMLElement>(null);
  // 当前教程不在可见区时把它滚进来(审计 TU-18):用容器 scrollTop 而不是 scrollIntoView,
  // 后者会连 Dialog.Content 一起滚(TU-23)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 变化会重排目录，需要重新对齐当前行的滚动位置
  useEffect(() => {
    const container = listRef.current;
    const row = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!container || !row) return;
    const top = row.offsetTop - container.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < container.scrollTop || bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, top - container.clientHeight / 2 + row.offsetHeight / 2);
    }
  }, [activeId, items]);
  const activeInList = items.some((item) => item.id === activeId);
  const readCount = PRODUCT_CAPABILITY_LIST.filter((item) => tutorialIsRead(progress, item.id as ProductFeatureId)).length;
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
      <div aria-hidden className="mx-3 mt-3 rounded-2xl border border-border bg-surface p-3.5 shadow-sm">
        <div className="flex items-center justify-between text-caption">
          <span className="font-semibold text-fg">学习进度</span>
          <span className="tabular-nums text-faint">{Math.round((readCount / PRODUCT_CAPABILITY_LIST.length) * 100)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-grad-cta transition-[width] duration-700 ease-standard" style={{ width: `${(readCount / PRODUCT_CAPABILITY_LIST.length) * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-col gap-0.5 p-3">
        <button type="button" onClick={() => onCategoryChange("all")} aria-pressed={category === "all"} className={cn("rounded-xl px-3 py-2 text-left text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", category === "all" ? "bg-surface text-fg shadow-sm ring-1 ring-border" : "text-muted hover:bg-hover hover:text-fg")}>
          全部功能
          {/* 总进度(审计 TU-19):此前只有每行一个勾,看不出「读了几篇」。 */}
          <span className="float-right text-faint">{readCount > 0 ? `已读 ${readCount}/${PRODUCT_CAPABILITY_LIST.length}` : PRODUCT_CAPABILITY_LIST.length}</span>
        </button>
        {PRODUCT_FEATURE_CATEGORIES.map((item) => (
          <button type="button" key={item.id} onClick={() => onCategoryChange(item.id)} aria-pressed={category === item.id} title={item.description} className={cn("rounded-xl px-3 py-2 text-left text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", category === item.id ? "bg-surface text-fg shadow-sm ring-1 ring-border" : "text-muted hover:bg-hover hover:text-fg")}>
            {item.label}<span className="float-right text-faint">{PRODUCT_CAPABILITY_LIST.filter((entry) => entry.category === item.id).length}</span>
          </button>
        ))}
      </div>
      <nav ref={listRef} aria-label="教程目录" className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!activeInList && (
          // 筛选后当前教程不在列表里时给个位置提示,别让高亮凭空消失(审计 TU-18)。
          <output className="mx-2 mb-1 block rounded-lg bg-accent-soft px-3 py-2 text-caption text-accent">
            正在看：{capabilityById(activeId).shortTitle}（不在当前筛选内）
          </output>
        )}
        <TopicList items={items} activeId={activeId} isRead={(id) => tutorialIsRead(progress, id)} onSelect={onSelect} />
      </nav>
    </aside>
  );
}

function FeatureDetail({
  feature,
  topicId,
  stepIndex = null,
  progress,
  videoFailed,
  onVideoFailed,
  copied,
  onCopy,
  cta,
  onRunAction,
  onTopicChange,
}: {
  feature: ProductCapability;
  topicId: ProductFeatureId;
  /** 深链目标步骤(1 起):给那一步加 aria-current,滚动与聚焦由父级 effect 负责。 */
  stepIndex?: number | null;
  progress: ReturnType<typeof readTutorialProgress>;
  videoFailed: Record<string, boolean>;
  onVideoFailed: (key: string) => void;
  copied: boolean;
  onCopy: () => void;
  cta: TutorialActionState;
  onRunAction: (feature: ProductCapability) => void;
  onTopicChange: (id: ProductFeatureId) => void;
}) {
  const topic = tutorialById(topicId);
  const media = TUTORIAL_MEDIA[topic.media];
  return (
    <article className="mx-auto max-w-[820px] px-4 pb-14 pt-7 sm:px-8 sm:pt-10" data-topic-id={topicId}>
      <div className="flex items-start gap-5">
        <FeatureIcon feature={feature} className="hidden sm:flex" />
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {/* 「内容版本 N」对用户没有含义,收进 data 属性供排障(审计 TU-26)。 */}
            <Badge tone="accent" data-content-version={topic.contentVersion}>{featureCategoryLabel(feature.category)}</Badge>
            <span className="text-caption text-faint">{topic.steps.length} 个步骤</span>
            {tutorialIsRead(progress, topicId) && <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-caption font-medium text-success"><Check size={11} /> 已读</span>}
          </div>
          <h1 className="text-balance text-[28px] font-bold leading-[1.12] tracking-[-0.03em] text-fg sm:text-[38px]">{feature.title}</h1>
          <p className="mt-3.5 text-[15px] leading-7 text-muted">{topic.intro}</p>
        </div>
      </div>

      <section className="tut-frame mt-8 overflow-hidden rounded-[24px] border border-border bg-surface">
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="ml-2 truncate text-caption text-faint">{feature.shortTitle}</span>
        </div>
        <div className="aspect-video w-full bg-sidebar">
          {videoFailed[topic.media] ? (
            <div className="relative h-full w-full">
              <img src={media.poster} alt={media.caption} className="h-full w-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-4 pb-3 pt-10 text-meta text-white">演示视频暂不可播放，已显示同一功能截图。</div>
            </div>
          ) : (
            <video key={media.video} controls playsInline muted preload="metadata" poster={media.poster} aria-label={`${feature.shortTitle}演示视频`} onError={() => onVideoFailed(topic.media)} className="h-full w-full object-cover">
              <source src={media.video} type="video/webm; codecs=vp8" />
            </video>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-caption text-faint">
          <p>{media.caption}</p><span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 font-medium text-success">真实界面录制 · 脱敏示例</span>
        </div>
      </section>

      <section className="tut-hero mt-8 rounded-[24px] border border-border p-5 sm:p-6">
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-[0.14em] text-accent"><Target size={13} aria-hidden /> 完成后你能</div>
          <p className="mt-2 text-[17px] font-semibold leading-7 text-fg">{topic.outcome}</p>
          <div className="mt-4 flex flex-wrap gap-2">{topic.scenarios.map((scenario) => <span key={scenario} className="rounded-full border border-border bg-surface/80 px-3 py-1 text-caption text-muted backdrop-blur">{scenario}</span>)}</div>
        </div>
      </section>

      <section className="mt-11">
        <h2 className="text-[21px] font-semibold tracking-tight text-fg">跟着做</h2>
        {/* 每一步都是深链落点(`?panel=help&topic=…&step=N`,TU-17):tabIndex=-1 让父级把焦点放到这一步,
            scroll-mt 留出顶部空隙;目标步骤带 aria-current 与浅色底,读屏 / 视觉都知道"链接指的是这一步"。 */}
        <ol className="relative mt-5 flex flex-col gap-2">
          <span aria-hidden className="tut-rail absolute bottom-5 left-[17px] top-5 w-px" />
          {topic.steps.map((step, index) => {
            const current = stepIndex === index + 1;
            return (
              <li
                key={step.title}
                id={`tutorial-step-${index + 1}`}
                data-tutorial-step={index + 1}
                tabIndex={-1}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "relative flex gap-4 scroll-mt-4 rounded-2xl py-3 pr-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  current && "bg-accent-soft/60",
                )}
              >
                <span className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full bg-grad-cta text-meta font-semibold text-white ring-4 ring-bg">{index + 1}</span>
                <div className="min-w-0 pt-1">
                  <h3 className="text-[15.5px] font-semibold text-fg">{step.title}</h3>
                  <p className="mt-1 text-[14px] leading-6 text-muted">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {topic.example && <section className="mt-10 rounded-[22px] border border-border bg-surface p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-title font-semibold text-fg"><Quote size={15} className="text-accent" aria-hidden /> 可以直接参考的说法</h2><Button variant="secondary" size="sm" shape="pill" onClick={onCopy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制示例"}</Button></div><blockquote className="mt-4 rounded-xl bg-hover px-4 py-3.5 text-[14px] leading-7 text-fg/85">{topic.example}</blockquote></section>}

      <div className="mt-10 grid gap-4 sm:grid-cols-2"><InfoBox icon={Lightbulb} title="实用建议" tone="accent" items={topic.tips} /><InfoBox icon={TriangleAlert} title="使用前留意" tone="warning" items={topic.cautions} /></div>

      <section className="tut-cta relative mt-10 overflow-hidden rounded-[24px] p-6 text-white sm:p-7"><div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-[19px] font-semibold">现在去真实功能里试一遍</h2><p className="mt-1.5 text-meta text-white/75">教程不会替你发送消息、修改设置或执行付费操作。</p>{!cta.enabled && cta.disabledReason && <p className="mt-2 inline-block rounded-lg bg-white/90 px-2.5 py-1 text-meta text-warning">{cta.disabledReason}</p>}</div><Button variant="secondary" shape="pill" size="lg" disabled={!cta.enabled} onClick={() => onRunAction(feature)} className="shrink-0 border-transparent bg-white text-[#14121f] hover:bg-white/90">{cta.label} <ArrowRight size={15} /></Button></div></section>

      <section className="mt-10"><h2 className="text-title font-semibold text-fg">接着了解</h2><div className="mt-3 grid gap-2.5 sm:grid-cols-3">{topic.related.map((relatedId) => { const related = capabilityById(relatedId); const RelatedIcon = ICONS[related.icon] ?? Sparkles; return <button key={relatedId} type="button" onClick={() => onTopicChange(relatedId)} className="tut-card group flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-3 text-left text-meta text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><RelatedIcon size={14} /></span><span className="min-w-0 flex-1 truncate font-medium">{related.shortTitle}</span><ArrowRight size={13} className="text-faint transition-transform group-hover:translate-x-0.5" /></button>; })}</div></section>
    </article>
  );
}

// 分类 chip / 目录行 / 页签都不走 Button 原语,触屏 44px 规则要自己补(审计 TU-11);chip 补选中态语义(TU-24)。
function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn("shrink-0 rounded-full px-3 py-1.5 text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11", active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg")}>{children}</button>;
}

function TopicList({ items, activeId, isRead, onSelect }: { items: ProductCapability[]; activeId: ProductFeatureId; isRead: (id: ProductFeatureId) => boolean; onSelect: (id: ProductFeatureId) => void }) {
  if (items.length === 0) return <output className="block px-4 py-8 text-center text-meta text-faint">没有匹配的教程，换个关键词试试。</output>;
  return <div className="flex flex-col gap-0.5">{items.map((item) => { const id = item.id as ProductFeatureId; const Icon = ICONS[item.icon] ?? Sparkles; return <button key={id} type="button" aria-current={id === activeId ? "page" : undefined} onClick={() => onSelect(id)} className={cn("group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11", id === activeId ? "bg-surface text-fg shadow-sm ring-1 ring-border" : "text-muted hover:bg-hover hover:text-fg")}><span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg shadow-sm group-hover:text-accent", id === activeId ? "bg-accent-soft text-accent" : "bg-surface text-faint")}><Icon size={14} /></span><span className="min-w-0 flex-1 truncate text-meta font-medium">{item.shortTitle}</span>{isRead(id) && <Check size={13} className="shrink-0 text-success" aria-label="已读" />}</button>; })}</div>;
}

function FeatureIcon({ feature, className }: { feature: ProductCapability; className?: string }) {
  const Icon = ICONS[feature.icon] ?? Sparkles;
  return <span className={cn("tut-mark size-14 shrink-0 items-center justify-center rounded-[18px] bg-grad-cta text-white", className)}><Icon size={24} /></span>;
}

function InfoBox({ icon: Icon, title, tone, items }: { icon: LucideIcon; title: string; tone: "accent" | "warning"; items: readonly string[] }) {
  return <section className={cn("rounded-[20px] border p-5", tone === "accent" ? "border-accent/20 bg-accent-soft" : "border-warning/20 bg-warning-soft")}><h2 className={cn("flex items-center gap-1.5 text-body font-semibold", tone === "accent" ? "text-accent" : "text-warning")}><Icon size={15} /> {title}</h2><ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-5 text-muted">{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

function featureCategoryLabel(id: ProductFeatureCategory): string {
  return PRODUCT_FEATURE_CATEGORIES.find((item) => item.id === id)?.label ?? id;
}

function caseCategoryLabel(id: TutorialCaseCategory): string {
  return CASE_CATEGORIES.find((item) => item.id === id)?.label ?? id;
}

function sourceRoleLabel(role: TutorialCase["sources"][number]["role"]): string {
  if (role === "need-evidence") return "需求证据";
  if (role === "input") return "案例输入";
  if (role === "method") return "方法依据";
  return "授权依据";
}

export const DEFAULT_TUTORIAL_TOPIC = PRODUCT_CAPABILITIES.chatBasics.id;

import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Brain,
  Building2,
  Check,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileInput,
  FileOutput,
  GitBranch,
  History,
  Image,
  Lightbulb,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Mic,
  Monitor,
  Paperclip,
  Plug,
  Search,
  Settings,
  Sparkles,
  Store,
  TestTube2,
  TriangleAlert,
  Upload,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { tutorialHref } from "../hooks/useAppRoute";
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
  TUTORIAL_TOPIC_LIST,
  tutorialById,
} from "../lib/tutorialCatalog";
import {
  markTutorialRead,
  readTutorialProgress,
  tutorialIsRead,
} from "../lib/tutorialProgress";
import { cn } from "../lib/utils";
import { CASE_PRESENTATION, CaseArtwork } from "./tutorials/CaseArtwork";
import { TutorialReplay } from "./tutorials/TutorialReplay";
import { Badge, Button, IconButton } from "./ui";

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
    ].join(" "),
  );
  return q.split(" ").every((term) => haystack.includes(term));
}

export function TutorialCenter({
  open,
  topicId,
  caseId = null,
  onTopicChange,
  onCaseChange = () => {},
  onShowCaseGallery = () => {},
  caseActionLabel,
  onRunCase,
  onClose,
  actionState,
  onRunAction,
}: {
  open: boolean;
  topicId: ProductFeatureId | null;
  caseId?: TutorialCaseId | null;
  onTopicChange: (id: ProductFeatureId) => void;
  onCaseChange?: (id: TutorialCaseId) => void;
  onShowCaseGallery?: () => void;
  caseActionLabel?: string;
  onRunCase?: (item: TutorialCase) => void;
  onClose: () => void;
  actionState: (feature: ProductCapability) => TutorialActionState;
  onRunAction: (feature: ProductCapability) => void;
}) {
  const mode = topicId ? "features" : "cases";
  const selectedTopicId = topicId ?? PRODUCT_CAPABILITIES.chatBasics.id;
  const [query, setQuery] = useState("");
  const [featureCategory, setFeatureCategory] = useState<ProductFeatureCategory | "all">("all");
  const [caseCategory, setCaseCategory] = useState<TutorialCaseCategory | "all">("all");
  const [progress, setProgress] = useState(() => readTutorialProgress());
  const [videoFailed, setVideoFailed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  const feature = capabilityById(selectedTopicId);
  const topic = tutorialById(selectedTopicId);
  const media = TUTORIAL_MEDIA[topic.media];
  const cta = actionState(feature);
  const selectedCase = caseId ? TUTORIAL_CASE_BY_ID[caseId] : null;

  const filteredFeatures = useMemo(
    () =>
      PRODUCT_CAPABILITY_LIST.filter(
        (item) =>
          (featureCategory === "all" || item.category === featureCategory) &&
          tutorialMatches(item, query),
      ),
    [featureCategory, query],
  );
  const filteredCases = useMemo(
    () =>
      TUTORIAL_CASES.filter(
        (item) =>
          (caseCategory === "all" || item.category === caseCategory) &&
          tutorialCaseMatches(item, query),
      ),
    [caseCategory, query],
  );
  const mobileFeatureOptions = filteredFeatures.some((item) => item.id === selectedTopicId)
    ? filteredFeatures
    : [feature, ...filteredFeatures];
  const readCount = TUTORIAL_TOPIC_LIST.filter((item) =>
    tutorialIsRead(progress, item.featureId),
  ).length;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFeatureCategory("all");
      setCaseCategory("all");
      return;
    }
    if (!topicId) return;
    const timer = window.setTimeout(() => setProgress(markTutorialRead(topicId)), 900);
    return () => window.clearTimeout(timer);
  }, [open, topicId]);

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

  const showCases = () => {
    setQuery("");
    onShowCaseGallery();
  };

  const showFeatures = () => {
    setQuery("");
    onTopicChange(selectedTopicId);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="tutorial-shell fixed inset-x-2 bottom-2 top-2 z-50 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-float focus:outline-none data-[state=open]:animate-in sm:inset-x-4 sm:bottom-4 sm:top-4 lg:left-1/2 lg:w-[min(1180px,calc(100vw-2rem))] lg:-translate-x-1/2"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/90 px-3 py-3 backdrop-blur-xl sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-grad-cta text-white shadow-sm">
                <Lightbulb size={18} />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="truncate text-[15px] font-semibold text-fg sm:text-[17px]">
                  案例与教程
                </Dialog.Title>
                <p className="hidden text-[11.5px] text-faint sm:block">
                  真实问题 · 完整过程 · 可验收产物
                </p>
              </div>
            </div>
            <label className="ml-auto flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-xl bg-hover px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search size={15} className="shrink-0 text-faint" />
              <span className="sr-only">搜索教程</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={mode === "cases" ? "搜索任务、材料或产物" : "搜索功能、场景或关键词"}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              />
            </label>
            {mode === "features" && (
              <div className="hidden shrink-0 items-center gap-2 text-[11.5px] text-faint md:flex">
                <span>{readCount}/{TUTORIAL_TOPIC_LIST.length} 已读</span>
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-hover" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${(readCount / TUTORIAL_TOPIC_LIST.length) * 100}%` }}
                  />
                </span>
              </div>
            )}
            <Dialog.Close asChild>
              <IconButton aria-label="关闭教程" variant="muted" shape="square">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </header>

          <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-3 py-2 sm:px-5">
            <ViewTab active={mode === "cases"} onClick={showCases} icon={TestTube2}>
              实战案例
            </ViewTab>
            <ViewTab active={mode === "features"} onClick={showFeatures} icon={Sparkles}>
              功能索引
            </ViewTab>
            {mode === "cases" && (
              <span className="ml-auto hidden text-[11.5px] text-faint sm:block">
                {TUTORIAL_CASES.length} 个公开、可复查的任务场景
              </span>
            )}
          </div>

          <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-2 lg:hidden">
            {mode === "cases" ? (
              <>
                <CategoryChip active={caseCategory === "all"} onClick={() => setCaseCategory("all")}>
                  全部
                </CategoryChip>
                {CASE_CATEGORIES.map((item) => (
                  <CategoryChip
                    key={item.id}
                    active={caseCategory === item.id}
                    onClick={() => setCaseCategory(item.id)}
                  >
                    {item.label}
                  </CategoryChip>
                ))}
              </>
            ) : (
              <>
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
              </>
            )}
          </div>

          <div className="flex min-h-0 flex-1">
            {mode === "cases" ? (
              <CaseSidebar
                items={filteredCases}
                activeId={caseId}
                category={caseCategory}
                onCategoryChange={setCaseCategory}
                onSelect={onCaseChange}
                onShowAll={onShowCaseGallery}
              />
            ) : (
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
                  <select
                    aria-label="选择教程"
                    value={selectedTopicId}
                    onChange={(event) => onTopicChange(event.target.value as ProductFeatureId)}
                    className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:ring-2 focus:ring-ring"
                  >
                    {mobileFeatureOptions.length > 0 ? (
                      mobileFeatureOptions.map((item) => (
                        <option key={item.id} value={item.id}>{item.shortTitle}</option>
                      ))
                    ) : (
                      <option value={selectedTopicId}>没有匹配教程</option>
                    )}
                  </select>
                </div>
              )}

              <main className="tutorial-detail min-h-0 flex-1 overflow-y-auto">
                {mode === "cases" ? (
                  selectedCase ? (
                    <CaseDetail
                      item={selectedCase}
                      copied={copied}
                      onCopy={() => copyText(selectedCase.starterPrompt)}
                      onBack={onShowCaseGallery}
                      actionLabel={caseActionLabel}
                      onRun={onRunCase}
                    />
                  ) : (
                    <CaseGallery items={filteredCases} onSelect={onCaseChange} />
                  )
                ) : (
                  <FeatureDetail
                    feature={feature}
                    topicId={selectedTopicId}
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
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon size={14} /> {children}
    </button>
  );
}

function CaseSidebar({
  items,
  activeId,
  category,
  onCategoryChange,
  onSelect,
  onShowAll,
}: {
  items: readonly TutorialCase[];
  activeId: TutorialCaseId | null;
  category: TutorialCaseCategory | "all";
  onCategoryChange: (category: TutorialCaseCategory | "all") => void;
  onSelect: (id: TutorialCaseId) => void;
  onShowAll: () => void;
}) {
  return (
    <aside className="hidden w-[292px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
      <div className="flex flex-col gap-1 p-3">
        <button
          type="button"
          onClick={() => { onCategoryChange("all"); onShowAll(); }}
          className={cn(
            "rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            category === "all" && !activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          全部案例 <span className="float-right text-faint">{TUTORIAL_CASES.length}</span>
        </button>
        {CASE_CATEGORIES.map((item) => (
          <button
            type="button"
            key={item.id}
            title={item.description}
            onClick={() => { onCategoryChange(item.id); onShowAll(); }}
            className={cn(
              "rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              category === item.id && !activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {item.label}
            <span className="float-right text-faint">
              {TUTORIAL_CASES.filter((entry) => entry.category === item.id).length}
            </span>
          </button>
        ))}
      </div>
      <nav aria-label="案例目录" className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-faint">没有匹配的案例，换个关键词试试。</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <a
                key={item.id}
                href={tutorialHref(window.location, null, item.id)}
                aria-current={item.id === activeId ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onSelect(item.id);
                }}
                className={cn(
                  "rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  item.id === activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <span className="block text-[11px] font-medium text-accent">{caseCategoryLabel(item.category)} · {item.difficulty}</span>
                <span className="mt-0.5 block text-[12.5px] font-medium leading-5">{item.title}</span>
              </a>
            ))}
          </div>
        )}
      </nav>
    </aside>
  );
}

function CaseGallery({ items, onSelect }: { items: readonly TutorialCase[]; onSelect: (id: TutorialCaseId) => void }) {
  return (
    <section className="mx-auto max-w-5xl px-3 pb-12 pt-4 sm:px-7 sm:pt-7">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div>
          <h1 className="text-balance text-[22px] font-bold leading-tight tracking-tight text-fg sm:text-[28px]">
            你今天想完成什么？
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-muted sm:text-[14px]">
            选一个和你当前难题最像的，先看成果，再跟着做。
          </p>
        </div>
        <p className="hidden shrink-0 text-[11.5px] text-faint sm:block">科研 · 编码 · 日常工作</p>
      </div>
      {items.length === 0 ? (
        <div className="mt-7 rounded-2xl border border-dashed border-border px-5 py-12 text-center text-[13.5px] text-faint">
          没有匹配案例，试试“文献”“引用”“回归测试”或清空筛选。
        </div>
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-2 sm:mt-6">
          {items.map((item) => {
            const presentation = CASE_PRESENTATION[item.id];
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                aria-label={`${presentation.pain} ${item.title}，完成后得到${presentation.result}，查看完整过程`}
                className="group overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-sm outline-none transition-[border-color,box-shadow,transform] hover:-translate-y-1 hover:border-accent/40 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CaseArtwork caseId={item.id} />
                <div className="p-4 sm:p-5">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10.5px] font-semibold text-accent">
                      {caseCategoryLabel(item.category)} · {item.difficulty}
                    </span>
                    {item.artifacts.slice(0, 2).map((artifact) => (
                      <span key={artifact.title} className="rounded-full bg-hover px-2 py-1 text-[10px] text-faint">
                        {artifact.format}
                      </span>
                    ))}
                  </div>
                  <p className="mt-3 text-[13px] font-medium leading-5 text-accent">{presentation.pain}</p>
                  <h2 className="mt-1 text-[17px] font-semibold leading-6 text-fg">{item.title}</h2>
                  <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-5 text-muted">{presentation.result}</p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg transition-colors group-hover:text-accent">
                    查看完整过程
                    <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
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
  return (
    <article className="mx-auto max-w-4xl px-3 pb-14 pt-4 sm:px-7 sm:pt-6" data-case-id={item.id}>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
        <ArrowLeft size={14} /> 返回全部案例
      </button>
      <section className="mt-4 overflow-hidden rounded-3xl border border-border bg-surface shadow-sm md:grid md:grid-cols-[1.05fr_.95fr]">
        <CaseArtwork caseId={item.id} className="md:h-full md:min-h-[320px] md:aspect-auto" />
        <div className="flex flex-col p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{caseCategoryLabel(item.category)}</Badge>
            <span className="rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted">{item.difficulty}</span>
            <span className="text-[10.5px] text-faint">内容版本 {item.contentVersion}</span>
          </div>
          <p className="mt-4 text-[13px] font-semibold leading-5 text-accent">{presentation.pain}</p>
          <h1 className="mt-1.5 text-balance text-[24px] font-bold leading-tight tracking-tight text-fg sm:text-[30px]">{item.title}</h1>
          <p className="mt-3 text-[13px] leading-6 text-muted">{item.summary}</p>
          <div className="mt-4 rounded-2xl bg-accent-soft p-3.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-accent">最终成果</p>
            <p className="mt-1 text-[13px] font-medium leading-5 text-fg">{presentation.result}</p>
          </div>
          {actionLabel && onRun && (
            <Button variant="primary" onClick={() => onRun(item)} className="mt-5 self-start">
              {actionLabel} <ArrowRight size={15} />
            </Button>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-accent">先看结果</p>
            <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-fg">你会拿到这些成果</h2>
          </div>
          <span className="rounded-full bg-hover px-2.5 py-1 text-[10.5px] text-faint">{item.artifacts.length} 份可交付文件</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {item.artifacts.map((artifact, index) => (
            <div key={artifact.title} className="group rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/30 hover:bg-accent-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent"><FileOutput size={17} /></span>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] font-medium text-faint">{artifact.format}</span>
              </div>
              <p className="mt-3 text-[13px] font-semibold leading-5 text-fg">{artifact.title}</p>
              <p className="mt-1 text-[11.5px] leading-5 text-muted">{artifact.description}</p>
              <span className="mt-3 block text-[10.5px] font-medium text-accent">成果 {index + 1}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-9 grid gap-3 sm:grid-cols-3">
        <OverviewDatum icon={Users} title="适合你，如果" body={item.audience} />
        <OverviewDatum icon={FileOutput} title="最终完成" body={item.outcome} />
        <OverviewDatum
          icon={Bot}
          title={`推荐 ${item.suggestion.agentName}`}
          body={`${item.suggestion.agentId} · ${item.suggestion.modelId} · ${item.suggestion.modelGuidance}`}
        />
      </section>

      <section className="mt-10">
        <div>
          <p className="text-[11px] font-semibold text-accent">跟着画面走</p>
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-fg">{item.stages.length} 步完成</h2>
        </div>
        <ol className="mt-5">
          {item.stages.map((stage, index) => (
            <li key={stage.id} className="relative flex gap-3.5 pb-5 last:pb-0 sm:gap-5">
              <div className="flex w-8 shrink-0 flex-col items-center">
                <span className="z-10 flex size-8 items-center justify-center rounded-full bg-grad-cta text-[12px] font-bold text-white shadow-sm">{index + 1}</span>
                {index < item.stages.length - 1 && <span className="mt-1 w-px flex-1 bg-border" aria-hidden />}
              </div>
              <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <div className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-[15px] font-semibold text-fg">{stage.title}</h3>
                    <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">输出可验收</span>
                  </div>
                  <div className="mt-3 rounded-xl bg-accent-soft p-3">
                    <p className="text-[10.5px] font-semibold text-accent">这一步会产出</p>
                    <p className="mt-1 text-[12.5px] leading-5 text-fg">{stage.output}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5" aria-label="可见过程">
                    {stage.visibleProcess.map((process) => (
                      <span key={process} className="rounded-full border border-border bg-bg px-2.5 py-1 text-[10.5px] text-muted">{process}</span>
                    ))}
                  </div>
                </div>
                <details className="group border-t border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[11.5px] font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
                    展开输入、操作与验收标准
                    <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border bg-sidebar px-4 pb-4 pt-1 sm:px-5">
                    <StageField label="输入" text={stage.input} />
                    <StageField label="操作" text={stage.operation} />
                    <div className="mt-3">
                      <p className="text-[11px] font-semibold text-success">验收标准</p>
                      <ul className="mt-1.5 flex flex-col gap-1.5 text-[12px] leading-5 text-muted">
                        {stage.acceptance.map((criterion) => (
                          <li key={criterion} className="flex gap-2"><Check size={13} className="mt-0.5 shrink-0 text-success" />{criterion}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </details>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-9 rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10.5px] font-semibold text-accent">可以直接改成你的任务</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-fg">开工指令</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制指令"}
          </Button>
        </div>
        <details className="group mt-3 rounded-xl bg-sidebar">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-[12px] font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
            查看完整指令
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
          </summary>
          <blockquote className="whitespace-pre-wrap border-t border-border px-3.5 py-3 text-[12.5px] leading-6 text-muted">{item.starterPrompt}</blockquote>
        </details>
      </section>

      <section className="mt-10">
        <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-fg"><FileInput size={18} className="text-accent" /> 准备材料</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {item.inputMaterials.map((input) => (
            <div key={input.title} className="rounded-2xl border border-border bg-surface p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><FileInput size={16} /></span>
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold text-fg">{input.title}</h3>
                  <p className="mt-1 text-[12px] leading-5 text-muted">{input.description}</p>
                </div>
              </div>
              <p className="mt-3 rounded-xl bg-sidebar p-3 text-[11.5px] leading-5 text-muted"><strong className="font-semibold text-fg">怎么准备：</strong>{input.preparation}</p>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">
                {input.sourceUrl && (
                  <a href={input.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent hover:underline">
                    原始材料 <ExternalLink size={11} />
                  </a>
                )}
                {input.assetPath?.startsWith("/") && (
                  <a href={input.assetPath} download className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent hover:underline">
                    下载案例副本 <Download size={11} />
                  </a>
                )}
              </div>
              <details className="group mt-3 border-t border-border pt-2">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[10.5px] text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-ring">
                  查看固定版本与校验值
                  <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-2 break-all text-[10px] leading-4 text-faint">
                  固定版本：{input.revision} · {input.bytes.toLocaleString()} B<br />SHA-256：{input.sha256}
                </p>
              </details>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
          <h3 className="text-[13px] font-semibold text-fg">开始前确认</h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {item.requirements.map((requirement) => (
              <li key={requirement} className="flex gap-2 text-[11.5px] leading-5 text-muted"><Check size={13} className="mt-0.5 shrink-0 text-success" />{requirement}</li>
            ))}
          </ul>
        </div>
        <details className="group mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-[12px] font-semibold text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            查看来源与授权（{item.sources.length}）
            <ChevronDown size={14} className="text-faint transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border">
            {item.sources.map((source, index) => (
              <div key={`${source.url}-${source.role}`} className={cn("p-4", index > 0 && "border-t border-border")}>
                <div className="flex flex-wrap items-center gap-2">
                  <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-fg hover:text-accent hover:underline">
                    {source.title} <ExternalLink size={11} />
                  </a>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-faint">{sourceRoleLabel(source.role)}</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-faint">{source.license}</span>
                </div>
                <p className="mt-1 text-[11.5px] leading-5 text-muted">{source.usageNote}</p>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="mt-9 rounded-2xl bg-accent-soft p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface text-accent shadow-sm"><Bot size={17} /></span>
          <div>
            <h2 className="text-[14px] font-semibold text-fg">为什么推荐 {item.suggestion.agentName}</h2>
            <p className="mt-1 text-[12.5px] leading-5 text-muted">{item.suggestion.why}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {item.capabilityIds.map((id) => (
            <span key={id} className="rounded-full bg-surface px-2.5 py-1 text-[11px] text-muted shadow-sm">{capabilityById(id).shortTitle}</span>
          ))}
        </div>
      </section>

      <section className="mt-9 rounded-2xl border border-warning/25 bg-warning-soft p-5">
        <div className="flex items-start gap-3">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 className="text-[14px] font-semibold text-fg">真实运行重放</h2>
            <TutorialReplay caseId={item.id} replay={item.replay} />
            <p className="mt-2 text-[11.5px] leading-5 text-faint">{item.replay.disclosure}</p>
          </div>
        </div>
      </section>

      <section className="mt-9">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold text-fg"><ClipboardCheck size={17} className="text-success" /> 怎么确认真的做对了</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {item.checks.map((check) => (
            <div key={check.title} className="rounded-2xl border border-success/20 bg-success-soft p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-fg"><Check size={14} className="text-success" />{check.title}</p>
              <p className="mt-2 text-[11.5px] leading-5 text-muted">{check.method}</p>
              <p className="mt-2 rounded-xl bg-surface/70 p-2.5 text-[11px] leading-5 text-success">通过：{check.passCriterion}</p>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

function OverviewDatum({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return <div className="rounded-2xl border border-border bg-surface p-4"><span className="flex size-8 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon size={15} /></span><h2 className="mt-3 text-[11px] font-semibold text-faint">{title}</h2><p className="mt-1 text-[12px] leading-5 text-muted">{body}</p></div>;
}

function StageField({ label, text }: { label: string; text: string }) {
  return <p className="mt-3 text-[12.5px] leading-5 text-muted"><strong className="font-semibold text-fg">{label}：</strong>{text}</p>;
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
  return (
    <aside className="hidden w-[292px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
      <div className="flex flex-col gap-1 p-3">
        <button type="button" onClick={() => onCategoryChange("all")} className={cn("rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", category === "all" ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}>全部功能 <span className="float-right text-faint">{PRODUCT_CAPABILITY_LIST.length}</span></button>
        {PRODUCT_FEATURE_CATEGORIES.map((item) => (
          <button type="button" key={item.id} onClick={() => onCategoryChange(item.id)} title={item.description} className={cn("rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", category === item.id ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
            {item.label}<span className="float-right text-faint">{PRODUCT_CAPABILITY_LIST.filter((entry) => entry.category === item.id).length}</span>
          </button>
        ))}
      </div>
      <nav aria-label="教程目录" className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <TopicList items={items} activeId={activeId} isRead={(id) => tutorialIsRead(progress, id)} onSelect={onSelect} />
      </nav>
    </aside>
  );
}

function FeatureDetail({
  feature,
  topicId,
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
    <article className="mx-auto max-w-3xl px-4 pb-12 pt-7 sm:px-7 sm:pt-9" data-topic-id={topicId}>
      <div className="flex items-start gap-4">
        <FeatureIcon feature={feature} className="hidden sm:flex" />
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="accent">{featureCategoryLabel(feature.category)}</Badge>
            <span className="text-[11px] text-faint">内容版本 {topic.contentVersion}</span>
            {tutorialIsRead(progress, topicId) && <span className="inline-flex items-center gap-1 text-[11px] text-success"><Check size={11} /> 已读</span>}
          </div>
          <h1 className="text-balance text-[25px] font-bold leading-tight tracking-tight text-fg sm:text-[32px]">{feature.title}</h1>
          <p className="mt-3 text-[14.5px] leading-7 text-muted">{topic.intro}</p>
        </div>
      </div>

      <section className="mt-7 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="aspect-video w-full bg-sidebar">
          {videoFailed[topic.media] ? (
            <div className="relative h-full w-full">
              <img src={media.poster} alt={media.caption} className="h-full w-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-4 pb-3 pt-10 text-[12px] text-white">演示视频暂不可播放，已显示同一功能截图。</div>
            </div>
          ) : (
            <video key={media.video} controls playsInline muted preload="metadata" poster={media.poster} aria-label={`${feature.shortTitle}演示视频`} onError={() => onVideoFailed(topic.media)} className="h-full w-full object-cover">
              <source src={media.video} type="video/webm; codecs=vp8" />
            </video>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-[11.5px] text-faint">
          <p>{media.caption}</p><span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 font-medium text-success">真实界面录制 · 脱敏示例</span>
        </div>
      </section>

      <section className="mt-7 rounded-2xl bg-accent-soft p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">完成后你能</div>
        <p className="mt-1.5 text-[15px] font-medium leading-6 text-fg">{topic.outcome}</p>
        <div className="mt-3 flex flex-wrap gap-2">{topic.scenarios.map((scenario) => <span key={scenario} className="rounded-full bg-surface px-2.5 py-1 text-[11.5px] text-muted shadow-sm">{scenario}</span>)}</div>
      </section>

      <section className="mt-9">
        <h2 className="text-[19px] font-semibold tracking-tight text-fg">跟着做</h2>
        <ol className="mt-4 flex flex-col gap-5">{topic.steps.map((step, index) => <li key={step.title} className="flex gap-3.5"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-grad-cta text-[12px] font-semibold text-white">{index + 1}</span><div><h3 className="text-[14px] font-semibold text-fg">{step.title}</h3><p className="mt-1 text-[13.5px] leading-6 text-muted">{step.body}</p></div></li>)}</ol>
      </section>

      {topic.example && <section className="mt-9 rounded-2xl border border-border bg-surface p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-[14px] font-semibold text-fg">可以直接参考的说法</h2><Button variant="ghost" size="sm" onClick={onCopy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制示例"}</Button></div><blockquote className="mt-3 border-l-2 border-accent pl-3 text-[13.5px] leading-6 text-muted">{topic.example}</blockquote></section>}

      <div className="mt-9 grid gap-4 sm:grid-cols-2"><InfoBox icon={Lightbulb} title="实用建议" tone="accent" items={topic.tips} /><InfoBox icon={TriangleAlert} title="使用前留意" tone="warning" items={topic.cautions} /></div>

      <section className="mt-9 rounded-2xl border border-border bg-surface p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-[15px] font-semibold text-fg">现在去真实功能里试一遍</h2><p className="mt-1 text-[12.5px] text-muted">教程不会替你发送消息、修改设置或执行付费操作。</p>{!cta.enabled && cta.disabledReason && <p className="mt-1.5 text-[12px] text-warning">{cta.disabledReason}</p>}</div><Button variant="primary" disabled={!cta.enabled} onClick={() => onRunAction(feature)} className="shrink-0">{cta.label} <ArrowRight size={15} /></Button></div></section>

      <section className="mt-9"><h2 className="text-[14px] font-semibold text-fg">接着了解</h2><div className="mt-3 grid gap-2 sm:grid-cols-3">{topic.related.map((relatedId) => { const related = capabilityById(relatedId); const RelatedIcon = ICONS[related.icon] ?? Sparkles; return <button key={relatedId} type="button" onClick={() => onTopicChange(relatedId)} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-left text-[12px] text-muted outline-none transition-colors hover:border-accent/40 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"><RelatedIcon size={14} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate">{related.shortTitle}</span><ArrowRight size={12} className="text-faint" /></button>; })}</div></section>
    </article>
  );
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={cn("shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg")}>{children}</button>;
}

function TopicList({ items, activeId, isRead, onSelect }: { items: ProductCapability[]; activeId: ProductFeatureId; isRead: (id: ProductFeatureId) => boolean; onSelect: (id: ProductFeatureId) => void }) {
  if (items.length === 0) return <p className="px-4 py-8 text-center text-[12.5px] text-faint">没有匹配的教程，换个关键词试试。</p>;
  return <div className="flex flex-col gap-0.5">{items.map((item) => { const id = item.id as ProductFeatureId; const Icon = ICONS[item.icon] ?? Sparkles; return <button key={id} type="button" aria-current={id === activeId ? "page" : undefined} onClick={() => onSelect(id)} className={cn("group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", id === activeId ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}><span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-faint shadow-sm group-hover:text-accent"><Icon size={14} /></span><span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{item.shortTitle}</span>{isRead(id) && <Check size={13} className="shrink-0 text-success" aria-label="已读" />}</button>; })}</div>;
}

function FeatureIcon({ feature, className }: { feature: ProductCapability; className?: string }) {
  const Icon = ICONS[feature.icon] ?? Sparkles;
  return <span className={cn("size-12 shrink-0 items-center justify-center rounded-2xl bg-grad-cta text-white shadow-sm", className)}><Icon size={22} /></span>;
}

function InfoBox({ icon: Icon, title, tone, items }: { icon: LucideIcon; title: string; tone: "accent" | "warning"; items: readonly string[] }) {
  return <section className={cn("rounded-2xl border p-4", tone === "accent" ? "border-accent/20 bg-accent-soft" : "border-warning/20 bg-warning-soft")}><h2 className={cn("flex items-center gap-1.5 text-[13px] font-semibold", tone === "accent" ? "text-accent" : "text-warning")}><Icon size={15} /> {title}</h2><ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-5 text-muted">{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
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

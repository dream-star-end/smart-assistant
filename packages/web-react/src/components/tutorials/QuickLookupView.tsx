import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Brain,
  Building2,
  Check,
  ChevronDown,
  Clock3,
  Compass,
  Copy,
  Download,
  GitBranch,
  History,
  Image,
  Kanban,
  Lightbulb,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Mic,
  Monitor,
  Paperclip,
  Play,
  Plug,
  Quote,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Store,
  Target,
  Terminal,
  TriangleAlert,
  Upload,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  capabilityById,
  isProductFeatureId,
  PRODUCT_CAPABILITY_LIST,
  PRODUCT_FEATURE_CATEGORIES,
  type ProductCapability,
  type ProductFeatureCategory,
  type ProductFeatureId,
} from "../../lib/productCapabilities";
import { resolveTutorialAction } from "../../lib/tutorialActions";
import { TASKBOARD_ENABLED } from "../../lib/taskboardFeature";
import {
  TUTORIAL_MEDIA,
  tutorialById,
  type TutorialTopic,
} from "../../lib/tutorialCatalog";
import { cn } from "../../lib/utils";
import { Badge, Button } from "../ui";

export interface QuickLookupViewProps {
  topicId: ProductFeatureId | null;
  stepNumber?: number | null;
  taskboardEnabled?: boolean;
  onSelectTopic: (topicId: ProductFeatureId | null) => void;
  onRunAction?: (topic: TutorialTopic) => void;
  actionState?: (topic: TutorialTopic) => {
    available: boolean;
    label?: string;
    reason?: string;
  };
  onOpenGuide?: () => void;
}

interface QuickCommandItem {
  id: string;
  keys: readonly string[];
  title: string;
  description: string;
  keywords: readonly string[];
  relatedTopicId: ProductFeatureId;
}

const FEATURE_ICONS: Record<string, LucideIcon> = {
  message: MessageCircle,
  target: Target,
  history: History,
  kanban: Kanban,
  cpu: SlidersHorizontal,
  paperclip: Paperclip,
  mic: Mic,
  search: Search,
  download: Download,
  monitor: Monitor,
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
};

const QUICK_COMMANDS: readonly QuickCommandItem[] = [
  {
    id: "cmd-btw",
    keys: ["/btw", "/ask"],
    title: "支线快问，不打断主线",
    description: "主任务运行中顺手问概念或查细节，自动关联主线摘要并继承当前主模型。",
    keywords: ["/btw", "/ask", "btw", "ask", "支线", "快问", "不打断", "斜杠", "命令"],
    relatedTopicId: "chat-basics",
  },
  {
    id: "cmd-swarm",
    keys: ["/swarm"],
    title: "开启蜂群并行协作",
    description: "把复杂任务拆成多路并行推进，各角色分工查资料、改码与核验。",
    keywords: ["/swarm", "swarm", "蜂群", "并行", "分工", "团队", "多智能体", "斜杠", "命令"],
    relatedTopicId: "team-mode",
  },
  {
    id: "hotkey-new-jump",
    keys: ["⌘/Ctrl+K"],
    title: "新建会话或快速跳转",
    description: "任意页面一键唤起快速跳转与新建空白会话。",
    keywords: ["ctrl+k", "cmd+k", "⌘+k", "⌘/ctrl+k", "快捷键", "热键", "新建", "跳转", "搜索"],
    relatedTopicId: "sessions-history",
  },
  {
    id: "hotkey-swarm-board",
    keys: ["⌥/Alt+S"],
    title: "打开 / 关闭蜂群看板",
    description: "随时查看并行成员进度与消息板，点击结论一键引用回主线。",
    keywords: ["alt+s", "opt+s", "⌥+s", "⌥/alt+s", "快捷键", "热键", "蜂群", "看板"],
    relatedTopicId: "team-mode",
  },
  {
    id: "hotkey-workbench",
    keys: ["⌘/Ctrl+\\"],
    title: "展开 / 收起右侧工作台",
    description: "随时切换右侧产出预览、云浏览器与计划视图，选中即可批注。",
    keywords: ["ctrl+\\", "cmd+\\", "⌘+\\", "⌘/ctrl+\\", "快捷键", "热键", "工作台", "workbench", "预览", "批注"],
    relatedTopicId: "artifacts-download",
  },
] as const;

const FEATURED_TOPIC_IDS: readonly ProductFeatureId[] = [
  "models-reasoning",
  "team-mode",
  "files-media",
  "artifacts-download",
  "container-web-preview",
  "github-repository",
  "memory-auto-dream",
  "schedules-reminders",
] as const;

const COLLOQUIAL_TOPIC_KEYWORDS: Partial<Record<ProductFeatureId, readonly string[]>> = {
  "chat-basics": ["/btw", "/ask", "快问", "支线", "审批", "拍板", "确认卡", "斜杠命令", "快捷键"],
  "models-reasoning": ["/btw", "快问", "蜂群", "模型", "强模型", "思考深度", "倍率"],
  "team-mode": ["/swarm", "蜂群", "看板", "Alt+S", "⌥S", "并行", "分工", "快捷键"],
  taskboard: ["审批", "拍板", "待确认", "高风险", "工单", "阶段"],
  "github-repository": ["审批", "拍板", "修bug", "PR", "代码审查", "编程"],
  "container-web-preview": ["建站", "网站", "上线", "托管", "元素评论", "工作台", "workbench", "浏览器"],
  "artifacts-download": ["工作台", "workbench", "批注", "预览", "PPT", "Word", "Excel", "建站", "快捷键", "Ctrl+\\"],
  "web-research": ["浏览器", "云浏览器", "接管", "论文", "综述", "工作台", "workbench", "联网"],
  "memory-auto-dream": ["记忆", "长期记忆", "偏好", "自动记住", "梦境"],
  "schedules-reminders": ["定时", "巡检", "日报", "自动", "周期"],
  "sessions-history": ["快捷键", "Ctrl+K", "⌘K", "搜索会话", "新建"],
  "files-media": ["拖文件", "拖拽", "PDF", "表格", "图片", "多模态"],
};

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

function commandMatches(item: QuickCommandItem, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const haystack = normalizeQuery(
    [...item.keys, item.title, item.description, ...item.keywords].join(" "),
  );
  return q.split(" ").every((term) => haystack.includes(term));
}

function capabilityMatches(feature: ProductCapability, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const id = feature.id as ProductFeatureId;
  const topic = tutorialById(id);
  const extra = COLLOQUIAL_TOPIC_KEYWORDS[id] ?? [];
  const haystack = normalizeQuery(
    [
      feature.title,
      feature.shortTitle,
      ...feature.aliases,
      ...extra,
      topic.intro,
      topic.outcome,
      ...topic.scenarios,
      ...topic.steps.flatMap((step) => [step.title, step.body]),
    ].join(" "),
  );
  return q.split(" ").every((term) => haystack.includes(term));
}

function categoryLabel(category: ProductFeatureCategory): string {
  return (
    PRODUCT_FEATURE_CATEGORIES.find((entry) => entry.id === category)?.label ?? category
  );
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 受限环境静默降级
  }
  return false;
}

export function QuickLookupView({
  topicId,
  stepNumber = null,
  taskboardEnabled = TASKBOARD_ENABLED,
  onSelectTopic,
  onRunAction,
  actionState,
  onOpenGuide,
}: QuickLookupViewProps): JSX.Element {
  const [query, setQuery] = useState("");
  const activeTopicId: ProductFeatureId | null =
    topicId &&
    isProductFeatureId(topicId) &&
    (taskboardEnabled || topicId !== "taskboard")
      ? topicId
      : null;

  const trimmedQuery = query.trim();

  const visibleCommands = useMemo(
    () =>
      taskboardEnabled
        ? QUICK_COMMANDS
        : QUICK_COMMANDS.filter((item) => item.relatedTopicId !== "taskboard"),
    [taskboardEnabled],
  );

  const visibleFeaturedTopicIds = useMemo(
    () =>
      taskboardEnabled
        ? FEATURED_TOPIC_IDS
        : FEATURED_TOPIC_IDS.filter((id) => id !== "taskboard"),
    [taskboardEnabled],
  );

  const visibleCapabilities = useMemo(
    () =>
      taskboardEnabled
        ? PRODUCT_CAPABILITY_LIST
        : PRODUCT_CAPABILITY_LIST.filter((feature) => feature.id !== "taskboard"),
    [taskboardEnabled],
  );

  const matchedCommands = useMemo(() => {
    if (!trimmedQuery) return [];
    return visibleCommands.filter((item) => commandMatches(item, trimmedQuery));
  }, [trimmedQuery, visibleCommands]);

  const matchedCapabilities = useMemo(() => {
    if (!trimmedQuery) return [];
    return visibleCapabilities.filter((feature) =>
      capabilityMatches(feature, trimmedQuery),
    );
  }, [trimmedQuery, visibleCapabilities]);

  const groupedCapabilities = useMemo(
    () =>
      PRODUCT_FEATURE_CATEGORIES.map((group) => ({
        ...group,
        items: visibleCapabilities.filter((item) => item.category === group.id),
      })).filter((group) => group.items.length > 0),
    [visibleCapabilities],
  );

  const handlePickTopic = (id: ProductFeatureId) => {
    setQuery("");
    onSelectTopic(id);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
      {/* 顶部统一搜索框 */}
      <div className="relative flex items-center">
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3.5 text-faint"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜功能、斜杠命令或场景词，如 /btw、/swarm、审批、建站、记忆、工作台…"
          aria-label="搜索功能、命令或场景"
          className="oc-field-control min-h-11 w-full rounded-xl border border-border-control bg-surface py-2 pl-10 pr-10 text-base text-fg outline-none placeholder:text-faint hover:border-fg/45 focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:min-h-10 md:text-body"
        />
        {trimmedQuery && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            className="oc-btn-tactile absolute right-1.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:min-w-8"
          >
            <X size={15} aria-hidden />
          </button>
        )}
      </div>

      {/* 态 1：有搜索词时即时列出匹配的快捷命令与能力条目 */}
      {trimmedQuery ? (
        <section aria-label="搜索结果" className="flex min-w-0 flex-col gap-5">
          {matchedCommands.length === 0 && matchedCapabilities.length === 0 ? (
            <div className="oc-surface-card flex flex-col items-center gap-3 rounded-2xl px-6 py-10 text-center">
              <p className="text-body font-medium text-fg">
                没有找到与「{trimmedQuery}」匹配的命令或功能
              </p>
              <p className="text-meta text-muted">
                试试搜 /btw、/swarm、快捷键、审批、建站、记忆、浏览器或工作台。
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  shape="pill"
                  onClick={() => setQuery("")}
                  className="min-h-11 sm:min-h-8"
                >
                  重置搜索
                </Button>
                {onOpenGuide && (
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="pill"
                    onClick={onOpenGuide}
                    className="min-h-11 sm:min-h-8"
                  >
                    去看实战指南
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              {matchedCommands.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-section font-semibold text-fg">
                      匹配的快捷命令与快捷键
                    </h2>
                    <span className="text-caption tabular-nums text-faint">
                      {matchedCommands.length} 项
                    </span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {matchedCommands.map((cmd) => (
                      <button
                        key={cmd.id}
                        type="button"
                        onClick={() => handlePickTopic(cmd.relatedTopicId)}
                        className="oc-surface-card oc-surface-card-hover oc-btn-tactile flex min-h-11 min-w-0 flex-col gap-1.5 rounded-xl p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          {cmd.keys.map((key) => (
                            <kbd
                              key={key}
                              className="oc-surface-recessed rounded-md px-2 py-0.5 font-mono text-caption font-semibold text-accent"
                            >
                              {key}
                            </kbd>
                          ))}
                          <span className="text-body font-semibold text-fg">
                            {cmd.title}
                          </span>
                        </div>
                        <p className="text-meta leading-relaxed text-muted">
                          {cmd.description}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {matchedCapabilities.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-section font-semibold text-fg">匹配的功能说明</h2>
                    <span className="text-caption tabular-nums text-faint">
                      {matchedCapabilities.length} 项
                    </span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {matchedCapabilities.map((feature) => {
                      const id = feature.id as ProductFeatureId;
                      const topic = tutorialById(id);
                      const Icon = FEATURE_ICONS[feature.icon] ?? Sparkles;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => handlePickTopic(id)}
                          className="oc-surface-card oc-surface-card-hover oc-btn-tactile group flex min-h-11 min-w-0 items-start gap-3 rounded-xl p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="oc-icon-badge oc-icon-badge-accent size-8 shrink-0 rounded-lg">
                            <Icon size={15} strokeWidth={1.75} aria-hidden />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-body font-semibold text-fg">
                                {feature.shortTitle}
                              </span>
                              <Badge tone="neutral" size="sm">
                                {categoryLabel(feature.category)}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-meta text-muted">
                              {topic.outcome}
                            </p>
                          </div>
                          <ArrowRight
                            size={14}
                            aria-hidden
                            className="mt-1 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      ) : activeTopicId === null ? (
        /* 态 2：未搜索且未选中具体能力 -> 高频速查板 */
        <div className="flex min-w-0 flex-col gap-6">
          {/* 常用命令与快捷键卡 */}
          <section
            aria-label="常用命令与快捷键"
            className="oc-surface-card rounded-2xl p-4 sm:p-5"
          >
            <div className="flex items-center gap-2">
              <span className="oc-icon-badge oc-icon-badge-accent size-7 rounded-lg">
                <Terminal size={14} aria-hidden />
              </span>
              <div>
                <h2 className="text-title font-semibold text-fg">常用命令与快捷键</h2>
              </div>
            </div>
            <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {visibleCommands.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => handlePickTopic(cmd.relatedTopicId)}
                  className="oc-surface-recessed oc-btn-tactile flex min-h-11 min-w-0 flex-col gap-1.5 rounded-xl p-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cmd.keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded-md border border-border-control bg-surface px-2 py-0.5 font-mono text-caption font-semibold text-accent"
                      >
                        {key}
                      </kbd>
                    ))}
                  </div>
                  <div className="text-body font-semibold text-fg">{cmd.title}</div>
                  <p className="text-caption leading-relaxed text-muted">
                    {cmd.description}
                  </p>
                </button>
              ))}
            </div>
          </section>

          {/* 高频核心能力直达（8 枚真实能力 ID） */}
          <section aria-label="高频核心能力直达" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-title font-semibold text-fg">高频核心能力直达</h2>
              <span className="text-caption text-faint">点击查看步骤与直达入口</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {visibleFeaturedTopicIds.map((id) => {
                const feature = capabilityById(id);
                const topic = tutorialById(id);
                const Icon = FEATURE_ICONS[feature.icon] ?? Sparkles;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handlePickTopic(id)}
                    className="oc-surface-card oc-surface-card-hover oc-btn-tactile group flex min-h-11 min-w-0 flex-col gap-2 rounded-2xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="oc-icon-badge oc-icon-badge-accent size-8 rounded-lg">
                        <Icon size={15} strokeWidth={1.75} aria-hidden />
                      </span>
                      <ArrowRight
                        size={14}
                        aria-hidden
                        className="text-faint transition-transform group-hover:translate-x-0.5"
                      />
                    </div>
                    <div className="text-section font-semibold text-fg">
                      {feature.shortTitle}
                    </div>
                    <p className="line-clamp-2 text-meta leading-relaxed text-muted">
                      {topic.outcome}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 全部能力索引（26 项全覆盖，按分组折叠收纳） */}
          <section aria-label="全部能力索引" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-title font-semibold text-fg">全部能力索引</h2>
              <span className="text-caption tabular-nums text-faint">
                共 {visibleCapabilities.length} 项能力，按分组展开查找
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {groupedCapabilities.map((group) => (
                <details
                  key={group.id}
                  className="oc-surface-card group overflow-hidden rounded-2xl"
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0">
                      <span className="text-section font-semibold text-fg">
                        {group.label}
                      </span>
                      <span className="ml-2 hidden text-meta text-muted sm:inline">
                        {group.description}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-caption tabular-nums text-faint">
                      <span>{group.items.length} 项</span>
                      <ChevronDown
                        size={15}
                        aria-hidden
                        className="transition-transform duration-200 group-open:rotate-180"
                      />
                    </div>
                  </summary>
                  <div className="grid gap-1.5 border-t border-border/70 p-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.items.map((item) => {
                      const id = item.id as ProductFeatureId;
                      const Icon = FEATURE_ICONS[item.icon] ?? Sparkles;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => handlePickTopic(id)}
                          className="oc-btn-tactile flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left text-body font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                        >
                          <span className="oc-icon-badge size-7 shrink-0 rounded-lg">
                            <Icon size={14} strokeWidth={1.75} aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {item.shortTitle}
                          </span>
                          <ArrowRight
                            size={13}
                            aria-hidden
                            className="shrink-0 text-faint"
                          />
                        </button>
                      );
                    })}
                  </div>
                </details>
              ))}
            </div>
          </section>

          {/* 底部轻入口：切换实战指南 */}
          {onOpenGuide && (
            <div className="oc-surface-recessed flex flex-col items-start justify-between gap-3 rounded-2xl px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2.5 text-meta text-muted">
                <Compass size={15} aria-hidden className="shrink-0 text-accent" />
                <span>想按具体工作场景直接拿开工指令开干？</span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                shape="pill"
                onClick={onOpenGuide}
                className="min-h-11 shrink-0 sm:min-h-8"
              >
                去看实战指南
                <ArrowRight size={14} aria-hidden />
              </Button>
            </div>
          )}
        </div>
      ) : (
        /* 态 3：选中具体能力 -> 桌面左 220px 轻目录 + 右精简操作卡 / 移动返回按钮 + 操作卡（零原生 select） */
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
          {/* 移动端顶部返回按钮（严禁原生 <select>） */}
          <div className="flex items-center justify-between gap-2 lg:hidden">
            <Button
              variant="secondary"
              size="sm"
              shape="pill"
              onClick={() => onSelectTopic(null)}
              className="min-h-11"
            >
              <ArrowLeft size={15} aria-hidden />
              返回速查板
            </Button>
          </div>

          {/* 桌面端左侧 220px 轻分组目录（无进度条、无打卡统计） */}
          <aside
            aria-label="能力分组目录"
            className="hidden w-[220px] shrink-0 flex-col gap-3 border-r border-border/70 pr-4 lg:flex"
          >
            <button
              type="button"
              onClick={() => onSelectTopic(null)}
              className="oc-btn-tactile inline-flex min-h-9 items-center gap-1.5 rounded-xl px-2.5 text-meta font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft size={14} aria-hidden />
              <span>返回速查板</span>
            </button>

            <nav aria-label="全部能力目录" className="flex flex-col gap-3.5">
              {groupedCapabilities.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  <div className="px-2.5 py-1 text-caption font-semibold text-faint">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const id = item.id as ProductFeatureId;
                    const active = id === activeTopicId;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => onSelectTopic(id)}
                        className={cn(
                          "oc-btn-tactile flex items-center rounded-lg px-2.5 py-1.5 text-left text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-accent-soft font-semibold text-accent"
                            : "text-muted hover:bg-hover hover:text-fg",
                        )}
                      >
                        <span className="truncate">{item.shortTitle}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          </aside>

          {/* 右侧精简操作卡 */}
          <div className="min-w-0 flex-1">
            <TopicOperationCard
              topicId={activeTopicId}
              stepNumber={stepNumber}
              taskboardEnabled={taskboardEnabled}
              onSelectTopic={onSelectTopic}
              onRunAction={onRunAction}
              actionState={actionState}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TopicOperationCard({
  topicId,
  stepNumber,
  taskboardEnabled,
  onSelectTopic,
  onRunAction,
  actionState,
}: {
  topicId: ProductFeatureId;
  stepNumber: number | null;
  taskboardEnabled: boolean;
  onSelectTopic: (topicId: ProductFeatureId | null) => void;
  onRunAction?: (topic: TutorialTopic) => void;
  actionState?: (topic: TutorialTopic) => {
    available: boolean;
    label?: string;
    reason?: string;
  };
}): JSX.Element {
  const feature = capabilityById(topicId);
  const topic = tutorialById(topicId);
  const media = TUTORIAL_MEDIA[topic.media];

  const [playingVideo, setPlayingVideo] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const articleRef = useRef<HTMLElement>(null);

  // 切换能力条目时重置视频播放态与复制反馈
  useEffect(() => {
    setPlayingVideo(false);
    setVideoFailed(false);
    setCopied(false);
  }, [topicId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // step 深链落焦点（合法范围 1..steps.length）
  useEffect(() => {
    if (
      typeof stepNumber !== "number" ||
      !Number.isInteger(stepNumber) ||
      stepNumber < 1 ||
      stepNumber > topic.steps.length
    ) {
      return;
    }
    const target = articleRef.current?.querySelector<HTMLElement>(
      `[data-tutorial-step="${stepNumber}"]`,
    );
    if (!target) return;
    target.focus({ preventScroll: true });
  }, [topicId, stepNumber, topic.steps.length]);

  const resolvedState = actionState?.(topic);
  const available = resolvedState ? resolvedState.available : true;
  const unavailableReason = !available ? resolvedState?.reason : undefined;
  const defaultCtaLabel = resolveTutorialAction(feature, {
    authenticated: true,
    featureImage2: true,
    microphone: true,
  }).label;
  const ctaLabel = resolvedState?.label?.trim() || defaultCtaLabel;

  const handleCopyExample = async () => {
    if (!topic.example) return;
    const ok = await copyTextSafe(topic.example);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1800);
  };

  return (
    <article
      ref={articleRef}
      data-topic-id={topicId}
      className="flex min-w-0 flex-col gap-6"
    >
      {/* 标题与简介 */}
      <header className="oc-surface-card rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent" size="sm" data-content-version={topic.contentVersion}>
            {categoryLabel(feature.category)}
          </Badge>
          <Badge tone="neutral" size="sm">
            {topic.steps.length} 个步骤
          </Badge>
        </div>

        <h2 className="mt-3 text-lg font-semibold leading-snug text-fg sm:text-xl">
          {feature.title}
        </h2>
        <p className="mt-2.5 text-body leading-relaxed text-muted">{topic.intro}</p>

        <div className="oc-surface-recessed mt-4 rounded-xl px-4 py-3">
          <div className="text-caption font-semibold text-accent">完成后你能</div>
          <p className="mt-1 text-body font-medium text-fg">{topic.outcome}</p>
          {topic.scenarios.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {topic.scenarios.map((scenario) => (
                <span
                  key={scenario}
                  className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-caption text-muted"
                >
                  {scenario}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* 操作步骤：严格保留 id / data-tutorial-step / tabIndex / aria-current */}
      <section aria-label="操作步骤" className="oc-surface-card rounded-2xl p-5 sm:p-6">
        <h3 className="text-title font-semibold text-fg">操作步骤</h3>
        <ol className="mt-4 flex flex-col gap-2.5">
          {topic.steps.map((step, index) => {
            const stepNo = index + 1;
            const isFocused =
              typeof stepNumber === "number" &&
              Number.isInteger(stepNumber) &&
              stepNumber === stepNo;
            return (
              <li
                key={step.title}
                id={`tutorial-step-${stepNo}`}
                data-tutorial-step={stepNo}
                tabIndex={-1}
                aria-current={isFocused ? "step" : undefined}
                className={cn(
                  "flex scroll-mt-4 gap-3.5 rounded-xl p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isFocused
                    ? "oc-callout oc-callout-info"
                    : "oc-surface-recessed",
                )}
              >
                <span
                  aria-hidden
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-semibold tabular-nums text-accent-fg"
                >
                  {stepNo}
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="text-section font-semibold text-fg">{step.title}</h4>
                  <p className="mt-1 text-body leading-relaxed text-muted">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* 示例话术一键复制 */}
      {topic.example && (
        <section
          aria-label="示例话术"
          className="oc-surface-card rounded-2xl p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-title font-semibold text-fg">
              <span className="oc-icon-badge oc-icon-badge-accent size-7 rounded-lg">
                <Quote size={14} aria-hidden />
              </span>
              可以直接参考的说法
            </h3>
            <Button
              variant="secondary"
              size="sm"
              shape="pill"
              onClick={() => void handleCopyExample()}
              className="min-h-11 sm:min-h-8"
            >
              {copied ? (
                <Check size={14} aria-hidden className="text-success" />
              ) : (
                <Copy size={14} aria-hidden />
              )}
              <span>{copied ? "已复制" : "复制示例"}</span>
            </Button>
          </div>
          <blockquote className="oc-surface-recessed mt-3.5 rounded-xl px-4 py-3 text-body leading-relaxed text-fg">
            {topic.example}
          </blockquote>
        </section>
      )}

      {/* 演示视频：默认 poster 轻封面按需点击播放，播放出错自动降级回 poster 截图 */}
      <section
        aria-label="界面演示"
        className="oc-surface-card overflow-hidden rounded-2xl"
      >
        <div className="relative aspect-video w-full bg-sidebar">
          {playingVideo && !videoFailed ? (
            <video
              key={media.video}
              controls
              autoPlay
              playsInline
              muted
              preload="metadata"
              poster={media.poster}
              aria-label={`${feature.shortTitle}演示视频`}
              onError={() => setVideoFailed(true)}
              className="h-full w-full object-cover"
            >
              <source src={media.video} type="video/webm; codecs=vp8" />
            </video>
          ) : (
            <div className="relative h-full w-full">
              <img
                src={media.poster}
                alt={media.caption}
                className="h-full w-full object-cover"
              />
              {videoFailed ? (
                <div className="oc-surface-glass absolute inset-x-3 bottom-3 rounded-xl px-3.5 py-2 text-meta text-fg">
                  演示视频暂不可播放，已显示同一功能截图。
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-bg/25">
                  <Button
                    variant="primary"
                    size="md"
                    shape="pill"
                    onClick={() => setPlayingVideo(true)}
                    className="min-h-11 shadow-pop"
                  >
                    <Play size={15} aria-hidden />
                    <span>播放界面演示</span>
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-4 py-3 text-caption text-faint">
          <p>{media.caption}</p>
          <Badge tone="success" size="sm">
            真实界面录制 · 脱敏示例
          </Badge>
        </div>
      </section>

      {/* 提示与注意事项 */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <section className="oc-callout oc-callout-info rounded-2xl p-4 sm:p-5">
          <h3 className="flex items-center gap-2 text-body font-semibold text-accent">
            <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md">
              <Lightbulb size={13} aria-hidden />
            </span>
            实用建议
          </h3>
          <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-meta leading-relaxed text-muted">
            {topic.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </section>

        <section className="oc-callout oc-callout-warning rounded-2xl p-4 sm:p-5">
          <h3 className="flex items-center gap-2 text-body font-semibold text-warning">
            <span className="oc-icon-badge oc-icon-badge-warning size-6 rounded-md">
              <TriangleAlert size={13} aria-hidden />
            </span>
            使用前留意
          </h3>
          <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-meta leading-relaxed text-muted">
            {topic.cautions.map((caution) => (
              <li key={caution}>{caution}</li>
            ))}
          </ul>
        </section>
      </div>

      {/* 真实功能直达 CTA */}
      <section
        aria-label="前往真实功能"
        className="oc-surface-card flex flex-col gap-4 rounded-2xl p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-title font-semibold text-fg">现在去真实功能里试一遍</h3>
          <p className="mt-1 text-meta text-muted">
            教程不会替你发送消息、修改设置或执行付费操作。
          </p>
          {unavailableReason && (
            <p
              role="status"
              className="oc-callout oc-callout-warning mt-2.5 inline-block rounded-lg px-3 py-1.5 text-meta text-warning"
            >
              {unavailableReason}
            </p>
          )}
        </div>
        <Button
          variant="accent"
          size="md"
          shape="pill"
          disabled={!available}
          onClick={() => onRunAction?.(topic)}
          className="min-h-11 shrink-0"
        >
          {ctaLabel}
          <ArrowRight size={15} aria-hidden />
        </Button>
      </section>

      {/* 相关能力跳转 */}
      {(() => {
        const visibleRelated = taskboardEnabled
          ? topic.related
          : topic.related.filter((relatedId) => relatedId !== "taskboard");
        if (visibleRelated.length === 0) return null;
        return (
          <section aria-label="相关能力" className="flex flex-col gap-2.5">
            <h3 className="text-section font-semibold text-fg">接着了解</h3>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {visibleRelated.map((relatedId) => {
                const related = capabilityById(relatedId);
                const RelatedIcon = FEATURE_ICONS[related.icon] ?? Sparkles;
                return (
                  <button
                    key={relatedId}
                    type="button"
                    onClick={() => onSelectTopic(relatedId)}
                    className="oc-surface-card oc-surface-card-hover oc-btn-tactile group flex min-h-11 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-meta font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="oc-icon-badge oc-icon-badge-accent size-7 shrink-0 rounded-lg">
                      <RelatedIcon size={14} strokeWidth={1.75} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{related.shortTitle}</span>
                    <ArrowRight
                      size={13}
                      aria-hidden
                      className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                    />
                  </button>
                );
              })}
            </div>
          </section>
        );
      })()}
    </article>
  );
}

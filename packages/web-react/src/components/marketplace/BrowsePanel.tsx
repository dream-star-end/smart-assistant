import {
  isMarketplaceCategoryId,
  marketplaceCategoryLabel,
} from "@openclaude/protocol/marketplaceTaxonomy";
import {
  ArrowUpCircle,
  BarChart3,
  Bot,
  Boxes,
  Code2,
  FileText,
  GraduationCap,
  Layers,
  type LucideIcon,
  PackageSearch,
  Palette,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsUp,
  TrendingUp,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { reportClientFriction } from "../../lib/clientFriction";
import {
  benchmarkBadgeLabel,
  formatInstallCount,
  groupCardsByCategory,
  marketAskAiPrefill,
  marketplaceArtifactKind,
  updateAvailable,
} from "../../lib/marketplace";
import type { AuthSession, MarketplaceCard, MarketplaceInstalled } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  cardVariants,
  EmptyState,
  IconButton,
  Input,
  ListSkeleton,
  type TabItem,
  Tabs,
} from "../ui";
import { DetailModal } from "./DetailModal";

/** 「未分类」兜底分区/筛选片的合成 id（不与任何 taxonomy id 冲突）。 */
const UNCAT = "__uncategorized__";

/** 目录每页条数。搜索/切类目时回到一页,点「加载更多」按页递增。 */
const PAGE_SIZE = 50;

/** 类目切换(与顶层 Tabs 同一套原语,不再是本页第三种横向控件)。value=存储层 kind。 */
const KIND_TABS: TabItem[] = [
  { value: "skill", label: "技能" },
  { value: "agent", label: "智能体" },
  { value: "connector", label: "插件" },
];

/**
 * 分类 → 图标。改造前每张卡都是同一个紫色 Sparkles,一屏 12 张卡就是 12 个一模一样的
 * 小方块,图标彻底失去扫读价值。按 taxonomy 分化后,用户能靠形状快速定位「这是做文档的
 * 还是写代码的」。未知分类回落 Sparkles(与旧行为一致)。
 */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  "office-docs": FileText,
  "data-analysis": BarChart3,
  "coding-dev": Code2,
  "research-academic": GraduationCap,
  "design-creative": Palette,
  "finance-business": TrendingUp,
  "daily-tools": Wrench,
  "skill-pack": Boxes,
};

/** 卡片左上角图标:智能体/插件按形态区分,技能按分类区分。 */
function cardIcon(card: MarketplaceCard): LucideIcon {
  const artifact = marketplaceArtifactKind(card);
  if (artifact === "agent") return Bot;
  if (artifact === "plugin") return Plug;
  return (card.category ? CATEGORY_ICON[card.category] : undefined) ?? Sparkles;
}

/** 分区图标:每个区头都有,不再只有「平台精选」一个有图标、其余光秃。 */
function sectionIcon(categoryId: string): LucideIcon {
  return CATEGORY_ICON[categoryId] ?? Layers;
}

/**
 * 单张目录卡片(分区视图与平铺视图共用,保证两处样式一致)。
 *
 * 固定三段式,保证同排卡片等高、信息位置恒定:
 *   ① 身份:图标 + 名称 + 安装态图标 + 两行描述;
 *   ② 标签:身份徽章(互斥取一)+ 分类 + 最多 2 个 tag,超出折成 +N;
 *   ③ 卡底信号行:评分 / 在用数 / 发布者自报评测,永远贴卡底(mt-auto)。
 * 改造前这里最多能同时出现 9 个徽章 + 一行评测徽记,评分位还用 ml-auto 在换行后到处漂。
 */
function CardTile({
  card,
  installed,
  onOpen,
}: {
  card: MarketplaceCard;
  installed: Map<string, MarketplaceInstalled>;
  onOpen: (slug: string) => void;
}) {
  const inst = card.preset ? undefined : installed.get(card.slug);
  const canUpdate = inst ? updateAvailable(inst) : false;
  const bench = benchmarkBadgeLabel(card.benchmark);
  // 使用信号(真实使用 > 安装):近30天有去重使用人数则以「30天 N 人在用」替代原
  // 安装数徽章位;否则沿用安装数「N 人在用」。缺字段(旧后端)两者皆无 → 不占位。
  const users30d = card.users30d ?? 0;
  const inUseLabel =
    users30d > 0
      ? `30天 ${formatInstallCount(users30d)} 人在用`
      : formatInstallCount(card.installCount)
        ? `${formatInstallCount(card.installCount)} 人在用`
        : null;
  // 评分:服务端已保证样本≥5 才非 null(前端不做二次阈值判断)。中性信号,诚实文案。
  const rating = card.rating ?? null;
  const ratingTotal = rating ? rating.up + rating.down : 0;
  // 卡片只在「已知分类」时渲染分类徽章 —— 未分类不占位不噪音(分区视图里区头已足够)。
  const catLabel = isMarketplaceCategoryId(card.category)
    ? marketplaceCategoryLabel(card.category)
    : null;
  // 身份徽章互斥取一:预设 > 官方已预装 > 官方 > 可更新。多个身份同时挂满整行是改造前
  // 卡高参差的主要来源,而它们表达的是同一件事「这条目由谁背书」。
  const identity = card.preset
    ? "预设 · 开箱即用"
    : card.preinstalled
      ? "官方 · 已预装"
      : card.official
        ? "官方"
        : canUpdate
          ? "可更新"
          : null;
  const trusted = Boolean(card.preset || card.preinstalled || card.official);
  const Icon = cardIcon(card);
  const tags = card.tags.slice(0, 2);
  const restTags = card.tags.length - tags.length;
  const stateLabel = canUpdate ? "有新版本" : inst ? "已安装" : null;
  // 整卡是一个 button:不给显式名的话,读屏会把描述+全部徽章+评分连读成几十字的按钮名。
  const ariaLabel = [card.name, catLabel, identity, stateLabel].filter(Boolean).join("，");
  const hasSignals = Boolean(rating || inUseLabel || bench);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(card.slug)}
        aria-label={ariaLabel}
        className={cn(
          cardVariants({ padding: "md", interactive: true }),
          "flex h-full w-full flex-col gap-2 bg-elevated text-left",
        )}
      >
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              trusted ? "bg-success-soft text-success" : "bg-accent-soft text-accent",
            )}
          >
            <Icon size={15} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-section font-semibold text-fg">{card.name}</span>
              {canUpdate ? (
                <ArrowUpCircle size={13} className="shrink-0 text-accent" aria-hidden="true" />
              ) : inst ? (
                <ShieldCheck size={13} className="shrink-0 text-success" aria-hidden="true" />
              ) : null}
            </div>
            {/* button 内只允许 phrasing content —— 原 <p> 属结构违规,换成 block span。 */}
            <span
              className="mt-0.5 line-clamp-2 block text-meta leading-snug text-muted"
              aria-hidden="true"
            >
              {card.description}
            </span>
          </div>
        </div>

        {(identity || catLabel || card.tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1" aria-hidden="true">
            {identity && (
              <Badge tone={trusted ? "success" : "accent"} size="sm">
                {identity}
              </Badge>
            )}
            {catLabel && (
              <Badge tone="info" size="sm">
                <Layers size={10} /> {catLabel}
              </Badge>
            )}
            {tags.map((t) => (
              <Badge key={t} tone="neutral" size="sm">
                {t}
              </Badge>
            ))}
            {restTags > 0 && (
              <Badge tone="neutral" size="sm">
                +{restTags}
              </Badge>
            )}
          </div>
        )}

        {hasSignals && (
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-caption text-faint">
            {rating && (
              // role=img + aria-label:样本量说明从桌面端才触发的原生 title 挪进无障碍名,
              // 触屏用户不再完全够不到它。
              <span
                role="img"
                aria-label={`好评 ${rating.up}/${ratingTotal}，来自 ${ratingTotal} 次真实使用的反馈`}
                className="inline-flex items-center gap-1"
              >
                <ThumbsUp size={11} aria-hidden="true" />
                {rating.up}/{ratingTotal}
              </span>
            )}
            {inUseLabel && (
              <span className="inline-flex items-center gap-1">
                <Users size={11} aria-hidden="true" />
                {inUseLabel}
              </span>
            )}
            {/* 评测徽记:免责不能只靠 hover —— 「· 自报」直接进可见文案,完整口径进无障碍名。 */}
            {bench && (
              <span
                role="img"
                aria-label={`${bench.label}（${bench.title}）`}
                className="inline-flex min-w-0 items-center gap-1 truncate"
              >
                {bench.label} · 自报
              </span>
            )}
          </div>
        )}
      </button>
    </li>
  );
}

/** 区头:overline 级结构标签 + 计数 + 分隔线,与卡片标题拉开两档,分区不再塌平。 */
function Section({
  title,
  blurb,
  count,
  icon: Icon,
  iconClassName,
  cards,
  installed,
  onOpen,
}: {
  title: string;
  blurb?: string;
  count: number;
  icon: LucideIcon;
  iconClassName?: string;
  cards: MarketplaceCard[];
  installed: Map<string, MarketplaceInstalled>;
  onOpen: (slug: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <div className="flex items-center gap-1.5">
          <Icon size={13} className={cn("shrink-0 text-faint", iconClassName)} aria-hidden="true" />
          <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-muted">
            {title}
          </h3>
          <Badge tone="neutral" size="sm">
            {count}
          </Badge>
        </div>
        {/* 分区说明在窄屏隐藏:每个分区多一行就多吃 16px,而 390px 屏上光是必需控件
            (Tabs/类目/搜索/分类片)已经占掉近一半高度。 */}
        {blurb && <p className="mt-1 hidden line-clamp-1 text-caption text-faint sm:block">{blurb}</p>}
        <div className="mt-1.5 h-px bg-border" />
      </div>
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {cards.map((c) => (
          <CardTile key={c.slug} card={c} installed={installed} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/**
 * 发现：kind 切换 + 搜索 + 目录卡片。
 * - 有查询词 → 平铺相关度列表（服务端排序权威，卡片加分类徽章）。
 * - 空查询 → 分区视图（平台精选 → 按 taxonomy 顺序的分类分区 → 未分类兜底），
 *   顶部一行可横向滚动的分类筛选片；选中某类后平铺该类。**信任服务端顺序**，
 *   前端只做纯分组，不再自行按热度重排。
 * 已安装/可更新的条目打徽标；点击卡片打开详情/安装确认。
 *
 * ── 2026-07-26 门面改造 ───────────────────────────────────────────────────
 * · kind 切换从壳层下沉到这里,与搜索框共用一条 sticky 头带(滚动时类目上下文不丢);
 * · 目录不再硬截断在 50 条:limit 进 state + 底部「加载更多」+ 总数提示;
 * · 精选卡在下方分类区去重(同一张卡在一屏里出现两次是改造前最真实的困惑源);
 * · 静默校准失败不再弹红条,只在头带留一个可点的重试;
 * · AI 导购入口常驻,并进两个空态。
 */
export function BrowsePanel({
  auth,
  kind = "skill",
  onKindChange,
  revision = 0,
  focusRequest,
  onFocusRequestConsumed,
  onAskAiInChat,
  onCreateInChat,
  onGoPublish,
  onOpenConnectors,
}: {
  auth: AuthSession;
  /** 仅展示该类目（存储层 kind；connector 在产品层显示为「插件」）。 */
  kind?: "skill" | "agent" | "connector";
  /** 类目切换回调。缺省则不渲染类目 Tabs(状态权威在壳层 MarketplaceCenter)。 */
  onKindChange?: (kind: "skill" | "agent" | "connector") => void;
  /** 审核状态转为终态时递增；即使查询词/kind 未变也重新拉市场目录。 */
  revision?: number;
  /** 审核通过通知的 CTA：切到对应分类并直接打开新条目详情。 */
  focusRequest?: { slug: string; nonce: number } | null;
  /** focusRequest 是一次性命令；详情打开后通知父层清除，避免重新挂载时重复执行。 */
  onFocusRequestConsumed?: (nonce: number) => void;
  /** AI 导购入口(批3):常驻头带 + 空态出口;缺省则不渲染入口。 */
  onAskAiInChat?: (text: string) => void;
  /** 空目录时的出口:在对话里现场做一个。 */
  onCreateInChat?: () => void;
  /** 空目录时的出口:去发布自己的作品。 */
  onGoPublish?: () => void;
  onOpenConnectors?: (pluginSlug?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<MarketplaceCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 静默校准失败(用户没点任何东西)—— 不弹红条,只在头带留一个重试。 */
  const [stale, setStale] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [installed, setInstalled] = useState<Map<string, MarketplaceInstalled>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [reloadInstalled, setReloadInstalled] = useState(0);
  /** 选中的分类筛选片(null=全部/分区视图;taxonomy id 或 UNCAT=平铺该类)。 */
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  // 防抖搜索
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRequestSeq = useRef(0);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  // 切换 kind 或进入搜索态时,清掉分类选择并回到第一页(避免停留在一个空/不相关的筛选片,
  // 也避免上一个类目翻了 3 页的 limit 被带进新类目)。
  useEffect(() => {
    setSelectedCat(null);
    setLimit(PAGE_SIZE);
  }, [kind, debouncedQ]);

  const loadCards = useCallback(
    async (showLoading: boolean) => {
      const seq = ++cardRequestSeq.current;
      if (showLoading) {
        setLoading(true);
        setErr(null);
      }
      try {
        const result = await api.searchMarketplace(auth, debouncedQ, kind, limit);
        if (seq !== cardRequestSeq.current) return;
        if (result.results.length > 0) {
          reportClientFriction(
            {
              surface: "marketplace",
              stage: "catalog_exposure",
              code: "CATALOG_EXPOSURE",
              outcome: "succeeded",
            },
            auth.snapshot().token,
          );
        }
        // 信任服务端顺序:目录态已按 featured_rank/热度排好,搜索态是相关度排序。
        setCards(result.results);
        setErr(null);
        setStale(false);
      } catch (cause) {
        if (seq !== cardRequestSeq.current) return;
        // 用户主动触发的加载才报错;窗口重新聚焦时的静默校准失败只留轻量标记 ——
        // 「什么都没点却跳出一条红色报错」是改造前最打扰的一处。
        if (showLoading) setErr(apiErrorMessage(cause, "加载市场失败"));
        else setStale(true);
      } finally {
        if (seq === cardRequestSeq.current) setLoading(false);
      }
    },
    [auth, debouncedQ, kind, limit],
  );

  // revision 变化=别人刚发布/下架触发的后台校准,不是本人的动作 —— 走静默路径,
  // 失败也不该在安静浏览的用户面前弹红条。用户自己的动作(首次进入/改查询词/切类目/
  // 翻页/点重试)才走显式加载。
  const lastRevision = useRef(revision);
  useEffect(() => {
    const backgroundSync = lastRevision.current !== revision;
    lastRevision.current = revision;
    void loadCards(!backgroundSync);
    return () => {
      cardRequestSeq.current += 1;
    };
  }, [loadCards, revision]);

  // 市场可能在另一个页签完成发布审核；回到窗口/标签页时主动校准目录。
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "hidden") void loadCards(false);
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [loadCards]);

  useEffect(() => {
    if (!focusRequest) return;
    setActive(focusRequest.slug);
    onFocusRequestConsumed?.(focusRequest.nonce);
  }, [focusRequest, onFocusRequestConsumed]);

  // 拉一次「我的已安装」用于卡片徽标（含版本信息 → 可更新徽标）
  useEffect(() => {
    let alive = true;
    api
      .listMarketplaceInstalled(auth)
      .then((rows) => alive && setInstalled(new Map(rows.map((r) => [r.slug, r]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth, reloadInstalled]);

  const onInstalled = useCallback(() => setReloadInstalled((n) => n + 1), []);

  const noun = kind === "agent" ? "智能体" : kind === "connector" ? "插件" : "技能";
  /** 首次加载(还没有任何数据)才铺骨架;刷新/翻页保留旧列表,只压暗。 */
  const firstLoad = loading && cards === null;
  const empty = !loading && !!cards && cards.length === 0;
  /** 本页已装满 → 服务端可能还有更多(响应体没有 total,只能用「装满即可能有」判定)。 */
  const truncated = !!cards && cards.length >= limit;

  // 分区视图仅在浏览态(空查询)构建;搜索态走平铺相关度列表。
  const grouped = useMemo(
    () => (!debouncedQ && cards ? groupCardsByCategory(cards) : null),
    [debouncedQ, cards],
  );

  /**
   * 分区视图去重:精选卡不再在下方所属分类区重复出现。
   * 改造前同一张卡会在「平台精选」和「办公文档」各出现一次,用户第一反应是
   * 「为什么同一个东西有两个」。分类筛选片(平铺态)仍展示该分类的全部成员,
   * 所以「分类真实成员数」这件事没有丢。
   */
  const sections = useMemo(() => {
    if (!grouped) return null;
    const featuredSlugs = new Set(grouped.featured.map((c) => c.slug));
    const categories = grouped.categories
      .map((c) => ({ ...c, cards: c.cards.filter((x) => !featuredSlugs.has(x.slug)) }))
      .filter((c) => c.cards.length > 0);
    const uncategorized = grouped.uncategorized.filter((x) => !featuredSlugs.has(x.slug));
    return { featured: grouped.featured, categories, uncategorized };
  }, [grouped]);

  // 当前平铺(chips 选中某类,或搜索态)的卡片集。
  const flatCards = useMemo(() => {
    if (debouncedQ) return cards ?? [];
    if (!grouped || selectedCat === null) return [];
    if (selectedCat === UNCAT) return grouped.uncategorized;
    return grouped.categories.find((c) => c.id === selectedCat)?.cards ?? [];
  }, [debouncedQ, cards, grouped, selectedCat]);

  const flatMode = Boolean(debouncedQ) || selectedCat !== null;
  const flatTitle = debouncedQ
    ? `“${debouncedQ}” 的结果`
    : selectedCat === UNCAT
      ? "未分类"
      : (grouped?.categories.find((c) => c.id === selectedCat)?.label ?? noun);

  const askAi = () =>
    onAskAiInChat?.(
      marketAskAiPrefill(debouncedQ || `帮我看看市场里有什么适合我的${noun}`),
    );

  return (
    <div className="flex flex-col">
      {/* 一条 sticky 头带承载「看哪一类 + 搜什么 + 让 AI 帮挑」:改造前 kind pill 在
          sticky 搜索框上方且不吸顶,一滚动就只剩一个孤零零的搜索框。 */}
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 bg-surface px-4 pb-2 pt-2.5 sm:flex-row sm:items-center sm:gap-2.5">
        {onKindChange && (
          <Tabs
            aria-label="市场类型"
            value={kind}
            onValueChange={(v) => onKindChange(v as "skill" | "agent" | "connector")}
            items={KIND_TABS}
            className="shrink-0 self-start sm:self-auto"
          />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              // type=search 让浏览器给出原生清除按钮(与 ui/Toolbar 同一取舍:自绘 ✕ 在触屏上
              // 要占满 44px,会把输入框撑破)。aria-label 保证有值后仍有可访问名。
              type="search"
              aria-label={`搜索${noun}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={
                kind === "agent"
                  ? "搜索智能体（试试「写作」「编程」「研究」）…"
                  : kind === "connector"
                    ? "搜索插件（试试「文档」「代码」「沟通」）…"
                    : "搜索技能（试试「翻译」「论文」「写作」）…"
              }
              className="pl-9"
            />
          </div>
          {stale && (
            <IconButton
              aria-label="同步失败，点击重试"
              size="sm"
              className="shrink-0 text-warning hover:text-warning"
              onClick={() => void loadCards(true)}
            >
              <RefreshCw size={14} />
            </IconButton>
          )}
          {onAskAiInChat && (
            <Button size="sm" variant="ghost" className="shrink-0" onClick={askAi}>
              <Sparkles size={14} className="text-accent" aria-hidden="true" /> AI 帮我挑
            </Button>
          )}
        </div>
      </div>

      {/* 分类筛选片:仅浏览态且有分区时渲染,一行可横向滚动(移动端不换行)。
          右缘渐隐替代改造前那行「左右滑动查看更多分类」的常驻小字 —— 可滚动这件事
          应该由视觉暗示,而不是占一行去讲。 */}
      {grouped && (grouped.categories.length > 0 || grouped.uncategorized.length > 0) && (
        <div className="relative">
          <section
            aria-label="市场分类，可横向滚动"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动分类必须可由键盘聚焦和滚动。
            tabIndex={0}
            className="flex snap-x scroll-px-4 gap-1.5 overflow-x-auto px-4 pb-2 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-scrollbar]:hidden"
          >
            <Chip active={selectedCat === null} onClick={() => setSelectedCat(null)}>
              全部
            </Chip>
            {grouped.categories.map((c) => (
              <Chip key={c.id} active={selectedCat === c.id} onClick={() => setSelectedCat(c.id)}>
                {c.label}
              </Chip>
            ))}
            {grouped.uncategorized.length > 0 && (
              <Chip active={selectedCat === UNCAT} onClick={() => setSelectedCat(UNCAT)}>
                未分类
              </Chip>
            )}
          </section>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent"
          />
        </div>
      )}

      {err && (
        <div className="px-4 pb-2">
          <Alert
            tone="danger"
            density="compact"
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadCards(true)}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      )}

      {firstLoad ? (
        <ListSkeleton variant="card" rows={4} className="px-4 pb-5" />
      ) : empty ? (
        debouncedQ ? (
          <EmptyState
            icon={PackageSearch}
            title={`没有匹配的${noun}`}
            hint="换个关键词，或让 AI 在对话里按你的场景现场找。"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {onAskAiInChat && (
                  <Button size="sm" variant="accent" onClick={askAi}>
                    <Sparkles size={14} aria-hidden="true" /> 让 AI 帮我找
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => setQ("")}>
                  清空搜索
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState
            icon={PackageSearch}
            title={`市场还没有上架的${noun}`}
            hint="你可以让 AI 现场帮你做一个，也可以把自己的作品发布上来。"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {onCreateInChat && (
                  <Button size="sm" variant="accent" onClick={onCreateInChat}>
                    <Sparkles size={14} aria-hidden="true" /> 让 AI 帮我做一个
                  </Button>
                )}
                {onGoPublish && (
                  <Button size="sm" variant="secondary" onClick={onGoPublish}>
                    去发布
                  </Button>
                )}
              </div>
            }
          />
        )
      ) : cards && cards.length > 0 ? (
        // 刷新/翻页时保留旧列表(只压暗),不再整片闪成骨架把滚动位置打乱。
        <div
          aria-busy={loading || undefined}
          className={cn("flex flex-col", loading && "opacity-60 transition-opacity")}
        >
          {/* 结果条:平铺态给「在看哪一类/搜了什么 + 命中数 + 返回全部」,分区态给总数。
              窄屏在不必要时(分区态且没有更多可加载)让出这 21px —— 分区计数已在各区头。 */}
          <div
            className={cn(
              "flex items-center gap-2 px-4 pb-2",
              !flatMode && !truncated && "hidden sm:flex",
            )}
          >
            {flatMode ? (
              <>
                <h3 className="min-w-0 truncate text-caption font-semibold uppercase tracking-[0.06em] text-muted">
                  {flatTitle}
                </h3>
                <Badge tone="neutral" size="sm">
                  {flatCards.length}
                </Badge>
              </>
            ) : (
              <p className="text-caption text-faint">
                共 {cards.length} 个{noun}
                {truncated ? "（可继续加载更多）" : ""}
              </p>
            )}
            {selectedCat !== null && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto shrink-0"
                onClick={() => setSelectedCat(null)}
              >
                返回全部
              </Button>
            )}
          </div>

          {sections && selectedCat === null ? (
            // 分区视图:平台精选 → 各分类分区 → 未分类兜底
            <div className="flex flex-col gap-5 px-4 pb-5">
              {sections.featured.length > 0 && (
                <Section
                  title="平台精选"
                  blurb={`平台为你挑选的优质${noun}`}
                  count={sections.featured.length}
                  icon={Star}
                  iconClassName="text-accent"
                  cards={sections.featured}
                  installed={installed}
                  onOpen={setActive}
                />
              )}
              {sections.categories.map((c) => (
                <Section
                  key={c.id}
                  title={c.label}
                  blurb={c.blurb}
                  count={c.cards.length}
                  icon={sectionIcon(c.id)}
                  cards={c.cards}
                  installed={installed}
                  onOpen={setActive}
                />
              ))}
              {sections.uncategorized.length > 0 && (
                <Section
                  title="未分类"
                  blurb="暂未归类的条目"
                  count={sections.uncategorized.length}
                  icon={Layers}
                  cards={sections.uncategorized}
                  installed={installed}
                  onOpen={setActive}
                />
              )}
            </div>
          ) : (
            // 平铺视图:搜索相关度列表,或选中某个分类筛选片
            <ul className="grid grid-cols-1 gap-2.5 px-4 pb-5 sm:grid-cols-2">
              {flatCards.map((c) => (
                <CardTile key={c.slug} card={c} installed={installed} onOpen={setActive} />
              ))}
            </ul>
          )}

          {/* 目录不再硬截断:装满一页就给出口,否则第 51 个商品对用户等于不存在。 */}
          {truncated && (
            <div className="px-4 pb-5">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                loading={loading}
                onClick={() => setLimit((n) => n + PAGE_SIZE)}
              >
                加载更多
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <DetailModal
        slug={active}
        auth={auth}
        installed={active ? installed.get(active) : undefined}
        onClose={() => setActive(null)}
        onInstalled={onInstalled}
        onAskAiInChat={onAskAiInChat}
        onOpenConnectors={onOpenConnectors}
      />
    </div>
  );
}

/** 分类筛选片(可横向滚动行内的单个 pill;选中态高亮)。 */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // 触控靶:这排 chip 在横向滚动条里,26px 高时手指几乎点不中(要么误触邻项、要么触发横滑)。
        "shrink-0 snap-start whitespace-nowrap rounded-full border px-3 py-1 text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-4",
        active
          ? "border-accent/50 bg-accent-soft text-accent"
          : "border-border text-muted hover:border-accent/40 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

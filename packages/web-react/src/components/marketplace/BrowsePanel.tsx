import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol/browser";
import { Check, PackageSearch, RefreshCw, Search, Sparkles, ThumbsUp, Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { reportClientFrictionBatch } from "../../lib/clientFriction";
import {
  benchmarkBadgeLabel,
  cardBlurb,
  formatInstallCount,
  groupCardsByCategory,
  marketAskAiPrefill,
  marketplaceArtifactKind,
  updateAvailable,
} from "../../lib/marketplace";
import type { PluginEntry } from "../../lib/pluginDirectory";
import { pluginMatchesQuery } from "../../lib/pluginDirectory";
import type { AuthSession, MarketplaceCard, MarketplaceInstalled } from "../../lib/types";
import type { SemanticTone } from "../../lib/ui/statusTone";
import { usePluginDirectory } from "../../lib/usePluginDirectory";
import { cn } from "../../lib/utils";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  Input,
  ListSkeleton,
  StatusPill,
  type TabItem,
  Tabs,
  useToast,
} from "../ui";
import { BUILTIN_PLUGIN_CATEGORY, CardMark } from "./CardMark";
import { DetailModal } from "./DetailModal";

/** 「未分类」兜底分区/筛选片的合成 id（不与任何 taxonomy id 冲突）。 */
const UNCAT = "__uncategorized__";

/** 目录每页条数。搜索/切类目时回到一页,点「加载更多」按页递增。 */
const PAGE_SIZE = 50;

/**
 * 分类片容器只在 `sm` 以下横向滚动(与 className 里的 `sm:overflow-x-visible` 同一断点)。
 * 横滚区要能被键盘聚焦才能用方向键滚,所以窄屏给 tabIndex=0;桌面端 K-12 之后是换行、
 * 不滚,再留 tabIndex 就成了一个什么都不做的 Tab 停靠点(QA t-1028 §6 #1)。
 * 写法照 hooks/useMdViewport.ts;jsdom / SSR 默认 false(= 桌面,不给 tabIndex)。
 */
const NARROW_QUERY = "(max-width: 639px)";
function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function getNarrowSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}
function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrowSnapshot, () => false);
}

type BrowseKind = "skill" | "agent" | "connector";

/** 类目切换(与顶层 Tabs 同一套原语,不再是本页第三种横向控件)。value=存储层 kind。 */
const KIND_TABS: TabItem[] = [
  { value: "skill", label: "技能" },
  { value: "agent", label: "智能体" },
  { value: "connector", label: "插件" },
];

/**
 * 「试试」并进搜索框占位词(UI-5):改造前它是搜索框下面单独一行芯片,和分类筛选叠成两行
 * 筛选(UI-SPEC §1.3 M6)。
 */
const SEARCH_EXAMPLES: Record<BrowseKind, string> = {
  skill: "「翻译」「论文」",
  agent: "「写作」「编程」",
  connector: "「文档」「代码」",
};

/** 卡片网格:手机单列,平板两列,桌面三列。分区视图与平铺视图共用。 */
const GRID = "marketplace-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

function builtinPluginCard(entry: PluginEntry): MarketplaceCard {
  return {
    slug: entry.slug,
    kind: "connector",
    artifactKind: "plugin",
    name: entry.label,
    description: entry.description,
    tags: [],
    preinstalled: true,
    official: true,
    category: entry.category ?? BUILTIN_PLUGIN_CATEGORY[entry.slug] ?? "daily-tools",
  };
}

/** 插件目录的色调 → 状态语义色调(lib/ui/statusTone):已连接 = 完成色,需重新授权 = 失败色。 */
const PLUGIN_TONE: Record<PluginEntry["tone"], SemanticTone> = {
  success: "done",
  warning: "attention",
  danger: "failed",
  neutral: "idle",
};

/** 卡片主按钮:没连上的插件「连接」、有新版本「更新」、没装的「安装」,其余「已安装」。 */
type CardAction = "connect" | "update" | "install" | "installed";
const ACTION_LABEL: Record<CardAction, string> = {
  connect: "连接",
  update: "更新",
  install: "安装",
  installed: "已安装",
};
/** 主按钮的外观。卡片里的那枚是整卡按钮的一部分(点它和点卡片是同一件事),只画样子不另设焦点。 */
const ACTION_CLASS =
  "inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-surface px-3 text-body font-medium text-fg transition-colors group-hover:border-border-strong";

/**
 * 单张目录卡片(分区视图与平铺视图共用)。UI-5 之后只留四样东西:
 *   ① 识别标:按分类着色的首字方块(不再是一屏同款插头 / 星芒图标);
 *   ② 名字 + 一句人话描述(插件的凭据说明留给详情页,见 lib/marketplace cardBlurb);
 *   ③ 一行安静的元信息:插件连接状态(StatusPill)、评分、在用人数、发布者自报评测;
 *   ④ 主按钮:连接 / 更新 / 安装 / 已安装。
 * 分类、标签徽章不再上卡:分区标题和首字方块的颜色已经说明分类。
 */
function CardTile({
  card,
  installed,
  plugins,
  onOpen,
  onConnect,
}: {
  card: MarketplaceCard;
  installed: Map<string, MarketplaceInstalled>;
  /** 插件目录(slug → 状态);只在「插件」类目传入。 */
  plugins?: Map<string, PluginEntry>;
  onOpen: (slug: string) => void;
  /** 市场插件装了还没连账号时,主按钮直接去管理中心连接(不经过详情页)。 */
  onConnect?: (slug: string) => void;
}) {
  const inst = card.preset ? undefined : installed.get(card.slug);
  const canUpdate = inst ? updateAvailable(inst) : false;
  const bench = benchmarkBadgeLabel(card.benchmark);
  // 使用信号(真实使用 > 安装):近30天有去重使用人数则以「30天 N 人在用」替代安装数;
  // 否则如实展示「N 次安装」，不把安装量冒充活跃人数。缺字段(旧后端)两者皆无 → 不占位。
  const users30d = card.users30d ?? 0;
  const inUseLabel =
    users30d > 0
      ? `30天 ${formatInstallCount(users30d)} 人在用`
      : formatInstallCount(card.installCount)
        ? `${formatInstallCount(card.installCount)} 次安装`
        : null;
  // 评分:服务端已保证样本≥5 才非 null(前端不做二次阈值判断)。中性信号,诚实文案。
  const rating = card.rating ?? null;
  const ratingTotal = rating ? rating.up + rating.down : 0;
  const catLabel = isMarketplaceCategoryId(card.category)
    ? marketplaceCategoryLabel(card.category)
    : null;
  // 身份互斥取一:预设 > 官方已预装 > 官方 > 可更新。只进读屏名,卡面只留一个「官方 / 预设」小字。
  const identity = card.preset
    ? "预设 · 开箱即用"
    : card.preinstalled
      ? "官方 · 已预装"
      : card.official
        ? "官方"
        : canUpdate
          ? "可更新"
          : null;
  const trustMark = card.preset ? "预设" : card.preinstalled || card.official ? "官方" : null;
  // 插件卡:状态以插件目录为准(已连接 / 未连接 / 需重新授权),与管理中心同一判据;
  // 有新版本仍优先提示更新。目录读不到时退回原来的「已安装」。
  const plugin = plugins?.get(card.slug);
  const pluginState = plugin && !canUpdate ? plugin : null;
  const stateLabel = canUpdate ? "有新版本" : pluginState ? pluginState.stateLabel : inst ? "已安装" : null;
  const action: CardAction =
    pluginState?.state === "needs-connect"
      ? "connect"
      : canUpdate
        ? "update"
        : inst || card.preset || card.preinstalled || pluginState
          ? "installed"
          : "install";
  // 预装插件点整卡就去管理中心,不需要第二个按钮;市场插件点整卡开详情,「连接」得是单独的按钮。
  const connectHere = action === "connect" && onConnect && !card.preinstalled ? onConnect : null;
  const isPlugin = marketplaceArtifactKind(card) === "plugin";
  // 整卡是一个 button:不给显式名的话,读屏会把描述+全部徽章+评分连读成几十字的按钮名。
  // 描述走 aria-describedby(而不是 aria-hidden):名字短、描述仍可听 —— 它是装不装的主要依据。
  const ariaLabel = [card.name, catLabel, identity, stateLabel].filter(Boolean).join("，");
  const descId = useId();
  const showState = Boolean(pluginState || canUpdate);
  const hasMeta = Boolean(showState || rating || inUseLabel || bench);

  return (
    <li className="relative min-w-0">
      <button
        type="button"
        onClick={() => onOpen(card.slug)}
        aria-label={ariaLabel}
        aria-describedby={descId}
        data-category={card.category ?? "general"}
        className="marketplace-card group flex h-full w-full items-center gap-3 rounded-md border border-border bg-surface p-4 text-left outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardMark name={card.name} category={card.category} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="marketplace-card-name truncate text-body font-semibold text-fg">{card.name}</span>
            {trustMark && <span className="shrink-0 text-caption text-faint">{trustMark}</span>}
          </span>
          <span id={descId} className="marketplace-card-description line-clamp-2 text-meta text-muted">
            {cardBlurb(card.description, isPlugin)}
          </span>
          {hasMeta && (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-faint">
              {showState && (
                <StatusPill
                  variant="pill"
                  tone={canUpdate || !pluginState ? "idle" : PLUGIN_TONE[pluginState.tone]}
                  label={stateLabel ?? undefined}
                  data-testid={pluginState ? "plugin-state" : undefined}
                  className="text-caption"
                />
              )}
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
            </span>
          )}
        </span>
        {action === "installed" ? (
          <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-meta text-faint">
            <Check size={13} strokeWidth={1.75} />
            {ACTION_LABEL.installed}
          </span>
        ) : (
          // 有单独「连接」按钮时这里只占位,保证文字列宽度不变。
          <span aria-hidden="true" className={cn(ACTION_CLASS, connectHere && "invisible")}>
            {ACTION_LABEL[action]}
          </span>
        )}
      </button>
      {connectHere && (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`连接「${card.name}」`}
          onClick={() => connectHere(card.slug)}
          className="absolute right-4 top-1/2 -translate-y-1/2"
        >
          {ACTION_LABEL.connect}
        </Button>
      )}
    </li>
  );
}

/** 区头:标题 + 计数 + 一句说明(桌面),标题和卡片名拉开一档,不再挂图标和徽章。 */
function Section({
  title,
  blurb,
  count,
  truncated,
  cards,
  installed,
  plugins,
  onOpen,
  onConnect,
}: {
  title: string;
  blurb?: string;
  count: number;
  /** 目录只拉了一页:分区计数只是"已加载"的成员数,不能当"共有"说(K-03)。 */
  truncated?: boolean;
  cards: MarketplaceCard[];
  installed: Map<string, MarketplaceInstalled>;
  plugins?: Map<string, PluginEntry>;
  onOpen: (slug: string) => void;
  onConnect?: (slug: string) => void;
}) {
  return (
    <section className="marketplace-section flex flex-col gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="shrink-0 text-section font-semibold text-fg">{title}</h3>
        <span className="shrink-0 text-meta tabular-nums text-faint">{truncated ? `已加载 ${count}` : count}</span>
        {truncated && <span className="shrink-0 text-caption text-faint">还有更多未加载</span>}
        {/* 分区说明在窄屏隐藏:每个分区多一行就多吃 16px。 */}
        {blurb && <p className="hidden min-w-0 truncate text-caption text-faint sm:block">{blurb}</p>}
      </div>
      <ul className={GRID}>
        {cards.map((c) => (
          <CardTile
            key={c.slug}
            card={c}
            installed={installed}
            plugins={plugins}
            onOpen={onOpen}
            onConnect={onConnect}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * 发现：kind 切换 + 搜索 + 目录卡片。
 * - 有查询词 → 平铺相关度列表（服务端排序权威）。
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
 *
 * ── 2026-10-29 UI-5「素净工作台」 ──────────────────────────────────────────
 * · 删掉 hero、英文小字和自带的纸色调色板(marketplace.css),全部改用主 token;
 * · 「试试」芯片并进搜索框占位词,分类筛选只剩一行;
 * · 卡片换成首字方块 + 一句人话 + 状态 + 主按钮(见 CardTile)。
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
  kind?: BrowseKind;
  /** 类目切换回调。缺省则不渲染类目 Tabs(状态权威在壳层 MarketplaceCenter)。 */
  onKindChange?: (kind: BrowseKind) => void;
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
  const toast = useToast();
  const narrow = useNarrowViewport();
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
  const reportedExposureSlugs = useRef(new Set<string>());
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

  /** 本次加载是不是「加载更多」触发的:失败要就近报（toast + 重试），而不是写到列表顶部的红条。 */
  const loadMoreRef = useRef(false);

  // 显式标注类型:回调体内部要引用 loadCards 自己(失败 toast 的「重试」),否则类型推断成环。
  const loadCards: (showLoading: boolean) => Promise<void> = useCallback(
    async (showLoading: boolean) => {
      const seq = ++cardRequestSeq.current;
      const fromLoadMore = loadMoreRef.current;
      loadMoreRef.current = false;
      if (showLoading) {
        setLoading(true);
        setErr(null);
      }
      try {
        const result = await api.searchMarketplace(auth, debouncedQ, kind, limit);
        if (seq !== cardRequestSeq.current) return;
        // 信任服务端顺序:目录态已按 featured_rank/热度排好,搜索态是相关度排序。
        setCards(result.results);
        setErr(null);
        setStale(false);
      } catch (cause) {
        if (seq !== cardRequestSeq.current) return;
        // 用户主动触发的加载才报错;窗口重新聚焦时的静默校准失败只留轻量标记 ——
        // 「什么都没点却跳出一条红色报错」是改造前最打扰的一处。
        if (fromLoadMore) {
          // 用户此刻在列表底部,顶部的 Alert 早已滚出视口(K-05):toast 带重试就近可见。
          toast(apiErrorMessage(cause, "加载更多失败"), "error", {
            actionLabel: "重试",
            onAction: () => {
              loadMoreRef.current = true;
              void loadCards(true);
            },
          });
        } else if (showLoading) setErr(apiErrorMessage(cause, "加载市场失败"));
        else setStale(true);
      } finally {
        if (seq === cardRequestSeq.current) setLoading(false);
      }
    },
    [auth, debouncedQ, kind, limit, toast],
  );

  const loadMore = () => {
    loadMoreRef.current = true;
    setLimit((n) => n + PAGE_SIZE);
  };

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

  // 插件类目叠加插件目录:状态徽标 + 并入内置插件。只叠加、不替代市场搜索 —— 未安装的市场插件
  // 仍只来自搜索结果;目录读不到时卡片照常渲染,只是没有状态(OCV5-379 方案审查 r1)。
  const pluginsOn = kind === "connector";
  const directory = usePluginDirectory(auth, pluginsOn, reloadInstalled);
  const pluginBySlug = useMemo(
    () => (pluginsOn && directory ? new Map(directory.map((e) => [e.slug, e])) : undefined),
    [pluginsOn, directory],
  );
  const builtinCards = useMemo<MarketplaceCard[]>(() => {
    // 没有「去管理中心」出口时不并入:内置插件没有市场详情可开。
    if (!pluginsOn || !directory || !cards || !onOpenConnectors) return [];
    const listed = new Set(cards.map((c) => c.slug));
    return directory
      .filter((e) => e.origin === "builtin" && !listed.has(e.slug) && pluginMatchesQuery(e, debouncedQ))
      .map(builtinPluginCard);
  }, [pluginsOn, directory, cards, onOpenConnectors, debouncedQ]);
  const builtinSlugs = useMemo(() => new Set(builtinCards.map((c) => c.slug)), [builtinCards]);
  /** 实际展示的卡片 = 市场搜索结果 + 内置插件。翻页判断(truncated)与曝光上报只看市场结果。 */
  const shownCards = useMemo(
    () => (cards && builtinCards.length > 0 ? [...cards, ...builtinCards] : cards),
    [cards, builtinCards],
  );
  const openCard = useCallback(
    (slug: string) => {
      if (builtinSlugs.has(slug) && onOpenConnectors) onOpenConnectors(slug);
      else setActive(slug);
    },
    [builtinSlugs, onOpenConnectors],
  );

  const noun = kind === "agent" ? "智能体" : kind === "connector" ? "插件" : "技能";
  /** 首次加载(还没有任何数据)才铺骨架;刷新/翻页保留旧列表,只压暗。 */
  const firstLoad = loading && cards === null;
  const empty = !loading && !!shownCards && shownCards.length === 0;
  /** 本页已装满 → 服务端可能还有更多(响应体没有 total,只能用「装满即可能有」判定)。 */
  const truncated = !!cards && cards.length >= limit;

  // 分区视图仅在浏览态(空查询)构建;搜索态走平铺相关度列表。
  const grouped = useMemo(
    () => (!debouncedQ && shownCards ? groupCardsByCategory(shownCards) : null),
    [debouncedQ, shownCards],
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
    if (debouncedQ) return shownCards ?? [];
    if (!grouped || selectedCat === null) return [];
    if (selectedCat === UNCAT) return grouped.uncategorized;
    return grouped.categories.find((c) => c.id === selectedCat)?.cards ?? [];
  }, [debouncedQ, shownCards, grouped, selectedCat]);

  const flatMode = Boolean(debouncedQ) || selectedCat !== null;
  const exposedCards = useMemo(() => {
    if (!cards) return [];
    const shown = flatMode
      ? flatCards
      : !sections
        ? cards
        : [
            ...sections.featured,
            ...sections.categories.flatMap((section) => section.cards),
            ...sections.uncategorized,
          ];
    // 内置插件不是市场条目,不进目录曝光统计。
    return builtinSlugs.size > 0 ? shown.filter((c) => !builtinSlugs.has(c.slug)) : shown;
  }, [cards, flatCards, flatMode, sections, builtinSlugs]);

  // Cohort 必须按同一 user + skill 关联；只记录本次市场面板实际渲染过的卡片，
  // 并在面板生命周期内按 slug 去重，避免静默刷新重复放大曝光。
  useEffect(() => {
    const token = auth.snapshot().token;
    const signals = [];
    for (const card of exposedCards) {
      if (reportedExposureSlugs.current.has(card.slug)) continue;
      reportedExposureSlugs.current.add(card.slug);
      signals.push({
        surface: "marketplace",
        stage: "catalog_exposure",
        code: "CATALOG_EXPOSURE",
        outcome: "succeeded" as const,
        entitySlug: card.slug,
      });
    }
    if (signals.length > 0) reportClientFrictionBatch(signals, token);
  }, [auth, exposedCards]);

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
    <div className="marketplace-browse flex flex-col">
      {/* 一条吸顶栏承载「看哪一类 + 搜什么 + 让 AI 帮挑」(UI-5:去掉 hero 和英文小字之后,打开市场
          第一眼就是它和卡片)。手机上两行:类目一行,搜索一行,整条吸顶。 */}
      <div className="marketplace-toolbar sticky top-0 z-10 flex flex-col gap-2 border-b border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-6">
        {onKindChange && (
          <Tabs
            aria-label="市场类型"
            value={kind}
            onValueChange={(v) => onKindChange(v as BrowseKind)}
            items={KIND_TABS}
            className="shrink-0 max-sm:w-full max-sm:[&>[role=tab]]:flex-1"
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
              placeholder={`搜索${noun}，试试${SEARCH_EXAMPLES[kind]}`}
              className="marketplace-search pl-9"
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
              <Sparkles size={14} aria-hidden="true" /> AI 帮我挑
            </Button>
          )}
        </div>
      </div>

      {/* 分类筛选只留这一行(UI-5)。移动端一行横向滚动,右缘渐隐暗示还有;桌面端(sm 起)有宽度就
          直接换行:此前桌面也横滚、还隐藏了滚动条又没有箭头,鼠标用户到不了被截掉的最后一片(K-12)。 */}
      {grouped && (grouped.categories.length > 0 || grouped.uncategorized.length > 0) && (
        <div className="relative">
          <section
            aria-label="市场分类"
            // 只在窄屏(真的横滚时)可聚焦;桌面换行不滚,不留无意义的 Tab 停靠点(QA t-1028 §6 #1)。
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 移动端横向滚动分类必须可由键盘聚焦和滚动。
            tabIndex={narrow ? 0 : undefined}
            className="marketplace-categories flex snap-x scroll-px-4 gap-1.5 overflow-x-auto px-4 pb-1 pt-3 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:snap-none sm:overflow-x-visible sm:px-6"
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
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-surface to-transparent sm:hidden"
          />
        </div>
      )}

      {err && (
        <div className="px-4 pt-3 sm:px-6">
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
        <ListSkeleton variant="card" rows={4} className="px-4 py-4 sm:px-6" />
      ) : empty && !err ? (
        debouncedQ ? (
          <EmptyState
            icon={PackageSearch}
            title={`没有匹配的${noun}`}
            hint="换个关键词，或让 AI 在对话里按你的场景现场找。"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {onAskAiInChat && (
                  <Button size="sm" variant="primary" onClick={askAi}>
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
                  <Button size="sm" variant="primary" onClick={onCreateInChat}>
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
      ) : shownCards && shownCards.length > 0 ? (
        // 刷新/翻页时保留旧列表(只压暗),不再整片闪成骨架把滚动位置打乱。
        <div
          aria-busy={loading || undefined}
          className={cn("flex flex-col pt-3", loading && "opacity-60 transition-opacity")}
        >
          {/* 结果条:平铺态给「在看哪一类/搜了什么 + 命中数 + 返回全部」,分区态给总数。
              窄屏在不必要时让出这一行 —— 分区计数已在各区头。 */}
          <div
            className={cn(
              "marketplace-results flex min-h-8 items-center gap-2 px-4 pb-2 sm:px-6",
              !flatMode && !truncated && "hidden sm:flex",
            )}
          >
            {flatMode ? (
              <>
                <h3 className="min-w-0 truncate text-section font-semibold text-fg">{flatTitle}</h3>
                <span className="shrink-0 text-meta tabular-nums text-faint">{flatCards.length}</span>
              </>
            ) : (
              // 只拉了一页时说「已加载」而不是「共」:分区计数与这里都不能把一页当全量(K-03)。
              <p className="text-caption text-faint">
                {truncated ? `已加载 ${shownCards.length} 个${noun}，还有更多` : `共 ${shownCards.length} 个${noun}`}
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
            {truncated && selectedCat === null && !debouncedQ && (
              // 分区视图的「加载更多」同时放在结果条右侧:用户不必滚过全部分区才发现还有下一页。
              <Button size="sm" variant="ghost" className="ml-auto shrink-0" loading={loading} onClick={loadMore}>
                加载更多
              </Button>
            )}
          </div>

          {sections && selectedCat === null ? (
            // 分区视图:平台精选 → 各分类分区 → 未分类兜底
            <div className="marketplace-sections flex flex-col gap-7 px-4 pb-8 pt-1 sm:px-6">
              {sections.featured.length > 0 && (
                <Section
                  title="平台精选"
                  blurb={`平台为你挑选的优质${noun}`}
                  count={sections.featured.length}
                  truncated={truncated}
                  cards={sections.featured}
                  installed={installed}
                  plugins={pluginBySlug}
                  onOpen={openCard}
                  onConnect={onOpenConnectors}
                />
              )}
              {sections.categories.map((c) => (
                <Section
                  key={c.id}
                  title={c.label}
                  blurb={c.blurb}
                  count={c.cards.length}
                  truncated={truncated}
                  cards={c.cards}
                  installed={installed}
                  plugins={pluginBySlug}
                  onOpen={openCard}
                  onConnect={onOpenConnectors}
                />
              ))}
              {sections.uncategorized.length > 0 && (
                <Section
                  title="未分类"
                  blurb="暂未归类的条目"
                  count={sections.uncategorized.length}
                  truncated={truncated}
                  cards={sections.uncategorized}
                  installed={installed}
                  plugins={pluginBySlug}
                  onOpen={openCard}
                  onConnect={onOpenConnectors}
                />
              )}
            </div>
          ) : (
            // 平铺视图:搜索相关度列表,或选中某个分类筛选片
            <ul className={cn(GRID, "marketplace-flat-grid px-4 pb-8 sm:px-6")}>
              {flatCards.map((c) => (
                <CardTile
                  key={c.slug}
                  card={c}
                  installed={installed}
                  plugins={pluginBySlug}
                  onOpen={openCard}
                  onConnect={onOpenConnectors}
                />
              ))}
            </ul>
          )}

          {/* 目录不再硬截断:装满一页就给出口,否则第 51 个商品对用户等于不存在。 */}
          {truncated && (
            <div className="px-4 pb-5 sm:px-6">
              <Button variant="secondary" size="sm" className="w-full" loading={loading} onClick={loadMore}>
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
      // 选中态不能只靠颜色:读屏 / 高对比模式要从 aria-pressed 拿到"当前筛选是哪个"(K-07)。
      aria-pressed={active}
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

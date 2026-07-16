import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol";
import {
  ArrowUpCircle,
  Layers,
  PackageSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import {
  benchmarkBadgeLabel,
  formatInstallCount,
  groupCardsByCategory,
  marketAskAiPrefill,
  updateAvailable,
} from "../../lib/marketplace";
import type { AuthSession, MarketplaceCard, MarketplaceInstalled } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, EmptyState, Input, Skeleton } from "../ui";
import { DetailModal } from "./DetailModal";

/** 「未分类」兜底分区/筛选片的合成 id（不与任何 taxonomy id 冲突）。 */
const UNCAT = "__uncategorized__";

/** 单张目录卡片(分区视图与平铺视图共用,保证两处样式一致)。 */
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
  // 评分:服务端已保证样本≥5 才非 null(前端不做二次阈值判断)。中性徽章,诚实文案。
  const rating = card.rating ?? null;
  const ratingTotal = rating ? rating.up + rating.down : 0;
  // 卡片只在「已知分类」时渲染分类徽章 —— 未分类不占位不噪音(分区视图里区头已足够)。
  const catLabel = isMarketplaceCategoryId(card.category)
    ? marketplaceCategoryLabel(card.category)
    : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(card.slug)}
        className="flex h-full w-full flex-col gap-2 rounded-xl border border-border bg-elevated p-3.5 text-left outline-none transition-colors hover:border-accent/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold text-fg">{card.name}</span>
              {canUpdate ? (
                <ArrowUpCircle size={13} className="shrink-0 text-accent" aria-label="有新版本" />
              ) : inst ? (
                <ShieldCheck size={13} className="shrink-0 text-success" aria-label="已安装" />
              ) : null}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
              {card.description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {card.preset && <Badge tone="success">预设 · 开箱即用</Badge>}
          {card.preinstalled && <Badge tone="success">官方 · 已预装</Badge>}
          {card.official && !card.preinstalled && <Badge tone="success">官方</Badge>}
          {canUpdate && <Badge tone="accent">可更新</Badge>}
          {catLabel && (
            <Badge tone="info">
              <Layers size={10} /> {catLabel}
            </Badge>
          )}
          {card.tags.slice(0, 4).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
          {(rating || inUseLabel) && (
            <span className="ml-auto flex items-center gap-1.5">
              {rating && (
                <Badge tone="neutral" title={`来自 ${ratingTotal} 次真实使用的反馈`}>
                  👍 {rating.up}/{ratingTotal}
                </Badge>
              )}
              {inUseLabel && (
                <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                  <Users size={11} /> {inUseLabel}
                </span>
              )}
            </span>
          )}
        </div>
        {/* 评测徽记:仅在发布者提供 benchmark 时渲染(无数据不占位不噪音);
            title 标注"发布者提供·未经平台验证",不当平台背书。 */}
        {bench && (
          <div className="flex">
            <Badge tone="info" title={bench.title}>
              {bench.label}
            </Badge>
          </div>
        )}
      </button>
    </li>
  );
}

/** 一个分区(区头 label+blurb+数量 → 卡片网格)。 */
function Section({
  title,
  blurb,
  count,
  icon,
  cards,
  installed,
  onOpen,
}: {
  title: string;
  blurb?: string;
  count: number;
  icon?: React.ReactNode;
  cards: MarketplaceCard[];
  installed: Map<string, MarketplaceInstalled>;
  onOpen: (slug: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <div className="flex items-center gap-1.5">
          {icon}
          <h3 className="text-[13.5px] font-semibold text-fg">{title}</h3>
          <span className="text-[11.5px] text-faint">{count}</span>
        </div>
        {blurb && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{blurb}</p>}
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
 * 发现：搜索 + 目录卡片。
 * - 有查询词 → 平铺相关度列表（服务端排序权威，卡片加分类徽章）。
 * - 空查询 → 分区视图（平台精选 → 按 taxonomy 顺序的分类分区 → 未分类兜底），
 *   顶部一行可横向滚动的分类筛选片；选中某类后平铺该类。**信任服务端顺序**，
 *   前端只做纯分组，不再自行按热度重排。
 * 已安装/可更新的条目打徽标；点击卡片打开详情/安装确认。
 */
export function BrowsePanel({
  auth,
  kind = "skill",
  revision = 0,
  focusRequest,
  onFocusRequestConsumed,
  onAskAiInChat,
  onOpenConnectors,
}: {
  auth: AuthSession;
  /** 仅展示该类目。M2 默认且仅 'skill'（agent 投递在 M3，M4 才开 agent Tab）。 */
  kind?: "skill" | "agent" | "connector";
  /** 审核状态转为终态时递增；即使查询词/kind 未变也重新拉市场目录。 */
  revision?: number;
  /** 审核通过通知的 CTA：切到对应分类并直接打开新条目详情。 */
  focusRequest?: { slug: string; nonce: number } | null;
  /** focusRequest 是一次性命令；详情打开后通知父层清除，避免重新挂载时重复执行。 */
  onFocusRequestConsumed?: (nonce: number) => void;
  /** AI 导购入口(批3):有查询词时结果区顶部「让 AI 帮我找并装好」;缺省则不渲染入口。 */
  onAskAiInChat?: (text: string) => void;
  onOpenConnectors?: () => void;
}) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<MarketplaceCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
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

  // 切换 kind 或进入搜索态时,清掉分类选择(避免停留在一个空/不相关的筛选片)。
  useEffect(() => {
    setSelectedCat(null);
  }, [kind, debouncedQ]);

  const loadCards = useCallback(
    async (showLoading: boolean) => {
      const seq = ++cardRequestSeq.current;
      if (showLoading) setLoading(true);
      setErr(null);
      try {
        const result = await api.searchMarketplace(auth, debouncedQ, kind);
        if (seq !== cardRequestSeq.current) return;
        // 信任服务端顺序:目录态已按 featured_rank/热度排好,搜索态是相关度排序。
        setCards(result.results);
      } catch (cause) {
        if (seq === cardRequestSeq.current) {
          setErr(apiErrorMessage(cause, "加载市场失败"));
        }
      } finally {
        if (seq === cardRequestSeq.current) setLoading(false);
      }
    },
    [auth, debouncedQ, kind],
  );

  useEffect(() => {
    void loadCards(true);
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

  const empty = useMemo(() => !loading && cards && cards.length === 0, [loading, cards]);

  // 分区视图仅在浏览态(空查询)构建;搜索态走平铺相关度列表。
  const grouped = useMemo(
    () => (!debouncedQ && cards ? groupCardsByCategory(cards) : null),
    [debouncedQ, cards],
  );

  const noun = kind === "agent" ? "智能体" : kind === "connector" ? "插件" : "技能";

  // 当前平铺(chips 选中某类,或搜索态)的卡片集。
  const flatCards = useMemo(() => {
    if (debouncedQ) return cards ?? [];
    if (!grouped || selectedCat === null) return [];
    if (selectedCat === UNCAT) return grouped.uncategorized;
    return grouped.categories.find((c) => c.id === selectedCat)?.cards ?? [];
  }, [debouncedQ, cards, grouped, selectedCat]);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 bg-surface px-4 pb-3 pt-4">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
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
      </div>

      {/* 分类筛选片:仅浏览态且有分区时渲染,一行可横向滚动(移动端不换行) */}
      {grouped && (grouped.categories.length > 0 || grouped.uncategorized.length > 0) && (
        <>
          <section
            aria-label="市场分类，可横向滚动"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动分类必须可由键盘聚焦和滚动。
            tabIndex={0}
            className="flex gap-1.5 overflow-x-auto px-4 pb-2.5 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-scrollbar]:hidden"
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
          <p className="px-4 pb-2 text-[11px] text-faint sm:hidden">左右滑动查看更多分类</p>
        </>
      )}

      {err && (
        <div className="px-4 pb-2">
          <Alert tone="danger">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">{err}</span>
              <Button size="sm" variant="secondary" onClick={() => void loadCards(true)}>
                重试
              </Button>
            </div>
          </Alert>
        </div>
      )}

      {/* AI 导购入口:仅搜索态(有查询词)渲染一条轻量操作行——不挤占卡片网格空间,
          浏览/分区态不出现。有结果时给「换 AI 代劳」、空结果时 AI 可现场解决。 */}
      {onAskAiInChat && debouncedQ && (
        <div className="mx-4 mb-2.5 flex flex-wrap items-center gap-2.5 rounded-xl border border-accent/30 bg-accent-soft/40 px-3 py-2.5">
          <Button
            size="sm"
            variant="accent"
            onClick={() => onAskAiInChat(marketAskAiPrefill(debouncedQ))}
          >
            🤖 让 AI 帮我找并装好
          </Button>
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted">
            AI 会在对话里对比适配度，经你确认后安装。
          </span>
        </div>
      )}

      {loading ? (
        <ul className="grid grid-cols-1 gap-2.5 px-4 pb-5 sm:grid-cols-2" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li
              key={i}
              className="flex flex-col gap-2.5 rounded-xl border border-border bg-elevated p-3.5"
            >
              <div className="flex items-start gap-2.5">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
              <div className="flex gap-1.5">
                <Skeleton className="h-4 w-12 rounded-full" />
                <Skeleton className="h-4 w-16 rounded-full" />
              </div>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <EmptyState
          icon={PackageSearch}
          title={debouncedQ ? `没有匹配的${noun}` : `市场还没有上架的${noun}`}
          hint={debouncedQ ? "换个关键词试试。" : undefined}
        />
      ) : grouped && selectedCat === null ? (
        // 分区视图:平台精选 → 各分类分区 → 未分类兜底
        <div className="flex flex-col gap-5 px-4 pb-5 pt-0.5">
          {grouped.featured.length > 0 && (
            <Section
              title="平台精选"
              blurb={`平台为你挑选的优质${noun}`}
              count={grouped.featured.length}
              icon={<Star size={14} className="text-accent" aria-hidden="true" />}
              cards={grouped.featured}
              installed={installed}
              onOpen={setActive}
            />
          )}
          {grouped.categories.map((c) => (
            <Section
              key={c.id}
              title={c.label}
              blurb={c.blurb}
              count={c.cards.length}
              cards={c.cards}
              installed={installed}
              onOpen={setActive}
            />
          ))}
          {grouped.uncategorized.length > 0 && (
            <Section
              title="未分类"
              blurb="暂未归类的条目"
              count={grouped.uncategorized.length}
              cards={grouped.uncategorized}
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
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-accent/50 bg-accent-soft text-accent"
          : "border-border text-muted hover:border-accent/40 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

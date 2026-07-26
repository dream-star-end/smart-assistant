import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol";
import { RefreshCw, Star, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { formatInstallCount, sortFeaturedListings } from "../../lib/marketplace";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  CardRow,
  EmptyState,
  Input,
  ListSkeleton,
  type TabItem,
  Tabs,
  Toolbar,
  useToast,
} from "../ui";

/** 目录拉取上限(技能+智能体各一页;搜索目录本身有 500 上限,精选面看全量足够)。 */
const CATALOG_LIMIT = 200;

/** 列表过滤范围(纯前端,不动数据层)。 */
type Scope = "all" | "featured" | "skill" | "agent";

const SCOPE_TABS: TabItem[] = [
  { value: "all", label: "全部" },
  { value: "featured", label: "仅精选" },
  { value: "skill", label: "技能" },
  { value: "agent", label: "智能体" },
];

/** 该卡片当前草稿(输入框)是否与服务端 featuredRank 不一致(决定「保存」是否可点)。 */
function isDirty(card: MarketplaceCard, draft: string): boolean {
  const server = card.featuredRank != null ? String(card.featuredRank) : "";
  return draft.trim() !== server;
}

/** 分段标题:当前精选 / 候选目录。overline 档,与行内主名拉开层级。 */
function ListSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <h4 className="text-caption font-semibold uppercase tracking-[0.06em] text-muted">
          {title}
        </h4>
        <Badge tone="neutral" size="sm">
          {count}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

/**
 * 单行:名称/类型/分类/30天使用 + rank 输入 + 保存(移动端操作区整行下沉,由 CardRow 统一)。
 * 校验/保存错误就地渲染在输入框下方 —— 改造前它出现在几屏之外的页顶 Alert 里,
 * 管理员在第 200 行点保存看到的是「什么都没发生」。
 */
function FeaturedRow({
  card,
  draft,
  saving,
  error,
  onDraft,
  onSave,
}: {
  card: MarketplaceCard;
  draft: string;
  saving: boolean;
  error?: string;
  onDraft: (v: string) => void;
  onSave: () => void;
}) {
  const catLabel = isMarketplaceCategoryId(card.category)
    ? marketplaceCategoryLabel(card.category)
    : "未分类";
  const users30d = card.users30d ?? 0;
  const dirty = isDirty(card, draft);
  return (
    <li>
      <CardRow
        title={card.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>{catLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <Users size={11} aria-hidden="true" /> 30天 {formatInstallCount(users30d) ?? 0} 人在用
            </span>
          </span>
        }
        meta={
          <>
            {/* 类型徽章对称:改造前只有 agent 有,skill 行没有任何 kind 标记,两类混排无从区分。 */}
            <Badge tone={card.kind === "agent" ? "accent" : "neutral"} size="sm">
              {card.kind === "agent" ? "智能体" : "技能"}
            </Badge>
            {card.featuredRank != null && (
              <Badge tone="info" size="sm">
                <Star size={10} aria-hidden="true" /> 精选 #{card.featuredRank}
              </Badge>
            )}
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={9999}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                placeholder="非精选"
                aria-label={`${card.name} 精选排序`}
                aria-invalid={error ? true : undefined}
                className={cn("w-24", error && "border-danger")}
              />
              <Button
                size="sm"
                variant="primary"
                onClick={onSave}
                loading={saving}
                disabled={!dirty}
                aria-label={`保存 ${card.name} 精选排序`}
              >
                保存
              </Button>
            </div>
            {error && (
              <p role="alert" className="max-w-64 text-right text-caption text-danger">
                {error}
              </p>
            )}
          </div>
        }
      />
    </li>
  );
}

/**
 * 精选管理(批3 admin)：把目录里的技能/智能体设为/取消平台精选(featured_rank)。
 *
 * 数据源=既有 `/api/marketplace/search`(kind=skill+agent 各拉一次合并),卡片已带
 * featuredRank/category/users30d;每行给一个 rank 数字输入(空=非精选)+保存,保存调
 * 新 admin API `setMarketplaceFeatured`。排序单一权威=lib/marketplace.sortFeaturedListings
 * (精选按 rank 升序在前,非精选按使用数降序在后)。auth 传入 adminSession(与 ReviewPanel
 * 同款,401 透明刷新)。
 *
 * ── 2026-07-26 改造(呈现层) ──────────────────────────────────────────────
 * · 保存成功不再整表 reload:原地回写该行 + Toast,列表不闪白、行不跳走;
 *   显示顺序在下一次「刷新」时才按新 rank 重排(顺序权威仍是 sortFeaturedListings)。
 * · 400 行铺平 → 工具条(计数/筛选/搜索)+ 当前精选/候选目录两段。
 * · 错误分层:校验与保存失败就地渲染在行内(+Toast),页顶 Alert 只留「目录加载失败」。
 */
export function FeaturedPanel({ auth }: { auth: AuthSession }) {
  const toast = useToast();
  /** 展示顺序权威:载入/刷新时按 sortFeaturedListings 定序,保存只原地回写不重排。 */
  const [rows, setRows] = useState<MarketplaceCard[] | null>(null);
  /**
   * 分段归属同样在载入时定格。若按实时 featuredRank 分段,管理员刚给第 200 行设完精选,
   * 那一行就会从「候选目录」瞬间跳进上方的「当前精选」—— 正是本次要消灭的「行跳走」。
   * 顺序与分段一起在点「刷新」时重算。
   */
  const [featuredAtLoad, setFeaturedAtLoad] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** 任一数据源装满一页 → 目录被显示上限截断,提示管理员用筛选缩小范围。 */
  const [atLimit, setAtLimit] = useState(false);
  /** 每行 rank 输入草稿(受控;空串=非精选)。rows 变化时以服务端值重置。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /** 行内错误(校验/保存),按 slug 分行存 —— 报错必须出现在发起它的那一行。 */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      api.searchMarketplace(auth, "", "skill", CATALOG_LIMIT),
      api.searchMarketplace(auth, "", "agent", CATALOG_LIMIT),
    ])
      .then(([s, a]) => {
        if (!alive) return;
        const merged = [...s.results, ...a.results];
        setRows(sortFeaturedListings(merged));
        setFeaturedAtLoad(
          new Set(merged.filter((c) => c.featuredRank != null).map((c) => c.slug)),
        );
        setAtLimit(s.results.length >= CATALOG_LIMIT || a.results.length >= CATALOG_LIMIT);
        setRowErrors({});
        // 草稿以服务端 featuredRank 为准重置(刷新也走这里,回到最新权威值)。
        setDrafts(
          Object.fromEntries(
            merged.map((c) => [c.slug, c.featuredRank != null ? String(c.featuredRank) : ""]),
          ),
        );
      })
      .catch((e) => alive && setErr(apiErrorMessage(e, "加载市场目录失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      // 「仅精选」把本次刚被取消精选的行也留下 —— 否则管理员手一抖点了保存,那一行当场
      // 从视口消失,连撤回的机会都没有。
      if (scope === "featured" && r.featuredRank == null && !featuredAtLoad.has(r.slug))
        return false;
      if (scope === "skill" && r.kind !== "skill") return false;
      if (scope === "agent" && r.kind !== "agent") return false;
      if (kw && !`${r.name} ${r.slug}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [rows, filter, scope, featuredAtLoad]);

  const featuredRows = useMemo(
    () => visible.filter((r) => featuredAtLoad.has(r.slug)),
    [visible, featuredAtLoad],
  );
  const candidateRows = useMemo(
    () => visible.filter((r) => !featuredAtLoad.has(r.slug)),
    [visible, featuredAtLoad],
  );

  const setRowError = useCallback((slug: string, message: string | null) => {
    setRowErrors((prev) => {
      if (message === null) {
        if (!(slug in prev)) return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      }
      return { ...prev, [slug]: message };
    });
  }, []);

  const save = useCallback(
    async (card: MarketplaceCard) => {
      const raw = (drafts[card.slug] ?? "").trim();
      let rank: number | null;
      if (raw === "") {
        rank = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 9999) {
          setRowError(card.slug, "精选排序需为 1–9999 的整数，留空则取消精选。");
          return;
        }
        rank = n;
      }
      setSaving(card.slug);
      setRowError(card.slug, null);
      try {
        await api.setMarketplaceFeatured(auth, card.slug, rank);
        // 原地回写:不整表 reload —— 改造前保存后整页闪白 + 刚编辑的那行被重排到顶部消失。
        setRows((prev) =>
          prev
            ? prev.map((r) => (r.slug === card.slug ? { ...r, featuredRank: rank } : r))
            : prev,
        );
        setDrafts((prev) => ({ ...prev, [card.slug]: rank == null ? "" : String(rank) }));
        toast(
          rank == null ? `已取消「${card.name}」的精选` : `「${card.name}」已设为精选 #${rank}`,
          "success",
        );
      } catch (e) {
        const message = apiErrorMessage(e, "保存失败");
        setRowError(card.slug, message);
        toast(message, "error");
      } finally {
        setSaving(null);
      }
    },
    [auth, drafts, toast, setRowError],
  );

  const renderRow = (c: MarketplaceCard) => (
    <FeaturedRow
      key={c.slug}
      card={c}
      draft={drafts[c.slug] ?? ""}
      saving={saving === c.slug}
      error={rowErrors[c.slug]}
      onDraft={(v) => setDrafts((prev) => ({ ...prev, [c.slug]: v }))}
      onSave={() => save(c)}
    />
  );

  const filtered = filter.trim() !== "" || scope !== "all";

  return (
    <div className="flex flex-col">
      <Toolbar
        title="精选管理"
        count={visible.length}
        search={filter}
        onSearchChange={setFilter}
        searchPlaceholder="按名称筛选…"
        debounceMs={150}
        // admin 页把面板放在 overflow-hidden 的卡片里,吸顶在这里没有意义。
        sticky={false}
        filters={
          <Tabs
            aria-label="精选筛选"
            value={scope}
            onValueChange={(v) => setScope(v as Scope)}
            items={SCOPE_TABS}
          />
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReload((n) => n + 1)}
            loading={loading}
            aria-label="刷新目录"
          >
            {!loading && <RefreshCw size={14} aria-hidden="true" />} 刷新
          </Button>
        }
      />

      <div className="flex flex-col gap-3 px-4 py-4">
        <Alert tone="info" density="compact" icon={<Star size={15} />}>
          精选排序越小越靠前，出现在「发现」页顶部的「平台精选」区；留空即取消精选。保存立即生效，列表顺序在点「刷新」后重排。
        </Alert>

        {atLimit && (
          <Alert tone="warning" density="compact">
            目录已达显示上限（技能/智能体各 {CATALOG_LIMIT} 条），请用上方筛选缩小范围。
          </Alert>
        )}

        {/* 页顶 Alert 只承载「整表加载失败」这一类,并自带重试出口。 */}
        {err && (
          <Alert
            tone="danger"
            action={
              <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        )}

        {loading && rows === null ? (
          <ListSkeleton rows={5} />
        ) : visible.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Star}
              title="没有匹配的条目"
              hint="换个关键词，或把筛选切回「全部」。"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFilter("");
                    setScope("all");
                  }}
                >
                  清空筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Star}
              title="市场还没有可精选的条目"
              hint="上架技能/智能体后可在此设精选。"
            />
          )
        ) : (
          <div className="flex flex-col gap-4">
            {featuredRows.length > 0 && (
              <ListSection title="当前精选" count={featuredRows.length}>
                {featuredRows.map(renderRow)}
              </ListSection>
            )}
            {candidateRows.length > 0 && (
              <ListSection title="候选目录" count={candidateRows.length}>
                {candidateRows.map(renderRow)}
              </ListSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

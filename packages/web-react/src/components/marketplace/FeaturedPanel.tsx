import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol";
import { Loader2, RefreshCw, Star, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { formatInstallCount, sortFeaturedListings } from "../../lib/marketplace";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { Alert, Badge, Button, EmptyState, Input, Spinner } from "../ui";

/** 目录拉取上限(技能+智能体各一页;搜索目录本身有 500 上限,精选面看全量足够)。 */
const CATALOG_LIMIT = 200;

/** 该卡片当前草稿(输入框)是否与服务端 featuredRank 不一致(决定「保存」是否可点)。 */
function isDirty(card: MarketplaceCard, draft: string): boolean {
  const server = card.featuredRank != null ? String(card.featuredRank) : "";
  return draft.trim() !== server;
}

/** 单行:名称/分类/30天使用 + rank 输入 + 保存。移动端换行不挤(flex-wrap)。 */
function FeaturedRow({
  card,
  draft,
  saving,
  onDraft,
  onSave,
}: {
  card: MarketplaceCard;
  draft: string;
  saving: boolean;
  onDraft: (v: string) => void;
  onSave: () => void;
}) {
  const catLabel = isMarketplaceCategoryId(card.category)
    ? marketplaceCategoryLabel(card.category)
    : "未分类";
  const users30d = card.users30d ?? 0;
  const dirty = isDirty(card, draft);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-elevated px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium text-fg">{card.name}</span>
          {card.kind === "agent" && <Badge tone="accent">智能体</Badge>}
          {card.featuredRank != null && (
            <Badge tone="info">
              <Star size={10} /> 精选 #{card.featuredRank}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-muted">
          <span>{catLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Users size={11} /> 30天 {formatInstallCount(users30d) ?? 0} 人在用
          </span>
        </p>
      </div>
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
          className="w-24"
        />
        <Button
          size="sm"
          variant="primary"
          onClick={onSave}
          disabled={saving || !dirty}
          aria-label={`保存 ${card.name} 精选排序`}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : "保存"}
        </Button>
      </div>
    </li>
  );
}

/**
 * 精选管理(批3 admin)：把目录里的技能/智能体设为/取消平台精选(featured_rank)。
 *
 * 数据源=既有 `/api/marketplace/search`(kind=skill+agent 各拉一次合并),卡片已带
 * featuredRank/category/users30d;每行给一个 rank 数字输入(空=非精选)+保存,保存调
 * 新 admin API `setMarketplaceFeatured`,成功即刷新(服务端重排 + 回填 rank)。
 * 排序单一权威=lib/marketplace.sortFeaturedListings(精选按 rank 升序在前,非精选按
 * 使用数降序在后)。auth 传入 adminSession(与 ReviewPanel 同款,401 透明刷新)。
 */
export function FeaturedPanel({ auth }: { auth: AuthSession }) {
  const [rows, setRows] = useState<MarketplaceCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** 每行 rank 输入草稿(受控;空串=非精选)。rows 变化时以服务端值重置。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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
        setRows(merged);
        // 草稿以服务端 featuredRank 为准重置(保存后刷新也走这里,回到最新权威值)。
        setDrafts(
          Object.fromEntries(
            merged.map((c) => [c.slug, c.featuredRank != null ? String(c.featuredRank) : ""]),
          ),
        );
      })
      .catch((e) => alive && setErr((e as Error).message || "加载市场目录失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const sorted = useMemo(() => (rows ? sortFeaturedListings(rows) : []), [rows]);

  const save = useCallback(
    async (card: MarketplaceCard) => {
      const raw = (drafts[card.slug] ?? "").trim();
      let rank: number | null;
      if (raw === "") {
        rank = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 9999) {
          setErr(`「${card.name}」精选排序需为 1–9999 的整数，留空则取消精选。`);
          return;
        }
        rank = n;
      }
      setSaving(card.slug);
      setErr(null);
      try {
        await api.setMarketplaceFeatured(auth, card.slug, rank);
        setReload((n) => n + 1); // 成功即刷新:服务端重排 + 回填 featuredRank
      } catch (e) {
        setErr((e as Error).message || "保存失败");
      } finally {
        setSaving(null);
      }
    },
    [auth, drafts],
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
        <Star size={14} className="text-accent" aria-hidden="true" />
        <span className="text-[12.5px] text-muted">
          精选排序越小越靠前，出现在「发现」页顶部的「平台精选」区；留空即取消精选。
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
          aria-label="刷新目录"
        >
          <RefreshCw size={14} /> 刷新
        </Button>
      </div>

      {err && <Alert tone="danger">{err}</Alert>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-faint">
          <Spinner /> 加载市场目录…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={Star} title="市场还没有可精选的条目" hint="上架技能/智能体后可在此设精选。" />
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((c) => (
            <FeaturedRow
              key={c.slug}
              card={c}
              draft={drafts[c.slug] ?? ""}
              saving={saving === c.slug}
              onDraft={(v) => setDrafts((prev) => ({ ...prev, [c.slug]: v }))}
              onSave={() => save(c)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

import { ArrowUpCircle, PackageSearch, Search, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { formatInstallCount, sortByPopularity, updateAvailable } from "../../lib/marketplace";
import type { AuthSession, MarketplaceCard, MarketplaceInstalled } from "../../lib/types";
import { Alert, Badge, EmptyState, Input, Skeleton } from "../ui";
import { DetailModal } from "./DetailModal";

/**
 * 发现：搜索 + 目录卡片网格。空查询返回全部目录(后端 method=all)，前端按热度
 * （安装数）排序；有查询词时保持后端相关度排序。已安装/可更新的条目打徽标。
 * 点击卡片打开详情/安装确认。
 */
export function BrowsePanel({
  auth,
  kind = "skill",
}: {
  auth: AuthSession;
  /** 仅展示该类目。M2 默认且仅 'skill'（agent 投递在 M3，M4 才开 agent Tab）。 */
  kind?: "skill" | "agent";
}) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<MarketplaceCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Map<string, MarketplaceInstalled>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [reloadInstalled, setReloadInstalled] = useState(0);

  // 防抖搜索
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .searchMarketplace(auth, debouncedQ, kind)
      .then((r) => {
        if (!alive) return;
        // 目录态（空查询）按热度稳定排序；有查询词时尊重后端相关度。
        setCards(debouncedQ ? r.results : sortByPopularity(r.results));
      })
      .catch((e) => alive && setErr((e as Error).message || "加载市场失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, debouncedQ, kind]);

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
                : "搜索技能（试试「翻译」「论文」「写作」）…"
            }
            className="pl-9"
          />
        </div>
      </div>

      {err && (
        <div className="px-4 pb-2">
          <Alert tone="danger">{err}</Alert>
        </div>
      )}

      {loading ? (
        <ul className="grid grid-cols-1 gap-2.5 px-4 pb-5 sm:grid-cols-2" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex flex-col gap-2.5 rounded-xl border border-border bg-elevated p-3.5">
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
          title={
            debouncedQ
              ? `没有匹配的${kind === "agent" ? "智能体" : "技能"}`
              : `市场还没有上架的${kind === "agent" ? "智能体" : "技能"}`
          }
          hint={debouncedQ ? "换个关键词试试。" : undefined}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 px-4 pb-5 sm:grid-cols-2">
          {cards?.map((c) => {
            const inst = installed.get(c.slug);
            const canUpdate = inst ? updateAvailable(inst) : false;
            const users = formatInstallCount(c.installCount);
            return (
              <li key={c.slug}>
                <button
                  type="button"
                  onClick={() => setActive(c.slug)}
                  className="flex h-full w-full flex-col gap-2 rounded-xl border border-border bg-elevated p-3.5 text-left outline-none transition-colors hover:border-accent/40 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <Sparkles size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-semibold text-fg">
                          {c.name}
                        </span>
                        {canUpdate ? (
                          <ArrowUpCircle size={13} className="shrink-0 text-accent" aria-label="有新版本" />
                        ) : inst ? (
                          <ShieldCheck size={13} className="shrink-0 text-success" aria-label="已安装" />
                        ) : null}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
                        {c.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {canUpdate && <Badge tone="accent">可更新</Badge>}
                    {c.tags.slice(0, 4).map((t) => (
                      <Badge key={t} tone="neutral">
                        {t}
                      </Badge>
                    ))}
                    {users && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
                        <Users size={11} /> {users} 人在用
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <DetailModal
        slug={active}
        auth={auth}
        installed={active ? installed.get(active) : undefined}
        onClose={() => setActive(null)}
        onInstalled={onInstalled}
      />
    </div>
  );
}

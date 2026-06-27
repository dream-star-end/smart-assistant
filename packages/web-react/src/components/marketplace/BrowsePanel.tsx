import { PackageSearch, Search, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, MarketplaceCard } from "../../lib/types";
import { Alert, Badge, Input, Spinner } from "../ui";
import { DetailModal } from "./DetailModal";

/**
 * 发现：搜索 + 目录卡片网格。空查询返回全部目录(后端 method=all)。
 * 已安装的条目打「已安装」徽标。点击卡片打开详情/安装确认。
 */
export function BrowsePanel({ auth }: { auth: AuthSession }) {
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<MarketplaceCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
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
      .searchMarketplace(auth, debouncedQ)
      .then((r) => alive && setCards(r.results))
      .catch((e) => alive && setErr((e as Error).message || "加载市场失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, debouncedQ]);

  // 拉一次「我的已安装」用于卡片徽标
  useEffect(() => {
    let alive = true;
    api
      .listMarketplaceInstalled(auth)
      .then((rows) => alive && setInstalledSlugs(new Set(rows.map((r) => r.slug))))
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
            placeholder="搜索技能（试试「翻译」「论文」「写作」）…"
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
        <div className="flex items-center justify-center gap-2 py-16 text-faint">
          <Spinner /> 加载市场…
        </div>
      ) : empty ? (
        <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-faint">
          <PackageSearch size={28} className="opacity-50" />
          <p className="text-[13px]">
            {debouncedQ ? "没有匹配的技能，换个关键词试试。" : "市场还没有上架的技能。"}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 px-4 pb-5 sm:grid-cols-2">
          {cards?.map((c) => {
            const isInstalled = installedSlugs.has(c.slug);
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
                        {isInstalled && (
                          <ShieldCheck size={13} className="shrink-0 text-success" />
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
                        {c.description}
                      </p>
                    </div>
                  </div>
                  {c.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 4).map((t) => (
                        <Badge key={t} tone="neutral">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <DetailModal
        slug={active}
        auth={auth}
        installed={active ? installedSlugs.has(active) : false}
        onClose={() => setActive(null)}
        onInstalled={onInstalled}
      />
    </div>
  );
}

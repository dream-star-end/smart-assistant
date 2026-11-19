import { Database, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { type SiteDbInspectData, sitesApi } from "../../lib/sitesApi";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Button, EmptyState, Skeleton, StatusPill } from "../ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatCell(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

export function SiteDatabaseTab({
  auth,
  slug,
}: {
  auth: AuthSession;
  slug: string;
}) {
  const [selectedTable, setSelectedTable] = useState<string | undefined>(undefined);
  const [data, setData] = useState<SiteDbInspectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const reqIdRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset/focus trigger on prop or identity change
  useEffect(() => {
    setSelectedTable(undefined);
    setData(null);
    setErr(null);
  }, [slug]);

  const load = useCallback(
    async (table?: string) => {
      const reqSlug = slug;
      const reqId = ++reqIdRef.current;
      setLoading(true);
      setErr(null);
      try {
        const res = await sitesApi.getSiteDbInspect(auth, reqSlug, {
          table,
          limit: 100,
        });
        if (slugRef.current !== reqSlug || reqIdRef.current !== reqId) return;
        setData(res.db);
        if (!table && res.db.selectedTable) {
          setSelectedTable(res.db.selectedTable);
        }
      } catch (e) {
        if (slugRef.current !== reqSlug || reqIdRef.current !== reqId) return;
        setErr(apiErrorMessage(e, "加载数据库信息失败"));
      } finally {
        if (slugRef.current === reqSlug && reqIdRef.current === reqId) {
          setLoading(false);
        }
      }
    },
    [auth, slug],
  );

  useEffect(() => {
    void load(selectedTable);
  }, [load, selectedTable]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-section font-semibold text-fg">数据库</h3>
          <p className="text-caption text-muted">查看已上线站点使用的数据</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          disabled={loading}
          onClick={() => void load(selectedTable)}
        >
          <RefreshCw
            size={14}
            className={cn(loading && "animate-spin")}
            aria-hidden="true"
          />
          {loading ? "正在刷新…" : "刷新"}
        </Button>
      </div>

      {err && <Alert tone="danger">{err}</Alert>}

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-body">
          <StatusPill
            tone={data?.hasDatabaseFile ? "done" : "idle"}
            label={data?.hasDatabaseFile ? "已连接" : "就绪（首次写入时自动建库）"}
            className="font-medium text-fg"
          />
          {data && data.sizeBytes > 0 && (
            <span className="text-caption text-muted">{formatBytes(data.sizeBytes)}</span>
          )}
        </div>

        {loading && !data ? (
          <div className="p-6">
            <Skeleton className="h-44 w-full rounded-lg" />
          </div>
        ) : !data || data.tables.length === 0 ? (
          <div className="py-10">
            <EmptyState
              icon={Database}
              title="暂无数据表"
              hint="在站点后端 `/api/*` 中调用 `ctx.db.exec/run`，或通过 `oc-site db-sql` 建表写入后，可在此实时浏览表结构与数据行。"
            />
          </div>
        ) : (
          <div className="flex min-h-[260px] flex-col md:flex-row">
            <div className="w-full shrink-0 border-b border-border p-3 md:w-52 md:border-b-0 md:border-r">
              <p className="mb-2 px-2 text-caption font-medium text-muted">表</p>
              <div className="flex flex-row gap-1 overflow-x-auto md:flex-col">
                {data.tables.map((tbl) => {
                  const active = (selectedTable ?? data.selectedTable) === tbl.name;
                  return (
                    <button
                      key={tbl.name}
                      type="button"
                      onClick={() => setSelectedTable(tbl.name)}
                      className={cn(
                        "flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-body transition-colors",
                        active
                          ? "bg-hover font-medium text-fg"
                          : "text-muted hover:bg-hover/60 hover:text-fg",
                      )}
                    >
                      <span className="truncate font-mono text-body">{tbl.name}</span>
                      <span className="text-caption tabular-nums text-faint">
                        {tbl.rowCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-x-auto p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h4 className="font-mono text-section font-semibold text-fg">
                  {data.selectedTable}
                </h4>
                <span className="text-caption text-muted">
                  显示最近 {data.rows.length} 行{data.truncated ? "（内容过大已截断）" : ""}
                </span>
              </div>

              {data.columns.length === 0 ? (
                <p className="text-body text-muted">无字段</p>
              ) : (
                <table className="w-full border-collapse text-left text-body">
                  <thead>
                    <tr className="border-b border-border text-caption text-muted">
                      {data.columns.map((col) => (
                        <th
                          key={col.name}
                          className="whitespace-nowrap py-2 pr-4 font-medium"
                        >
                          {col.name}
                          {col.pk && (
                            <span className="ml-1 text-micro text-accent">PK</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {data.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={data.columns.length}
                          className="py-6 text-center text-muted"
                        >
                          该表暂无记录
                        </td>
                      </tr>
                    ) : (
                      data.rows.map((row, rIdx) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: arbitrary SQL result rows have no unique row key
                        <tr key={rIdx} className="align-top">
                          {data.columns.map((col) => (
                            <td
                              key={col.name}
                              className="max-w-[260px] break-all py-2.5 pr-4 font-mono text-caption text-fg"
                            >
                              {formatCell(row[col.name])}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  TimeAgo,
} from "../../components";
import { adminGet } from "../../lib/adminApi";
import { buildDiffRows, FormatJsonValue } from "./diff";

const PAGE_SIZE = 100;

/** GET /api/admin/audit 行(与后端 serializeAudit 逐字段对齐)。 */
export interface AdminAuditRow {
  id: string;
  admin_id: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}
interface AuditResp {
  rows: AdminAuditRow[];
  next_before: string | null;
}
interface Filter {
  adminId: string;
  action: string;
}

/** before/after 顶层对比表 + 变更行高亮。 */
function DiffBody({ row }: { row: AdminAuditRow }) {
  const rows = buildDiffRows(row.before, row.after);
  return (
    <div className="flex flex-col gap-4">
      {/* 元信息 */}
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
        <KeyValue label="动作" value={<Badge tone="neutral">{row.action}</Badge>} />
        <KeyValue
          label="操作者"
          value={<span className="font-mono text-[12px]">{row.admin_id}</span>}
        />
        <KeyValue
          label="对象"
          value={
            row.target ? (
              <span className="font-mono text-[12px] break-all">{row.target}</span>
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue label="IP" value={<span className="font-mono text-[12px]">{row.ip ?? "—"}</span>} />
        <KeyValue
          label="User-Agent"
          value={
            <span className="break-all text-[12px] text-muted">{row.user_agent ?? "—"}</span>
          }
        />
        <KeyValue label="时间" value={<TimeAgo value={row.created_at} />} />
      </div>

      {/* 并排等宽 JSON 对比 */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="w-28 whitespace-nowrap px-3 py-2 text-left text-[12px] font-medium text-faint">
                字段
              </th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-faint">变更前</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-faint">变更后</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.key}
                data-testid={`diff-row-${d.key}`}
                data-changed={String(d.changed)}
                className={
                  d.changed
                    ? "border-b border-border/60 bg-warning-soft last:border-0"
                    : "border-b border-border/60 last:border-0"
                }
              >
                <td className="px-3 py-2 align-top font-mono text-[12px] text-muted break-all">
                  {d.key}
                </td>
                <td className="px-3 py-2 align-top text-[13px] text-fg">
                  <FormatJsonValue value={d.before} />
                </td>
                <td className="px-3 py-2 align-top text-[13px] text-fg">
                  <FormatJsonValue value={d.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminAuditTab() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>({ adminId: "", action: "" });
  const [dAdmin, setDAdmin] = useState("");
  const [dAction, setDAction] = useState("");

  const [rows, setRows] = useState<AdminAuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<AdminAuditRow | null>(null);

  // 提交的过滤(或手动刷新)变化 → 废弃在飞、重拉第一页。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRows([]);
    setCursor(null);
    (async () => {
      try {
        const data = await adminGet<AuditResp>("/audit", {
          limit: PAGE_SIZE,
          admin_id: filter.adminId,
          action: filter.action,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setCursor(data.next_before ?? null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, reloadTick]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await adminGet<AuditResp>("/audit", {
        limit: PAGE_SIZE,
        admin_id: filter.adminId,
        action: filter.action,
        before: cursor,
      });
      setRows((prev) => [...prev, ...(data.rows ?? [])]);
      setCursor(data.next_before ?? null);
    } catch (e) {
      toast(`加载失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () => setFilter({ adminId: dAdmin.trim(), action: dAction.trim() });
  const clear = () => {
    setDAdmin("");
    setDAction("");
    setFilter({ adminId: "", action: "" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  const columns: Column<AdminAuditRow>[] = [
    {
      key: "admin_id",
      title: "操作者",
      render: (r) => <CopyChip value={r.admin_id} />,
    },
    {
      key: "action",
      title: "动作",
      render: (r) => <Badge tone="neutral">{r.action}</Badge>,
    },
    {
      key: "target",
      title: "对象",
      render: (r) =>
        r.target ? <CopyChip value={r.target} /> : <span className="text-faint">—</span>,
    },
    {
      key: "ip",
      title: "IP",
      cellClassName: "font-mono text-[12px] text-muted",
      render: (r) => r.ip ?? "—",
    },
    {
      key: "created_at",
      title: "时间",
      render: (r) => <TimeAgo value={r.created_at} />,
    },
    {
      key: "_diff",
      title: "",
      align: "right",
      render: (r) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setSelected(r);
          }}
        >
          查看 diff
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <Input
          value={dAdmin}
          onChange={(e) => setDAdmin(e.target.value)}
          onKeyDown={onKey}
          placeholder="操作者 admin_id"
          className="h-9 w-full sm:w-44"
        />
        <Input
          value={dAction}
          onChange={(e) => setDAction(e.target.value)}
          onKeyDown={onKey}
          placeholder="动作前缀(如 user.)"
          className="h-9 w-full sm:w-52"
        />
        <Button variant="primary" size="sm" onClick={apply}>
          查询
        </Button>
        <Button variant="ghost" size="sm" onClick={clear}>
          重置
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadTick((t) => t + 1)}
          title="刷新"
          aria-label="刷新"
        >
          <RotateCw size={15} />
        </Button>
      </FilterBar>

      {error && (
        <p className="text-sm text-danger">加载失败：{error.message}</p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setSelected(r)}
        emptyTitle="暂无审计记录"
        emptyHint="调整过滤条件或稍后再试。"
      />

      {cursor && (
        <div className="flex justify-center py-1">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </Button>
        </div>
      )}

      <Modal
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title="审计变更对比"
        description="合并 before / after 顶层字段,变更项高亮(不递归深 diff)。"
        className="max-w-3xl"
        footer={
          <Button variant="ghost" onClick={() => setSelected(null)}>
            关闭
          </Button>
        }
      >
        {selected && <DiffBody row={selected} />}
      </Modal>
    </div>
  );
}

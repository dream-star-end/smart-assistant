import { AlertTriangle, RotateCw, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  SectionCard,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { buildDiffRows, DiffTable } from "./diff";

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
  /** 精确匹配，格式 `类型:id`。 */
  target: string;
  /** ISO 8601（含时区）。datetime-local 草稿在提交时归一化为 ISO。 */
  createdFrom: string;
  createdTo: string;
}

/** datetime-local 值（本地时间，无时区）→ ISO 8601；空/非法 → 空串（不下发）。 */
function toIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** before/after 顶层对比表 + 变更行高亮。 */
function DiffBody({ row }: { row: AdminAuditRow }) {
  const rows = buildDiffRows(row.before, row.after);
  return (
    <div className="flex flex-col gap-4">
      {/* 元信息 */}
      <div className="oc-surface-recessed divide-y divide-border/60 rounded-xl px-4 py-1">
        <KeyValue label="动作" value={<Badge tone="accent">{row.action}</Badge>} />
        <KeyValue
          label="操作者"
          value={<CopyChip value={row.admin_id} />}
        />
        <KeyValue
          label="对象"
          value={
            row.target ? (
              <CopyChip value={row.target} />
            ) : (
              <span className="text-faint">—</span>
            )
          }
        />
        <KeyValue
          label="IP"
          value={<span className="font-mono text-meta tabular-nums">{row.ip ?? "—"}</span>}
        />
        <KeyValue
          label="User-Agent"
          value={
            <span className="break-all text-meta text-muted">{row.user_agent ?? "—"}</span>
          }
        />
        <KeyValue
          label="时间"
          value={
            <span className="tabular-nums">
              <TimeAgo value={row.created_at} />
            </span>
          }
        />
      </div>

      {/* IDE 级并排等宽 JSON 对比 */}
      <DiffTable rows={rows} />
    </div>
  );
}

export function AdminAuditTab() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>({
    adminId: "",
    action: "",
    target: "",
    createdFrom: "",
    createdTo: "",
  });
  const [dAdmin, setDAdmin] = useState("");
  const [dAction, setDAction] = useState("");
  const [dTarget, setDTarget] = useState("");
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");

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
          target: filter.target,
          created_from: filter.createdFrom,
          created_to: filter.createdTo,
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
        target: filter.target,
        created_from: filter.createdFrom,
        created_to: filter.createdTo,
        before: cursor,
      });
      setRows((prev) => [...prev, ...(data.rows ?? [])]);
      setCursor(data.next_before ?? null);
    } catch (e) {
      toast(`加载失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () =>
    setFilter({
      adminId: dAdmin.trim(),
      action: dAction.trim(),
      target: dTarget.trim(),
      createdFrom: toIso(dFrom),
      createdTo: toIso(dTo),
    });
  const clear = () => {
    setDAdmin("");
    setDAction("");
    setDTarget("");
    setDFrom("");
    setDTo("");
    setFilter({ adminId: "", action: "", target: "", createdFrom: "", createdTo: "" });
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
      cellClassName: "font-mono text-meta tabular-nums text-muted",
      render: (r) => r.ip ?? "—",
    },
    {
      key: "created_at",
      title: "时间",
      cellClassName: "tabular-nums",
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
    <div className="flex flex-col gap-4">
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
        <Input
          value={dTarget}
          onChange={(e) => setDTarget(e.target.value)}
          onKeyDown={onKey}
          placeholder="对象(类型:id)"
          className="h-9 w-full sm:w-48"
          aria-label="对象精确匹配"
        />
        <label className="flex items-center gap-1.5 text-meta text-faint">
          从
          <Input
            type="datetime-local"
            value={dFrom}
            onChange={(e) => setDFrom(e.target.value)}
            onKeyDown={onKey}
            className="h-9 w-[13.5rem] tabular-nums"
            aria-label="起始时间"
          />
        </label>
        <label className="flex items-center gap-1.5 text-meta text-faint">
          到
          <Input
            type="datetime-local"
            value={dTo}
            onChange={(e) => setDTo(e.target.value)}
            onKeyDown={onKey}
            className="h-9 w-[13.5rem] tabular-nums"
            aria-label="结束时间"
          />
        </label>
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
          className="oc-icon-btn-tactile"
        >
          <RotateCw size={15} className={loading ? "animate-spin" : undefined} />
        </Button>
      </FilterBar>

      {error && (
        <div
          role="alert"
          className="oc-callout oc-callout-danger flex items-start gap-3 rounded-xl px-4 py-3 text-body"
        >
          <span className="oc-icon-badge oc-icon-badge-danger mt-0.5 size-7 rounded-lg">
            <AlertTriangle size={14} />
          </span>
          <p className="min-w-0 flex-1 text-danger">
            加载失败：{apiErrorMessage(error, "加载失败")}
          </p>
        </div>
      )}

      <SectionCard
        title="管理操作记录"
        hint="记录后台管理员写操作，点击行或「查看 diff」核对变更前后字段"
        icon={ScrollText}
        iconTone="accent"
        action={
          !loading && (
            <span className="oc-badge-craft rounded-full bg-hover px-2.5 py-0.5 font-mono text-caption text-muted tabular-nums">
              已加载 {rows.length.toLocaleString("zh-CN")} 条
            </span>
          )
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          onRowClick={(r) => setSelected(r)}
          emptyTitle="暂无审计记录"
          emptyHint="调整过滤条件或稍后再试。"
          className="rounded-none border-0 shadow-none"
          footer={
            cursor ? (
              <div className="flex justify-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : undefined
          }
        />
      </SectionCard>

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

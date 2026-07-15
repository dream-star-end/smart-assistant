import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  Pagination,
  TimeAgo,
} from "../../components";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { FormatJsonValue } from "./diff";

const PAGE_SIZE = 50;

/** GET /api/admin/agent-audit 行(与后端 serializeRow 逐字段对齐)。 */
export interface AgentAuditRow {
  id: string;
  user_id: string;
  session_id: string;
  tool: string;
  input_meta: unknown;
  input_hash: string | null;
  output_hash: string | null;
  duration_ms: number | null;
  success: boolean;
  error_msg: string | null;
  created_at: string;
}
interface AuditResp {
  rows: AgentAuditRow[];
  next_before: string | null;
}
interface Filter {
  userId: string;
  tool: string;
}

const ERROR_CLASS_LABELS: Record<string, string> = {
  unknown_skill: "未知技能",
  command_not_found: "命令缺失",
  file_not_found: "文件缺失",
  permission_denied: "权限拒绝",
  timeout: "超时",
  cancelled: "已取消",
  validation_error: "参数校验",
  rate_limited: "限流",
  service_unavailable: "服务不可用",
  network_error: "网络错误",
  other: "其他",
};

function errorClassOf(row: AgentAuditRow): string {
  if (row.input_meta && typeof row.input_meta === "object" && !Array.isArray(row.input_meta)) {
    const value = (row.input_meta as Record<string, unknown>).error_class;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "other";
}

function errorClassLabel(row: AgentAuditRow): string {
  const value = errorClassOf(row);
  return ERROR_CLASS_LABELS[value] ?? value;
}

/** 单次工具调用详情:元信息 + input_meta / hash。 */
function DetailBody({ row }: { row: AgentAuditRow }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
        <KeyValue label="工具" value={<Badge tone="accent">{row.tool}</Badge>} />
        <KeyValue
          label="用户"
          value={<span className="font-mono text-[12px]">{row.user_id}</span>}
        />
        <KeyValue
          label="会话"
          value={<span className="font-mono text-[12px] break-all">{row.session_id}</span>}
        />
        <KeyValue
          label="耗时"
          value={
            <span className="tabular-nums">
              {row.duration_ms == null ? "—" : `${row.duration_ms}ms`}
            </span>
          }
        />
        <KeyValue label="错误分类" value={<Badge tone="danger">{errorClassLabel(row)}</Badge>} />
        <KeyValue
          label="input_hash"
          value={<span className="font-mono text-[12px] break-all">{row.input_hash ?? "—"}</span>}
        />
        <KeyValue
          label="output_hash"
          value={<span className="font-mono text-[12px] break-all">{row.output_hash ?? "—"}</span>}
        />
        <KeyValue label="时间" value={<TimeAgo value={row.created_at} />} />
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-faint">input_meta</p>
        <FormatJsonValue value={row.input_meta} />
      </div>
    </div>
  );
}

export function AgentAuditTab() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>({ userId: "", tool: "" });
  const [dUser, setDUser] = useState("");
  const [dTool, setDTool] = useState("");

  // keyset 分页:cursor = 当前页 before(undefined=首页);history = 已翻过的前序游标(供返回)。
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [rows, setRows] = useState<AgentAuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [detail, setDetail] = useState<AgentAuditRow | null>(null);

  // filter/cursor/刷新 变化 → 拉当前页。history 只影响页码显示,不入依赖。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await adminGet<AuditResp>("/agent-audit", {
          limit: PAGE_SIZE,
          user_id: filter.userId,
          tool: filter.tool,
          before: cursor,
        });
        if (!alive) return;
        setRows(data.rows ?? []);
        setNextCursor(data.next_before ?? null);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setRows([]);
          setNextCursor(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, cursor, reloadTick]);

  // 提交新过滤 → 回到首页(cursor=undefined、清空 history)。
  const apply = () => {
    setFilter({ userId: dUser.trim(), tool: dTool.trim() });
    setHistory([]);
    setCursor(undefined);
  };
  const clear = () => {
    setDUser("");
    setDTool("");
    setFilter({ userId: "", tool: "" });
    setHistory([]);
    setCursor(undefined);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  const goNext = () => {
    if (!nextCursor) return;
    setHistory((h) => [...h, cursor]);
    setCursor(nextCursor);
  };
  const goPrev = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCursor(prev);
  };

  const columns: Column<AgentAuditRow>[] = [
    {
      key: "user_id",
      title: "用户",
      render: (r) => <CopyChip value={r.user_id} />,
    },
    {
      key: "session_id",
      title: "会话",
      render: (r) => <CopyChip value={r.session_id} />,
    },
    {
      key: "tool",
      title: "工具",
      render: (r) => <Badge tone="accent">{r.tool}</Badge>,
    },
    {
      key: "duration_ms",
      title: "耗时",
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (r) => (r.duration_ms == null ? "—" : `${r.duration_ms}ms`),
    },
    {
      key: "error_class",
      title: "错误分类",
      render: (r) => <Badge tone="danger">{errorClassLabel(r)}</Badge>,
    },
    {
      key: "created_at",
      title: "时间",
      render: (r) => <TimeAgo value={r.created_at} />,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar>
        <Input
          value={dUser}
          onChange={(e) => setDUser(e.target.value)}
          onKeyDown={onKey}
          placeholder="用户 user_id"
          className="h-9 w-full sm:w-44"
        />
        <Input
          value={dTool}
          onChange={(e) => setDTool(e.target.value)}
          onKeyDown={onKey}
          placeholder="工具名(如 Bash)"
          className="h-9 w-full sm:w-48"
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

      {error && <p className="text-sm text-danger">加载失败：{apiErrorMessage(error, "加载失败")}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setDetail(r)}
        emptyTitle="暂无工具失败记录"
        emptyHint="调整过滤条件或稍后再试。"
      />

      <Pagination
        offset={history.length * PAGE_SIZE}
        limit={PAGE_SIZE}
        count={rows.length}
        onChange={(nextOffset) => {
          if (nextOffset > history.length * PAGE_SIZE) goNext();
          else goPrev();
        }}
      />

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title="工具调用详情"
        className="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail && <DetailBody row={detail} />}
      </Modal>
    </div>
  );
}

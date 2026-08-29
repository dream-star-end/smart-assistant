import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Badge, Button, useToast } from "../../../components/ui";
import { type Column, DataTable, LevelBadge, SectionCard, TimeAgo } from "../../components";
import { ApiError, adminGet, adminSend } from "../../lib/adminApi";
import { SEVERITY_TONE, TRIGGER_HINT, TRIGGER_LABEL, groupLabel, orderedGroups } from "./constants";
import { type Reloadable, useReloadable } from "./useReloadable";
import type { CoverageRow, RuleStateRow } from "./types";
import { errText } from "./util";

export function RulesCoverageTab({ ruleStatesQ }: { ruleStatesQ: Reloadable<{ rows: RuleStateRow[] }> }) {
  return (
    <div className="flex flex-col gap-5">
      <RuleStatesSection query={ruleStatesQ} />
      <CoverageSection />
    </div>
  );
}

// ─── 规则状态 ─────────────────────────────────────────────────────────

function RuleStatesSection({ query }: { query: Reloadable<{ rows: RuleStateRow[] }> }) {
  const toast = useToast();
  const { data, loading, error, reload } = query;
  const rows = data?.rows ?? [];

  const onAck = async (r: RuleStateRow) => {
    try {
      await adminSend("POST", `/alerts/rules/${encodeURIComponent(r.rule_id)}/ack`);
      toast("已确认", "success");
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FIRING") {
        toast("规则当前未在 firing,无需确认", "error");
        reload();
      } else {
        toast(errText(e), "error");
      }
    }
  };

  const columns: Column<RuleStateRow>[] = [
    {
      key: "rule_id",
      title: "rule_id",
      render: (r) => (
        <span className="flex items-center gap-2">
          {r.classification === "firing" && !r.acked && <span className="size-1.5 shrink-0 rounded-full bg-danger" />}
          <span className="font-mono text-[12.5px]">{r.rule_id}</span>
        </span>
      ),
    },
    {
      key: "status",
      title: "状态",
      width: 96,
      render: (r) =>
        r.classification === "stale" ? (
          <Badge tone="warning">STALE</Badge>
        ) : r.classification === "healthy" ? (
          <Badge tone="neutral">HEALTHY</Badge>
        ) : !r.firing ? (
          <Badge tone="success">RECOVERED</Badge>
        ) : r.acked ? (
          <Badge tone="warning">ACKED</Badge>
        ) : (
          <Badge tone="danger">FIRING</Badge>
        ),
    },
    {
      key: "ack",
      title: "确认",
      width: 130,
      render: (r) => {
        if (r.classification !== "firing") return <span className="text-faint">—</span>;
        if (r.acked)
          return (
            <span className="text-[12px]">
              #{r.acked_by ?? "?"}{" "}
              {r.acked_at && <span className="text-faint">(<TimeAgo value={r.acked_at} />)</span>}
            </span>
          );
        return <span className="text-faint">未确认</span>;
      },
    },
    {
      key: "dedupe_key",
      title: "dedupe_key",
      render: (r) => <span className="font-mono text-[12px] text-faint">{r.dedupe_key ?? "—"}</span>,
    },
    {
      key: "last_transition_at",
      title: "最近翻转",
      width: 96,
      render: (r) => (r.last_transition_at ? <TimeAgo value={r.last_transition_at} /> : "—"),
    },
    {
      key: "last_evaluated_at",
      title: "最近评估",
      width: 96,
      render: (r) => (r.last_evaluated_at ? <TimeAgo value={r.last_evaluated_at} /> : "—"),
    },
    {
      key: "last_payload",
      title: "最近 payload",
      render: (r) => {
        const s = JSON.stringify(r.last_payload ?? {});
        return (
          <span className="line-clamp-1 max-w-[240px] font-mono text-[11.5px] text-faint" title={s}>
            {s}
          </span>
        );
      },
    },
    {
      key: "actions",
      title: "操作",
      width: 72,
      align: "right",
      render: (r) =>
        r.classification === "firing" && !r.acked ? (
          <Button variant="secondary" size="sm" onClick={() => onAck(r)}>
            确认
          </Button>
        ) : null,
    },
  ];

  return (
    <SectionCard
      title="规则状态"
      hint="FIRING 当前异常 · RECOVERED 已恢复 · STALE 长时间未评估 · HEALTHY 当前健康"
      action={
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
        </Button>
      }
      bodyClassName="p-0"
    >
      {error ? (
        <div className="px-5 py-4 text-[13px] text-danger">加载规则状态失败: {errText(error)}</div>
      ) : (
        <DataTable
          className="rounded-none border-0"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.rule_id}
          loading={loading}
          emptyTitle="尚无规则状态"
          emptyHint="scheduler 还没跑过一轮,或没有 polled 规则。"
        />
      )}
    </SectionCard>
  );
}

// ─── 事件覆盖矩阵 ─────────────────────────────────────────────────────

function CoverageSection() {
  const { data, loading, error, reload } = useReloadable<{ rows: CoverageRow[] }>(() =>
    adminGet("/alerts/events/coverage"),
  );
  const rows = data?.rows ?? [];

  const { grouped, groupKeys, orphanCount } = useMemo(() => {
    const byGroup: Record<string, CoverageRow[]> = {};
    let orphan = 0;
    for (const r of rows) {
      (byGroup[r.group] ??= []).push(r);
      if (r.subscriber_count === 0) orphan++;
    }
    return { grouped: byGroup, groupKeys: orderedGroups(Object.keys(byGroup)), orphanCount: orphan };
  }, [rows]);

  return (
    <SectionCard
      title="事件覆盖矩阵"
      hint="事件目录 × 通道订阅 —— 谁能收、可否投递、最近一次入队"
      action={
        <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
        </Button>
      }
    >
      {error ? (
        <div className="text-[13px] text-danger">加载覆盖矩阵失败: {errText(error)}</div>
      ) : loading && rows.length === 0 ? (
        <div className="text-[13px] text-faint">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="text-[13px] text-faint">暂无事件(EVENT_META 为空?)</div>
      ) : (
        <div className="flex flex-col gap-5">
          {orphanCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-[12.5px] text-warning">
              <AlertTriangle size={15} className="shrink-0" />
              <span>
                有 <strong className="tabular-nums">{orphanCount}</strong> 个事件<strong>没有主动通道订阅</strong>
                ，仅会写入管理员站内信兜底；如需及时主动送达，请新增或编辑通道订阅。
              </span>
            </div>
          )}
          {groupKeys.map((g) => (
            <CoverageGroup key={g} group={g} rows={grouped[g]} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CoverageGroup({ group, rows }: { group: string; rows: CoverageRow[] }) {
  const columns: Column<CoverageRow>[] = [
    {
      key: "event_type",
      title: "事件",
      render: (r) => (
        <div>
          <div className="font-mono text-[12.5px] text-fg">{r.event_type}</div>
          {r.description && <div className="text-[11.5px] text-faint">{r.description}</div>}
        </div>
      ),
    },
    { key: "severity", title: "严重度", width: 84, render: (r) => <LevelBadge level={r.severity} /> },
    {
      key: "trigger",
      title: "触发",
      width: 72,
      render: (r) => (
        <Badge tone="neutral" title={TRIGGER_HINT[r.trigger]}>
          {TRIGGER_LABEL[r.trigger] ?? r.trigger}
        </Badge>
      ),
    },
    {
      key: "subscriber_count",
      title: "订阅",
      width: 68,
      align: "right",
      render: (r) =>
        r.subscriber_count === 0 ? (
          <Badge tone="danger" title="没有任何通道订阅这个事件">
            0
          </Badge>
        ) : (
          <span className="tabular-nums">{r.subscriber_count}</span>
        ),
    },
    {
      key: "deliverable_count",
      title: "可投递",
      width: 72,
      align: "right",
      render: (r) => {
        if (r.subscriber_count > 0 && r.deliverable_count === 0) {
          return (
            <Badge tone="warning" title="有通道订阅但 severity_min 卡住 / iLink 未激活,当前投递不出去">
              0
            </Badge>
          );
        }
        return <span className="tabular-nums">{r.deliverable_count}</span>;
      },
    },
    {
      key: "last_fired_at",
      title: "最近入队",
      width: 96,
      render: (r) =>
        r.last_fired_at ? (
          <span title={r.last_severity ? `最近 severity: ${r.last_severity}` : undefined}>
            <TimeAgo value={r.last_fired_at} />
          </span>
        ) : (
          <span className="text-faint">从未</span>
        ),
    },
  ];

  return (
    <div>
      <h4 className="mb-2 text-[12.5px] font-semibold text-fg">
        {groupLabel(group)} <span className="font-normal text-faint">({rows.length})</span>
      </h4>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.event_type} />
    </div>
  );
}

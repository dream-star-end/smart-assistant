import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Modal, useConfirm, useToast } from "../../../components/ui";
import {
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  KeyValue,
  LevelBadge,
  SectionCard,
  SelectFilter,
  TimeAgo,
} from "../../components";
import { PageHeader } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import { getAdminPage } from "../../registry";
import {
  ACTIVE_REPAIR_STATUSES,
  type IncidentDetailResp,
  type IncidentListResp,
  type IncidentRow,
  type IncidentStatus,
  type RepairEventRow,
  type RepairRow,
  type RepairStatus,
} from "./types";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const POLL_MS = 15_000;
const PAGE = 50;
const MAX_LIMIT = 300;

/** incident status → 徽标（open=未恢复 / repairing=修复中 / resolved=已恢复）。 */
const INCIDENT_STATUS_META: Record<IncidentStatus, { label: string; tone: BadgeTone }> = {
  open: { label: "未恢复", tone: "danger" },
  repairing: { label: "修复中", tone: "warning" },
  resolved: { label: "已恢复", tone: "success" },
};

const STATUS_OPTS: { label: string; value: "" | IncidentStatus }[] = [
  { label: "全部状态", value: "" },
  { label: "未恢复", value: "open" },
  { label: "修复中", value: "repairing" },
  { label: "已恢复", value: "resolved" },
];

/** repair 状态 → 徽标色（未知回落 neutral）。 */
const REPAIR_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  dispatched: "accent",
  acked: "accent",
  running: "info",
  verifying: "info",
  succeeded: "success",
  verification_failed: "danger",
  verification_inconclusive: "warning",
  failed: "danger",
  timeout: "danger",
  cancel_requested: "warning",
  cancelling: "warning",
  cancelled: "warning",
  cancel_failed: "danger",
  orphaned: "danger",
};

function repairTone(status: RepairStatus): BadgeTone {
  return REPAIR_STATUS_TONE[status] ?? "neutral";
}

/** 该 repair 的最新事件（时间线里“正在做啥”=最新 progress/note）。 */
function latestEventFor(repairId: string, events: RepairEventRow[]): RepairEventRow | null {
  let latest: RepairEventRow | null = null;
  for (const e of events) {
    if (e.repair_id !== repairId) continue;
    if (!latest || e.created_at > latest.created_at) latest = e;
  }
  return latest;
}

/**
 * 事故详情弹窗体 —— 经 key 按 incidentId 挂载，自拉 detail（15s 轮询以跟进进行中 repair）。
 * 顶部「正在修复」卡（活跃 repair 的最新进度）；随后 incident 全字段 + repairs + 事件时间线。
 * retry/cancel 属切片②，置灰留 TODO。
 */
function IncidentDetailBody({ id }: { id: string }) {
  const { data, error, loading, refresh } = useAdminPoll<IncidentDetailResp>(
    () => adminGet(`/selfheal/incidents/${encodeURIComponent(id)}`),
    { intervalMs: POLL_MS, deps: [id] },
  );

  const sortedEvents = useMemo(
    () => [...(data?.events ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [data],
  );
  const activeRepair = useMemo(
    () => (data?.repairs ?? []).find((r) => ACTIVE_REPAIR_STATUSES.has(r.status)) ?? null,
    [data],
  );

  if (loading && !data) {
    return <p className="py-6 text-center text-[13px] text-muted">加载详情…</p>;
  }
  if (error) {
    return (
      <p className="py-6 text-center text-[13px] text-danger">
        加载详情失败：{apiErrorMessage(error, "请求失败")}
      </p>
    );
  }
  if (!data) return null;

  const inc = data.incident;
  const activeEvent = activeRepair ? latestEventFor(activeRepair.id, sortedEvents) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 正在修复卡（活跃 repair 的最新进度）。 */}
      {activeRepair && (
        <div className="rounded-lg border border-info/40 bg-info-soft px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-info">
            <RefreshCw size={14} className="animate-spin" />
            正在修复（第 {activeRepair.attempt} 次尝试 · {activeRepair.status}）
          </div>
          <div className="mt-1.5 text-[13px] text-fg">
            {activeEvent
              ? activeEvent.message?.trim() || `进度：${activeEvent.kind}`
              : "已派发 codex 修复，等待首个进度回报…"}
          </div>
        </div>
      )}

      {/* incident 全字段（服务端已 redaction，仅挑已知字段展示，不吐任意 JSON）。 */}
      <div className="rounded-lg border border-border bg-surface px-4 py-2">
        <KeyValue
          label="状态"
          value={
            <Badge tone={INCIDENT_STATUS_META[inc.status]?.tone ?? "neutral"}>
              {INCIDENT_STATUS_META[inc.status]?.label ?? inc.status}
            </Badge>
          }
        />
        <KeyValue label="严重度" value={<LevelBadge level={inc.severity} />} />
        <KeyValue label="影响面" value={<span className="font-mono text-[12px]">{inc.surface}</span>} />
        <KeyValue
          label="事故 ID"
          value={<CopyChip value={inc.id} className="justify-end" />}
        />
        {inc.condition_key != null && (
          <KeyValue
            label="condition"
            value={<span className="font-mono text-[12px] break-all">{inc.condition_key}</span>}
          />
        )}
        {inc.rev != null && (
          <KeyValue label="rev" value={<span className="tabular-nums">{inc.rev}</span>} />
        )}
        {inc.audience != null && <KeyValue label="推送范围" value={inc.audience} />}
        <KeyValue label="用户标题" value={<span className="text-fg">{inc.user_title}</span>} />
        {inc.user_message != null && (
          <KeyValue
            label="用户文案"
            value={<span className="text-muted">{inc.user_message}</span>}
          />
        )}
        <KeyValue label="发生时间" value={<TimeAgo value={inc.opened_at} />} />
        {inc.resolved_at != null && (
          <KeyValue label="恢复时间" value={<TimeAgo value={inc.resolved_at} />} />
        )}
        <KeyValue label="更新时间" value={<TimeAgo value={inc.updated_at} />} />
      </div>

      {/* 关联 repairs。 */}
      <SectionCard
        title={`codex 修复（${data.repairs.length}）`}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            title="刷新详情"
            aria-label="刷新详情"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </Button>
        }
        bodyClassName="p-0"
      >
        {data.repairs.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted">未触发自动修复。</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.repairs.map((r: RepairRow) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={repairTone(r.status)}>{r.status}</Badge>
                    <span className="text-[12px] text-faint">第 {r.attempt} 次</span>
                  </div>
                  {r.summary && (
                    <p className="mt-1 text-[13px] text-fg break-words">{r.summary}</p>
                  )}
                  <p className="mt-0.5 text-[11.5px] text-faint">
                    <TimeAgo value={r.started_at ?? r.finished_at ?? inc.opened_at} />
                    {r.finished_at && (
                      <>
                        {" → "}
                        <TimeAgo value={r.finished_at} />
                      </>
                    )}
                  </p>
                </div>
                {/* 切片②：retry/cancel 置灰留 TODO（本切片不做修复动作）。 */}
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="ghost" size="sm" disabled title="切片② 待实现">
                    重试
                  </Button>
                  <Button variant="ghost" size="sm" disabled title="切片② 待实现">
                    取消
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* 事件时间线（append-only 进度流）。 */}
      <SectionCard title={`修复事件（${sortedEvents.length}）`} bodyClassName="p-0">
        {sortedEvents.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted">暂无进度事件。</p>
        ) : (
          <ol className="divide-y divide-border">
            {sortedEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2">
                <span className="mt-0.5 shrink-0">
                  <Badge tone="neutral">{e.kind}</Badge>
                </span>
                <div className="min-w-0 flex-1">
                  {e.message && (
                    <p className="text-[13px] text-fg break-words">{e.message}</p>
                  )}
                  <p className="text-[11.5px] text-faint">
                    <TimeAgo value={e.created_at} />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * 自愈修复审计页 —— 异常事故（incidents）与 codex 自动修复的只读审计 + 手动 resolve。
 * 上半：incidents 列表（status 过滤，useAdminPoll 15s）；点行开 Modal 看全字段 + repairs +
 * 事件时间线。行内动作首版仅 resolve（useConfirm 二次确认）；retry/cancel 属切片②，置灰留 TODO。
 */
export default function SelfhealPage() {
  const meta = getAdminPage("selfheal");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [status, setStatus] = useState<"" | IncidentStatus>("");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [resolving, setResolving] = useState(false);

  const { data, error, loading, refresh } = useAdminPoll<IncidentListResp>(
    () => adminGet("/selfheal/incidents", { status, limit }),
    { intervalMs: POLL_MS, deps: [status, limit] },
  );

  const incidents = data?.incidents ?? [];
  const canLoadMore = !!data?.nextBeforeId && limit < MAX_LIMIT;

  // 列表刷新后同步弹窗选中行的状态（如已被后台标记 resolved，footer 的 resolve 钮随之禁用）。
  useEffect(() => {
    if (!selected) return;
    const fresh = incidents.find((i) => i.id === selected.id);
    if (fresh && fresh.status !== selected.status) setSelected(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const onResolve = async (row: IncidentRow) => {
    const ok = await confirm({
      title: "手动标记为已恢复？",
      body: (
        <span className="text-[13px] text-muted">
          将向受影响用户推送恢复通知，并结束该事故。仅在确认异常已消除时操作。
        </span>
      ),
      confirmText: "标记已恢复",
    });
    if (!ok) return;
    setResolving(true);
    try {
      await adminSend("POST", `/selfheal/incidents/${encodeURIComponent(row.id)}/resolve`);
      toast("已标记为已恢复，恢复通知将下发", "success");
      setSelected(null);
      refresh();
    } catch (e) {
      toast(apiErrorMessage(e, "操作失败"), "error");
    } finally {
      setResolving(false);
    }
  };

  const columns: Column<IncidentRow>[] = [
    {
      key: "status",
      title: "状态",
      width: 92,
      render: (r) => {
        const m = INCIDENT_STATUS_META[r.status] ?? { label: r.status, tone: "neutral" as const };
        return <Badge tone={m.tone}>{m.label}</Badge>;
      },
    },
    {
      key: "severity",
      title: "严重度",
      width: 88,
      render: (r) => <LevelBadge level={r.severity} />,
    },
    {
      key: "surface",
      title: "影响面",
      width: 120,
      render: (r) => <span className="font-mono text-[12px] text-muted">{r.surface}</span>,
    },
    {
      key: "user_title",
      title: "用户标题",
      render: (r) => (
        <span className="line-clamp-1 max-w-[420px] text-fg" title={r.user_title}>
          {r.user_title}
        </span>
      ),
    },
    {
      key: "opened_at",
      title: "发生时间",
      width: 96,
      render: (r) => <TimeAgo value={r.opened_at} />,
    },
    {
      key: "actions",
      title: "",
      align: "right",
      width: 88,
      render: (r) =>
        r.status === "resolved" ? null : (
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              void onResolve(r);
            }}
            disabled={resolving}
          >
            标记恢复
          </Button>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />

      <div className="flex flex-col gap-3">
        <FilterBar>
          <SelectFilter
            label="状态"
            value={status}
            options={STATUS_OPTS}
            onChange={(v) => {
              setStatus(v as "" | IncidentStatus);
              setLimit(PAGE);
            }}
          />
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
          </Button>
        </FilterBar>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            <AlertTriangle size={15} className="shrink-0" />
            加载事故列表失败：{apiErrorMessage(error, "请求失败")}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={incidents}
          rowKey={(r) => r.id}
          loading={loading && incidents.length === 0}
          onRowClick={(r) => setSelected(r)}
          emptyTitle="暂无事故"
          emptyHint="当前过滤条件下没有异常事故记录。"
        />

        {canLoadMore && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE))}
            >
              加载更多
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.user_title ?? "事故详情"}
        description="异常事故全字段 + codex 修复记录与进度时间线（服务端已脱敏）。"
        className="max-w-3xl"
        footer={
          <>
            {selected && selected.status !== "resolved" && (
              <Button
                variant="primary"
                onClick={() => void onResolve(selected)}
                disabled={resolving}
              >
                {resolving ? "处理中…" : "标记已恢复"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setSelected(null)}>
              关闭
            </Button>
          </>
        }
      >
        {selected && <IncidentDetailBody key={selected.id} id={selected.id} />}
      </Modal>

      {confirmEl}
    </div>
  );
}

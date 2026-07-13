import { AlertTriangle, RefreshCw, Rocket } from "lucide-react";
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
  type ResolveResp,
  type SuppressedConditionRow,
  type SuppressedConditionsResp,
  type UserNoticeApprovalResp,
  type UserNoticeProposalRow,
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

/**
 * resolve 的 mode-aware 结果 → toast 文案(H1b 判定表,三种 resolution 区分展示;
 * 未知/缺失回落通用文案,兼容后端扩态)。
 */
const RESOLVE_TOAST: Record<string, string> = {
  suppressed_until_clear: "已压制该检测项并标记恢复；检测真实恢复后压制自动解除",
  condition_closed: "已关闭检测项并标记恢复；不会因此直接向用户发通知",
  condition_already_clear: "检测项已恢复，事故已标记恢复",
};
const RESOLVE_TOAST_FALLBACK = "已标记为已恢复；不会因此直接向用户发通知";

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
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [releasing, setReleasing] = useState(false);

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
  // 待放行 repair(设计 §B):status='running' 且时间线里有 message 含 'pending_release'
  // 的 progress 事件 = 修复已过验证、部署停待 boss 放行(Tier2 部署门)。
  const pendingReleaseRepair = useMemo(
    () =>
      (data?.repairs ?? []).find(
        (r) =>
          r.status === "running" &&
          sortedEvents.some(
            (e) =>
              e.repair_id === r.id &&
              e.kind === "progress" &&
              (e.message ?? "").includes("pending_release"),
          ),
      ) ?? null,
    [data, sortedEvents],
  );

  const onRelease = async (repairId: string) => {
    const ok = await confirm({
      title: "放行部署？",
      body: (
        <span className="text-[13px] text-muted">
          codex 修复已通过验证，部署正等待人工放行。确认后将通知执行侧合并并部署该修复
          （全链审计留痕）。仅在核对过修复内容后操作。
        </span>
      ),
      confirmText: "确认放行",
      danger: true,
    });
    if (!ok) return;
    setReleasing(true);
    try {
      await adminSend("POST", `/selfheal/repairs/${encodeURIComponent(repairId)}/release`);
      // BLOCKER1:200 = 个人版已同步确认部署完成(deployed),文案如实;失败(含个人版
      // 部署被拒/失败)走 catch,reason 由后端 RELEASE_FAILED message 透传。
      toast("已放行，个人版已确认部署完成", "success");
      refresh();
    } catch (e) {
      toast(apiErrorMessage(e, "放行失败"), "error");
    } finally {
      setReleasing(false);
    }
  };

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
      {/* 待放行卡（修复已过验证，部署停待人工放行 —— 一键放行经 useConfirm 二次确认）。 */}
      {pendingReleaseRepair && (
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-warning">
                <Rocket size={14} />
                修复已就绪，待放行部署
              </div>
              <div className="mt-1.5 text-[13px] text-fg">
                codex 修复已通过验证（第 {pendingReleaseRepair.attempt} 次尝试），部署等待人工放行。
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              className="shrink-0"
              onClick={() => void onRelease(pendingReleaseRepair.id)}
              disabled={releasing}
            >
              {releasing ? "放行中…" : "一键放行"}
            </Button>
          </div>
        </div>
      )}

      {/* 正在修复卡（活跃 repair 的最新进度；待放行时上卡已覆盖，不重复）。 */}
      {activeRepair && activeRepair.id !== pendingReleaseRepair?.id && (
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

      {confirmEl}
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
  const [unsuppressing, setUnsuppressing] = useState<string | null>(null);

  const { data, error, loading, refresh } = useAdminPoll<IncidentListResp>(
    () => adminGet("/selfheal/incidents", { status, limit }),
    { intervalMs: POLL_MS, deps: [status, limit] },
  );

  // 已压制的 conditions(H1b suppression:resolve 仍 firing 的 probe 类 → 压制投影
  // 直至真实恢复)。与 incidents 同节奏轮询,便于 resolve → 压制行即时出现。
  const {
    data: suppressedData,
    error: suppressedError,
    loading: suppressedLoading,
    refresh: refreshSuppressed,
  } = useAdminPoll<SuppressedConditionsResp>(
    () => adminGet("/selfheal/conditions", { suppressed: 1 }),
    { intervalMs: POLL_MS },
  );
  const { data: noticeData, error: noticeError, loading: noticeLoading } =
    useAdminPoll<UserNoticeApprovalResp>(() => adminGet("/selfheal/user-notices"), {
      intervalMs: POLL_MS,
    });

  const incidents = data?.incidents ?? [];
  const canLoadMore = !!data?.nextBeforeId && limit < MAX_LIMIT;
  const suppressedRows = suppressedData?.items ?? [];
  const noticeRows = noticeData?.proposals ?? [];

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
          只结束事故，不会直接向任何用户推送通知。用户恢复通知必须另行通过精确影响证据和企业微信审批。
        </span>
      ),
      confirmText: "标记已恢复",
    });
    if (!ok) return;
    setResolving(true);
    try {
      const r = await adminSend<ResolveResp | undefined>(
        "POST",
        `/selfheal/incidents/${encodeURIComponent(row.id)}/resolve`,
      );
      // mode-aware 结果分文案(H1b):压制至恢复 / 已关闭检测项 / 检测项已恢复。
      toast(RESOLVE_TOAST[r?.resolution ?? ""] ?? RESOLVE_TOAST_FALLBACK, "success");
      setSelected(null);
      refresh();
      refreshSuppressed(); // suppressed_until_clear 会新增压制行,立即反映
    } catch (e) {
      toast(apiErrorMessage(e, "操作失败"), "error");
    } finally {
      setResolving(false);
    }
  };

  const onUnsuppress = async (row: SuppressedConditionRow) => {
    const ok = await confirm({
      title: "解除压制？",
      body: (
        <span className="text-[13px] text-muted">
          解除后该检测项恢复正常投影：若仍在异常，下一轮探测（约 2 分钟内）会重新开启事故并推送告警。
        </span>
      ),
      confirmText: "解除压制",
    });
    if (!ok) return;
    setUnsuppressing(row.conditionKey);
    try {
      await adminSend("POST", "/selfheal/conditions/unsuppress", {
        conditionKey: row.conditionKey,
      });
      toast("已解除压制，该检测项恢复正常投影", "success");
      refreshSuppressed();
      refresh();
    } catch (e) {
      toast(apiErrorMessage(e, "操作失败"), "error");
    } finally {
      setUnsuppressing(null);
    }
  };

  const suppressedColumns: Column<SuppressedConditionRow>[] = [
    {
      key: "conditionKey",
      title: "检测项",
      render: (r) => <span className="font-mono text-[12px] break-all">{r.conditionKey}</span>,
    },
    {
      key: "level",
      title: "级别",
      width: 88,
      render: (r) => (r.level ? <LevelBadge level={r.level} /> : <span className="text-faint">—</span>),
    },
    {
      key: "suppressedAt",
      title: "压制时间",
      width: 96,
      render: (r) =>
        r.suppressedAt ? <TimeAgo value={r.suppressedAt} /> : <span className="text-faint">—</span>,
    },
    {
      key: "suppressedBy",
      title: "操作人",
      width: 120,
      render: (r) => (
        <span className="text-[12px] text-muted">{r.suppressedBy ?? "—"}</span>
      ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      width: 96,
      render: (r) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onUnsuppress(r)}
          disabled={unsuppressing !== null}
        >
          {unsuppressing === r.conditionKey ? "处理中…" : "解除压制"}
        </Button>
      ),
    },
  ];

  const noticeColumns: Column<UserNoticeProposalRow>[] = [
    { key: "shortCode", title: "审批码", width: 96, render: (r) => <CopyChip value={r.shortCode} /> },
    { key: "status", title: "状态", width: 92, render: (r) => <Badge tone={r.status === "sent" ? "success" : r.status === "pending" ? "warning" : "neutral"}>{r.status}</Badge> },
    { key: "incidentId", title: "事故/修复", render: (r) => <span className="font-mono text-[12px]">#{r.incidentId} / #{r.repairId}</span> },
    { key: "recipientCount", title: "冻结/实发", width: 100, render: (r) => <span>{r.recipientCount} / {r.sentRecipientCount ?? "—"}</span> },
    { key: "createdAt", title: "创建时间", width: 96, render: (r) => <TimeAgo value={r.createdAt} /> },
  ];

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

      <SectionCard
        title="用户恢复通知审批"
        hint="仅真实失败且已全自动恢复的在线用户可进入冻结人群；企微同意后才定向发送"
        bodyClassName="p-0"
      >
        <div className="border-b border-line px-4 py-3 text-[13px] text-muted">
          {noticeData?.binding?.active ? (
            <>审批人已绑定：{noticeData.binding.boundIdentity ?? "已绑定"}</>
          ) : noticeData?.binding ? (
            <>请在企业微信发送 <CopyChip value={`绑定审批 ${noticeData.binding.bindingCode}`} /> 完成唯一审批人绑定。</>
          ) : (
            <>等待可用的企业微信智能机器人通道。</>
          )}
        </div>
        {noticeError ? (
          <div className="px-4 py-3 text-[13px] text-danger">加载用户通知审批状态失败：{apiErrorMessage(noticeError, "请求失败")}</div>
        ) : (
          <DataTable
            columns={noticeColumns}
            rows={noticeRows}
            rowKey={(r) => r.id}
            loading={noticeLoading && noticeRows.length === 0}
            emptyTitle="暂无用户通知审批"
            emptyHint="默认不发用户告警；只有可信自动恢复与真实影响证据闭合后才会出现审批单。"
            className="rounded-none border-0"
          />
        )}
      </SectionCard>

      {/* 已压制的 conditions(H1b suppression 审计面:压制中 = 不投影/不派修,
          真实恢复自动解除;误压可在此手动解除)。 */}
      <SectionCard
        title="已压制的检测项"
        hint="resolve 仍异常的探测类事故后进入压制；检测真实恢复自动解除，误压可手动解除"
        bodyClassName="p-0"
      >
        {suppressedError ? (
          <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-danger">
            <AlertTriangle size={15} className="shrink-0" />
            加载已压制检测项失败：{apiErrorMessage(suppressedError, "请求失败")}
          </div>
        ) : (
          <DataTable
            columns={suppressedColumns}
            rows={suppressedRows}
            rowKey={(r) => r.conditionKey}
            loading={suppressedLoading && suppressedRows.length === 0}
            emptyTitle="当前没有被压制的检测项"
            emptyHint="手动 resolve 仍在异常的探测类事故后，压制记录会出现在这里。"
            className="rounded-none border-0"
          />
        )}
      </SectionCard>

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

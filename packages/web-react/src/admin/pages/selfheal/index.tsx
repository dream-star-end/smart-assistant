import { AlertTriangle, Check, FileText, RefreshCw, Rocket, ShieldX, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Modal, useConfirm, usePrompt, useToast } from "../../../components/ui";
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
  type ReleaseFuseClearResp,
  type ReleaseFuseResp,
  type ReleaseRequestAck,
  type ReleaseRequestRow,
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

function compareDecimalIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

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
    if (
      !latest ||
      e.created_at > latest.created_at ||
      (e.created_at === latest.created_at && compareDecimalIds(e.id, latest.id) > 0)
    ) {
      latest = e;
    }
  }
  return latest;
}

// ── 批1b：放行（Tier2 部署门）辅助 ──────────────────────────────────────────

const PENDING_RELEASE_PHASE = "pending_release";
/** 展示用短 sha / 短 hash（前 12 位；缺失回落 —）。 */
function short(v?: string | null, n = 12): string {
  return v ? v.slice(0, n) : "—";
}

/**
 * release request 状态 → 中文文案 + 徽标色（RFC MINOR：文案严格区分
 * 「代码已部署」与「事故已由探测验证恢复」—— deployed ≠ resolved）。未知回落 neutral。
 */
const RELEASE_STATUS_META: Record<string, { label: string; tone: BadgeTone; spin?: boolean }> = {
  queued: { label: "已提交，排队投递中", tone: "info" },
  accepted: { label: "执行侧已接收，准备部署", tone: "info" },
  deploying: { label: "正在部署…", tone: "info", spin: true },
  // deployed = 代码落地，事故是否恢复由探测（probe）另行裁决，不等于 resolved。
  deployed: { label: "代码已部署（等待探测确认事故恢复）", tone: "success" },
  deploy_failed: { label: "部署失败", tone: "danger" },
  deploy_unknown: { label: "部署结果未知，已触发全局熔断，等待人工裁决", tone: "danger" },
  manual_required: { label: "需人工处理（分类/权威复核未通过）", tone: "warning" },
  cancelled: { label: "已取消", tone: "neutral" },
};
/** 部署进行中（占用唯一活跃请求，不可再次放行）。 */
const RELEASE_INFLIGHT = new Set(["queued", "accepted", "deploying"]);
function releaseStatusMeta(status: string): { label: string; tone: BadgeTone; spin?: boolean } {
  return RELEASE_STATUS_META[status] ?? { label: status, tone: "neutral" };
}

/** 取该 repair 最新放行请求（按 updatedAt 降序，tiebreak createdAt）。 */
function latestReleaseRequest(reqs?: ReleaseRequestRow[]): ReleaseRequestRow | null {
  if (!reqs || reqs.length === 0) return null;
  return reqs.reduce((best, r) => {
    if (!best) return r;
    const a = `${r.updatedAt}#${r.createdAt}`;
    const b = `${best.updatedAt}#${best.createdAt}`;
    return a > b ? r : best;
  }, null as ReleaseRequestRow | null);
}

// —— detail 防御式解析（detail 是 redact 后的 Record<string,unknown>，字段全部可缺）——
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

interface PlanView {
  sha?: string;
  baseSha?: string;
  changedFiles: string[];
  changedFilesTotal: number;
  surfaces: string[];
  deployArgs: string[];
  manual: { path: string; reason: string }[];
  verifyLayers: string[];
  verificationLayers: { name: string; ok: boolean }[];
  deployPlanHash?: string;
  manifestHash?: string;
  /** 结构化完整（sha + deployPlanHash + manifestHash 齐备，对齐后端 §6.1 放行前置校验）。 */
  complete: boolean;
}

/**
 * 归一化 pending_release 事件 detail（契约 §11）为可展示 PlanView。
 * changedFiles 权威形状为分类器输出的 `{paths,total}`（契约 §7）；同时兼容
 * `string[]`（配 changedFilesTotal）与 `{files,total}` 两种历史形态。
 * 任一字段缺失均优雅降级（空数组 / undefined），绝不抛错。
 */
function normalizePlan(raw: Record<string, unknown> | null | undefined): PlanView {
  const d = raw ?? {};
  const sha = asStr(d.sha);
  const baseSha = asStr(d.baseSha);
  let changedFiles: string[];
  let changedFilesTotal: number;
  if (Array.isArray(d.changedFiles)) {
    changedFiles = asStrArr(d.changedFiles);
    changedFilesTotal =
      typeof d.changedFilesTotal === "number" ? d.changedFilesTotal : changedFiles.length;
  } else {
    const cf = asObj(d.changedFiles);
    changedFiles = asStrArr(cf.paths ?? cf.files);
    changedFilesTotal = typeof cf.total === "number" ? cf.total : changedFiles.length;
  }
  const cls = asObj(d.classification);
  const manual = (Array.isArray(cls.manual) ? cls.manual : [])
    .map((m) => {
      const o = asObj(m);
      const path = asStr(o.path);
      return path ? { path, reason: asStr(o.reason) ?? "unspecified" } : null;
    })
    .filter((x): x is { path: string; reason: string } => x !== null);
  const verificationLayers = (Array.isArray(asObj(d.verification).layers)
    ? (asObj(d.verification).layers as unknown[])
    : []
  )
    .map((l) => {
      const o = asObj(l);
      const name = asStr(o.name);
      return name ? { name, ok: o.ok === true } : null;
    })
    .filter((x): x is { name: string; ok: boolean } => x !== null);
  const deployPlanHash = asStr(d.deployPlanHash);
  const manifestHash = asStr(d.manifestHash);
  return {
    sha,
    baseSha,
    changedFiles,
    changedFilesTotal,
    surfaces: asStrArr(cls.surfaces),
    deployArgs: asStrArr(cls.deployArgs),
    manual,
    verifyLayers: asStrArr(cls.verifyLayers),
    verificationLayers,
    deployPlanHash,
    manifestHash,
    complete: !!sha && !!deployPlanHash && !!manifestHash,
  };
}

const CHANGED_FILES_SHOWN = 12;

/**
 * 待放行卡（RFC §6「human gate 是真信任锚」）—— 不允许盲点一键：
 * 展示 base→sha 短值、改动文件（截断+总数）、分类结果（surfaces/deployArgs/manual 高亮）、
 * 验证层结果、deployPlanHash 短值；manual 非空时按钮旁显著警示。
 * 放行为 202 异步：显示最新 release request 的状态流（沿用详情 15s 轮询驱动更新）。
 */
function PendingReleaseCard({
  repair,
  sourceEventId,
  planDetail,
  fuse,
  releasing,
  onRelease,
}: {
  repair: RepairRow;
  sourceEventId: string;
  planDetail: Record<string, unknown> | null | undefined;
  fuse: ReleaseFuseResp | null;
  releasing: boolean;
  onRelease: (repairId: string, manualCount: number, sourceEventId: string) => void;
}) {
  const plan = normalizePlan(planDetail);
  const rr = latestReleaseRequest(
    repair.releaseRequests?.filter((request) => request.sourceEventId === sourceEventId),
  );
  const fuseEngaged = !!fuse?.engaged;
  const inflight = rr ? RELEASE_INFLIGHT.has(rr.status) : false;
  // One immutable pending_release event is one logical approval. Any terminal
  // result requires a new reviewed event; the UI must not offer a second deploy
  // for the same event.
  const terminal = !!rr && !inflight;
  const buttonDisabled = releasing || fuseEngaged || inflight || terminal;
  const buttonLabel = releasing ? "放行中…" : "一键放行";

  let header: string;
  if (inflight) header = "部署放行进行中";
  else if (rr?.status === "deployed") header = "代码已部署，等待探测确认恢复";
  else if (rr?.status === "deploy_unknown") header = "部署结果未知，等待人工裁决";
  else if (terminal) header = "本候选已完成一次放行，等待新的修复候选";
  else header = "修复已就绪，待放行部署";

  return (
    <div className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning">
            <Rocket size={14} />
            {header}
          </div>
          <div className="mt-1.5 text-[13px] text-fg">
            codex 修复已通过验证（第 {repair.attempt} 次尝试）。核对下方改动与分类后再放行 —— 放行即通知执行侧合并并部署该 SHA（全链审计留痕）。
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onRelease(repair.id, plan.manual.length, sourceEventId)}
            disabled={buttonDisabled}
          >
            {buttonLabel}
          </Button>
          {plan.manual.length > 0 && !buttonDisabled && (
            <span className="text-right text-[11px] font-medium text-danger">
              含需人工介入的改动，放行将被置为「需人工处理」
            </span>
          )}
        </div>
      </div>

      {/* 全局熔断提示（Modal 覆盖页面顶部 banner，卡片内需自证为何禁用）。 */}
      {fuseEngaged && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-danger">
          <ShieldX size={13} className="shrink-0" />
          全局部署熔断已触发，暂不可放行；请先在页面顶部清除熔断。
        </div>
      )}

      {/* 放行请求状态流（202 异步；随详情轮询自动更新）。 */}
      {rr && (
        <div className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-faint">放行请求</span>
            <span className="flex items-center gap-1.5">
              {releaseStatusMeta(rr.status).spin && (
                <RefreshCw size={12} className="animate-spin text-info" />
              )}
              <Badge tone={releaseStatusMeta(rr.status).tone}>
                {releaseStatusMeta(rr.status).label}
              </Badge>
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-faint">
            <span className="font-mono">{short(rr.releaseRequestId, 8)}…</span>
            <TimeAgo value={rr.updatedAt} />
          </div>
          {rr.failureReason && terminal && rr.status !== "deployed" && (
            <div className="mt-1.5 rounded border border-danger/30 bg-danger-soft px-2 py-1 text-danger">
              上次失败原因：{rr.failureReason}
            </div>
          )}
        </div>
      )}

      {/* 放行内容清单（human gate）—— 数据源=最新 pending_release 事件 detail。 */}
      <div className="mt-3 space-y-2 rounded-md border border-warning/30 bg-surface px-3 py-2.5 text-[12px]">
        {!plan.complete && (
          <div className="flex items-center gap-1.5 font-medium text-danger">
            <AlertTriangle size={13} className="shrink-0" />
            放行信息不完整（后端 detail 缺 sha/plan/manifest 字段），请人工核对后再操作。
          </div>
        )}

        <KeyValue
          label="部署 SHA"
          value={
            <span className="font-mono text-[11.5px] text-fg">
              {short(plan.baseSha)}
              <span className="mx-1 text-faint">→</span>
              {short(plan.sha)}
            </span>
          }
        />

        {plan.surfaces.length > 0 && (
          <KeyValue
            label="影响面"
            value={
              <span className="flex flex-wrap justify-end gap-1">
                {plan.surfaces.map((s) => (
                  <Badge key={s} tone="accent">
                    {s}
                  </Badge>
                ))}
              </span>
            }
          />
        )}

        <KeyValue
          label="部署参数"
          value={
            plan.deployArgs.length > 0 ? (
              <span className="font-mono text-[11.5px] text-fg">{plan.deployArgs.join(" ")}</span>
            ) : (
              <span className="text-faint">（无附加参数）</span>
            )
          }
        />

        {plan.deployPlanHash && (
          <KeyValue
            label="deployPlanHash"
            value={<span className="font-mono text-[11.5px] text-muted">{short(plan.deployPlanHash)}…</span>}
          />
        )}

        {/* manual 路径高亮警示（无法安全自动部署）。 */}
        {plan.manual.length > 0 && (
          <div className="rounded border border-danger/40 bg-danger-soft px-2 py-1.5 text-danger">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={13} className="shrink-0" />
              以下改动无法安全自动部署（放行将被执行侧置为「需人工处理」）：
            </div>
            <ul className="mt-1 space-y-0.5">
              {plan.manual.map((m) => (
                <li key={m.path} className="break-all">
                  <span className="font-mono">{m.path}</span>
                  <span className="text-danger/80"> — {m.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 验证层结果（verifier 逐层通过/失败）。 */}
        {plan.verificationLayers.length > 0 && (
          <div>
            <div className="text-faint">验证层结果</div>
            <ul className="mt-0.5 space-y-0.5">
              {plan.verificationLayers.map((l) => (
                <li key={l.name} className="flex items-center gap-1.5">
                  {l.ok ? (
                    <Check size={12} className="shrink-0 text-success" />
                  ) : (
                    <X size={12} className="shrink-0 text-danger" />
                  )}
                  <span className={l.ok ? "text-muted" : "font-medium text-danger"}>{l.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.verifyLayers.length > 0 && (
          <KeyValue
            label="部署校验层"
            value={<span className="font-mono text-[11.5px] text-muted">{plan.verifyLayers.join(", ")}</span>}
          />
        )}

        {/* 改动文件（截断列表 + 总数）。 */}
        {plan.changedFilesTotal > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-faint">
              <FileText size={12} className="shrink-0" />
              改动文件（{plan.changedFilesTotal}）
            </div>
            <ul className="mt-0.5 space-y-0.5 font-mono text-[11.5px] text-muted">
              {plan.changedFiles.slice(0, CHANGED_FILES_SHOWN).map((f) => (
                <li key={f} className="break-all">
                  {f}
                </li>
              ))}
            </ul>
            {plan.changedFilesTotal > plan.changedFiles.slice(0, CHANGED_FILES_SHOWN).length && (
              <div className="mt-0.5 text-faint">
                …共 {plan.changedFilesTotal} 个文件（仅显示前 {CHANGED_FILES_SHOWN} 个）
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 事故详情弹窗体 —— 经 key 按 incidentId 挂载，自拉 detail（15s 轮询以跟进进行中 repair）。
 * 顶部「正在修复」卡（活跃 repair 的最新进度）；随后 incident 全字段 + repairs + 事件时间线。
 * retry/cancel 属切片②，置灰留 TODO。
 */
function IncidentDetailBody({ id, fuse }: { id: string; fuse: ReleaseFuseResp | null }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [releasing, setReleasing] = useState(false);

  const { data, error, loading, refresh } = useAdminPoll<IncidentDetailResp>(
    () => adminGet(`/selfheal/incidents/${encodeURIComponent(id)}`),
    { intervalMs: POLL_MS, deps: [id] },
  );

  const sortedEvents = useMemo(
    () =>
      [...(data?.events ?? [])].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || compareDecimalIds(a.id, b.id),
      ),
    [data],
  );
  const activeRepair = useMemo(
    () => (data?.repairs ?? []).find((r) => ACTIVE_REPAIR_STATUSES.has(r.status)) ?? null,
    [data],
  );
  // 待放行 repair(RFC §6):status='running' 且时间线里有 detail.phase==='pending_release'
  // 的事件 = 修复已过验证、部署停待 boss 放行(Tier2 部署门)。判定统一到结构化 detail,
  // 废除旧 message 文本匹配(deploy_failed/manual_required 后 repair 仍停留 running)。
  const pendingReleaseRepair = useMemo(
    () =>
      (data?.repairs ?? []).find(
        (r) =>
          r.status === "running" &&
          sortedEvents.some(
            (e) => e.repair_id === r.id && e.detail?.phase === PENDING_RELEASE_PHASE,
          ),
      ) ?? null,
    [data, sortedEvents],
  );
  // 该 repair 最新 pending_release 事件的 detail —— 待放行卡富化的唯一数据源(契约 §11)。
  const pendingReleaseEvent = useMemo(() => {
    if (!pendingReleaseRepair) return undefined;
    let latest: RepairEventRow | null = null;
    for (const e of sortedEvents) {
      if (e.repair_id !== pendingReleaseRepair.id) continue;
      if (e.detail?.phase !== PENDING_RELEASE_PHASE) continue;
      if (!latest || compareDecimalIds(e.id, latest.id) > 0) latest = e;
    }
    return latest ?? undefined;
  }, [pendingReleaseRepair, sortedEvents]);

  const onRelease = async (repairId: string, manualCount: number, sourceEventId: string) => {
    const ok = await confirm({
      title: "放行部署？",
      body: (
        <span className="text-[13px] text-muted">
          codex 修复已通过验证，部署正等待人工放行。确认后将向执行侧提交放行请求，由其异步合并并部署该
          SHA（全链审计留痕）—— 部署结果与事故是否恢复稍后在卡片内跟踪。仅在核对过改动内容与分类后操作。
          {manualCount > 0 && (
            <strong className="mt-1.5 block text-danger">
              注意：本次含 {manualCount} 项无法安全自动部署的改动，放行后将被执行侧置为「需人工处理」。
            </strong>
          )}
        </span>
      ),
      confirmText: "确认放行",
      danger: true,
    });
    if (!ok) return;
    setReleasing(true);
    try {
      // 202 异步:放行请求已入队,执行侧异步合并+部署;不再当"已部署"。真实状态经
      // repair.releaseRequests 状态流展示(详情 15s 轮询驱动)。deployed ≠ resolved。
      const ack = await adminSend<ReleaseRequestAck | undefined>(
        "POST",
        `/selfheal/repairs/${encodeURIComponent(repairId)}/release`,
        { expectedPendingReleaseEventId: sourceEventId },
      );
      toast(
        ack?.releaseRequestId
          ? `已提交放行请求（${short(ack.releaseRequestId, 8)}…），执行侧将异步合并并部署，可在卡片内跟踪状态`
          : "已提交放行请求，执行侧将异步合并并部署，可在卡片内跟踪状态",
        "success",
      );
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
      {/* 待放行卡（RFC §6 human gate：base→sha / 改动文件 / 分类 / 验证层 / manual 警示，
          放行 202 异步 + 状态流；全局熔断禁用放行）。 */}
      {pendingReleaseRepair && pendingReleaseEvent && (
        <PendingReleaseCard
          repair={pendingReleaseRepair}
          sourceEventId={pendingReleaseEvent.id}
          planDetail={pendingReleaseEvent.detail}
          fuse={fuse}
          releasing={releasing}
          onRelease={(repairId, manualCount, sourceEventId) =>
            void onRelease(repairId, manualCount, sourceEventId)
          }
        />
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
  const [promptReason, promptReasonEl] = usePrompt();

  const [status, setStatus] = useState<"" | IncidentStatus>("");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [resolving, setResolving] = useState(false);
  const [unsuppressing, setUnsuppressing] = useState<string | null>(null);
  const [clearingFuse, setClearingFuse] = useState(false);

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

  // 全局 Tier2 部署熔断（契约 §6.3）。engaged → 顶部红色 banner + 全站放行禁用。
  const { data: fuseData, refresh: refreshFuse } = useAdminPoll<ReleaseFuseResp>(
    () => adminGet("/selfheal/release-fuse"),
    { intervalMs: POLL_MS },
  );

  const incidents = data?.incidents ?? [];
  const canLoadMore = !!data?.nextBeforeId && limit < MAX_LIMIT;
  const suppressedRows = suppressedData?.items ?? [];
  const noticeRows = noticeData?.proposals ?? [];

  // 列表刷新后同步弹窗选中行的状态（如已被后台标记 resolved，footer 的 resolve 钮随之禁用）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意只在列表数据 data 到达时同步一次;依赖 selected/incidents 会在 setSelected 后自触发循环。
  useEffect(() => {
    if (!selected) return;
    const fresh = incidents.find((i) => i.id === selected.id);
    if (fresh && fresh.status !== selected.status) setSelected(fresh);
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

  // 清除全局部署熔断（RFC §6 双侧收敛）：二次确认 + 必填 reason（写审计），
  // 清除后 v5 恢复接受放行、个人版本地阻断解除。usePrompt 强制非空 reason。
  const onClearFuse = async () => {
    const expectedReleaseRequestId = fuseData?.releaseRequestId;
    if (!expectedReleaseRequestId) {
      toast("熔断缺少代际标识，已拒绝通配清除；请刷新后人工核查", "error");
      return;
    }
    const reason = await promptReason({
      title: "清除 Tier2 部署熔断？",
      body: (
        <span className="text-[13px] text-muted">
          熔断通常由 deploy_unknown（部署结果未知）触发。清除前请人工核对线上 /version、deploy_state
          与远端 candidate ref，确认没有遗留部署仍在后台推进。填写清除原因（写入审计留痕）。
        </span>
      ),
      placeholder: "清除原因（如：已人工核对 xxx 恢复稳定，无遗留部署）",
      confirmText: "确认清除",
      maxLength: 200,
    });
    if (!reason) return;
    setClearingFuse(true);
    try {
      const result = await adminSend<ReleaseFuseClearResp>("POST", "/selfheal/release-fuse/clear", {
        reason,
        expectedReleaseRequestId,
      });
      if (result.remainingReleaseRequestId) {
        toast(
          `已裁决 ${expectedReleaseRequestId}；仍有 ${result.remainingReleaseRequestId} 待裁决，Tier2 熔断保持`,
          "success",
        );
      } else {
        toast("已清除部署熔断，Tier2 放行恢复可用", "success");
      }
      refreshFuse();
    } catch (e) {
      toast(apiErrorMessage(e, "清除熔断失败"), "error");
    } finally {
      setClearingFuse(false);
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

      {/* 全局 Tier2 部署熔断 banner（deploy_unknown 触发）—— 触发期间所有一键放行禁用。 */}
      {fuseData?.engaged && (
        <div className="flex items-start gap-3 rounded-lg border border-danger/50 bg-danger-soft px-4 py-3">
          <ShieldX size={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-danger">
              Tier2 部署熔断已触发 —— 所有一键放行已禁用
            </div>
            <div className="mt-1 text-[13px] text-fg break-words">
              原因：{fuseData.reason || "未提供"}
              {fuseData.releaseRequestId && (
                <span className="text-muted">（关联请求 {short(fuseData.releaseRequestId, 8)}…）</span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-muted">
              触发时间：
              {fuseData.engagedAt ? <TimeAgo value={fuseData.engagedAt} /> : "—"}
              {fuseData.engagedBy && <> · {fuseData.engagedBy}</>}
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            className="shrink-0"
            onClick={() => void onClearFuse()}
            disabled={clearingFuse}
          >
            {clearingFuse ? "清除中…" : "清除熔断"}
          </Button>
        </div>
      )}

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
        {selected && (
          <IncidentDetailBody key={selected.id} id={selected.id} fuse={fuseData ?? null} />
        )}
      </Modal>

      {confirmEl}
      {promptReasonEl}
    </div>
  );
}

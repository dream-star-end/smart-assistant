import type {
  GovernanceApprovalDecision,
  GovernanceApprovalKind,
  GovernanceApprovalRecommendation,
  GovernanceApprovalStatus,
  GovernanceResumeStatus,
  GovernanceRiskCategory,
  GovernanceSafetyLight,
  GovernanceStewardVerdict,
  PendingGovernanceApproval,
  SafetyLightLevel,
} from "@openclaude/protocol/browser";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCode2,
  RefreshCw,
  RotateCw,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { SemanticTone } from "../../lib/ui/statusTone";
import { cn } from "../../lib/utils";
import { Alert } from "./Alert";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { Input } from "./Input";
import { StatusPill } from "./StatusPill";
import { TimeAgo } from "./TimeAgo";

export type SafetyLightLevelView = SafetyLightLevel;
export type GovernanceApprovalKindView = GovernanceApprovalKind;
export type GovernanceApprovalStatusView = GovernanceApprovalStatus;
export type GovernanceSafetyLightView = GovernanceSafetyLight;
export type GovernanceStewardVerdictView = GovernanceStewardVerdict;
export type GovernanceApprovalDecisionView = GovernanceApprovalDecision;
export type GovernanceRiskCategoryView = GovernanceRiskCategory;
export type GovernanceRecommendationView = GovernanceApprovalRecommendation;
export type GovernanceApprovalViewItem = PendingGovernanceApproval;

export interface GovernanceApprovalCardViewProps {
  approval: GovernanceApprovalViewItem;
  busy?: boolean;
  error?: string | null;
  compact?: boolean;
  readOnly?: boolean;
  showConsoleLink?: boolean;
  onDecide?: (decision: "approve" | "reject", opts: { note?: string; autoResumeTrain: boolean }) => void;
  onResume?: () => void;
  onRefresh?: () => void;
}

const STATUS_META: Record<
  GovernanceApprovalStatusView,
  { label: string; tone: "warning" | "success" | "danger" | "neutral" | "info" }
> = {
  pending: { label: "待拍板", tone: "warning" },
  approving: { label: "正在处理中", tone: "info" },
  approved: { label: "已批准", tone: "success" },
  rejected: { label: "已驳回", tone: "danger" },
  expired: { label: "已过期", tone: "neutral" },
  reconcile_required: { label: "需核对状态", tone: "danger" },
};

const RISK_META: Record<
  GovernanceRiskCategoryView,
  { label: string; tone: "warning" | "danger"; defaultWhy: string }
> = {
  billing_change: {
    label: "计费方式可能变化",
    tone: "warning",
    defaultWhy: "这次改动涉及核心计费或扣费规则，可能影响你的账单或计费方式，需要你确认后再放行。",
  },
  ux_degradation: {
    label: "用户体验可能下降",
    tone: "danger",
    defaultWhy: "这次改动可能影响正常使用体验或数据安全，需要你确认后再继续。",
  },
};

const LIGHT_STYLE: Record<SafetyLightLevelView, { tag: string; dotTone: SemanticTone; box: string; text: string }> = {
  green: { tag: "安全", dotTone: "done", box: "oc-callout oc-callout-success border-success/25", text: "text-success" },
  yellow: { tag: "注意", dotTone: "attention", box: "oc-callout oc-callout-warning border-warning/30", text: "text-warning" },
  red: { tag: "高危", dotTone: "failed", box: "oc-callout oc-callout-danger border-status-failed/30", text: "text-danger" },
  unknown: { tag: "待核验", dotTone: "idle", box: "border-border bg-bg/70", text: "text-muted" },
};

const RECOMMENDATION_TONE: Record<GovernanceRecommendationView["action"], "success" | "danger" | "warning"> = {
  approve: "success",
  reject: "danger",
  caution: "warning",
};

const RESUMABLE_STATUSES = new Set<GovernanceResumeStatus>(["not_started_busy", "failed", "not_started"]);
const RUNNING_RESUME_STATUSES = new Set<GovernanceResumeStatus>(["starting", "running"]);

function resolveRiskCategory(approval: GovernanceApprovalViewItem): GovernanceRiskCategoryView {
  if (approval.riskCategory === "billing_change" || approval.riskCategory === "ux_degradation") {
    return approval.riskCategory;
  }
  const upper = approval.code.toUpperCase();
  const scope = (approval.scope ?? "").toLowerCase();
  if (
    upper.includes("BILLING") ||
    upper.includes("PAYMENT") ||
    upper.includes("PRICE") ||
    upper.includes("CHARGE") ||
    scope.includes("billing") ||
    scope.includes("payment")
  ) {
    return "billing_change";
  }
  return "ux_degradation";
}

function resolveRecommendation(approval: GovernanceApprovalViewItem): GovernanceRecommendationView {
  if (approval.recommendation) return approval.recommendation;
  const verdict = approval.stewardVerdict;
  if (verdict.present && verdict.verdict === "approve") {
    return {
      action: "approve",
      label: "建议批准",
      reason: verdict.summary?.trim() || "独立复核未发现异常风险，可以放心放行。",
    };
  }
  if (verdict.present && verdict.verdict === "veto") {
    return {
      action: "reject",
      label: "建议驳回",
      reason: verdict.summary?.trim() || "独立复核发现了风险点，建议先退回修改。",
    };
  }
  return {
    action: "caution",
    label: "建议谨慎核对",
    reason: verdict.summary?.trim() || "暂无独立复核结论，请结合下方安全核验项决定。",
  };
}

function formatStewardDetail(verdict: GovernanceStewardVerdictView): string {
  const family = verdict.stewardFamily?.trim();
  const model = verdict.stewardModel?.trim();
  const who = family && model ? `${family}（${model}）` : family || model || "独立复核模型";
  if (!verdict.present) return "无独立复核记录";
  const status = verdict.verdict === "approve" ? "复核通过" : verdict.verdict === "veto" ? "复核否决" : "状态异常";
  return `${who} · ${status}${verdict.hmacVerified ? " · 签章有效" : ""}`;
}

function resolveApprovedHeadline(resumeStatus?: GovernanceResumeStatus): string {
  switch (resumeStatus) {
    case "started":
    case "starting":
    case "running":
      return "已由你批准生效，正在自动续跑发版";
    case "completed":
      return "已由你批准生效，本次更新已完成发版";
    case "not_started_busy":
      return "已由你批准生效，当前有其他更新进行中，稍后可重试自动发版";
    case "head_moved":
      return "已由你批准生效，代码已有更新，本次未自动发版";
    case "failed":
      return "审批已生效，但自动发版未能完成，请点击下方按钮重试；排查详情见「查看技术详情」。";
    case "skipped":
      return "已由你批准生效，已按你的设置跳过自动发版";
    case "not_applicable":
      return "已由你批准生效";
    default:
      return "已由你批准生效，等待开始发版";
  }
}

function DecisionSummarySection({
  approval,
  riskCategory,
}: {
  approval: GovernanceApprovalViewItem;
  riskCategory: GovernanceRiskCategoryView;
}) {
  const whatChanged = approval.whatChanged?.trim() || approval.plainSummary;
  const whyNeedYou = approval.whyNeedYou?.trim() || RISK_META[riskCategory].defaultWhy;
  const rec = resolveRecommendation(approval);

  return (
    <dl className="space-y-2 rounded-lg border border-border/80 bg-bg/60 px-3 py-2.5 text-meta">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2.5">
        <dt className="w-20 shrink-0 text-caption font-semibold text-muted">改了什么</dt>
        <dd className="min-w-0 flex-1 leading-relaxed text-fg">{whatChanged}</dd>
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2 sm:flex-row sm:items-baseline sm:gap-2.5">
        <dt className="w-20 shrink-0 text-caption font-semibold text-muted">为什么找你</dt>
        <dd className="min-w-0 flex-1 leading-relaxed text-fg">{whyNeedYou}</dd>
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2 sm:flex-row sm:items-baseline sm:gap-2.5">
        <dt className="w-20 shrink-0 text-caption font-semibold text-muted">助手建议</dt>
        <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 leading-relaxed text-fg">
          <Badge tone={RECOMMENDATION_TONE[rec.action]} size="sm">{rec.label}</Badge>
          <span className="text-muted">{rec.reason}</span>
        </dd>
      </div>
    </dl>
  );
}

function TechnicalDetailsDrawer({ approval }: { approval: GovernanceApprovalViewItem }) {
  const [open, setOpen] = useState(false);
  const fileCount = approval.totalChangedFiles ?? approval.files.length;
  const meta = [
    approval.branch ? `分支 ${approval.branch}` : null,
    approval.sha ? `SHA ${approval.sha.slice(0, 12)}` : null,
    approval.ticketId ? `工单 ${approval.ticketId}` : null,
    approval.trainId ? `列车 ${approval.trainId}` : null,
    `规则码 ${approval.code}`,
  ].filter((item): item is string => Boolean(item));

  const decisionMeta = [
    approval.decision?.decidedBy ? `操作人 ${approval.decision.decidedBy}` : null,
    approval.decision?.issuedArtifactId ? `签发凭证号 ${approval.decision.issuedArtifactId}` : null,
    approval.decision?.resumeUnit ? `续跑单元 ${approval.decision.resumeUnit}` : null,
  ].filter((item): item is string => Boolean(item));

  const resumeDetail = approval.decision?.resumeDetail?.trim();
  const lastError = approval.lastError?.trim();

  return (
    <div className="rounded-lg border border-border/80 bg-bg/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-meta font-medium text-muted transition-colors hover:text-fg"
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <FileCode2 size={14} className="shrink-0 text-faint" />
          <span className="truncate">
            查看技术详情{fileCount > 0 ? `（涉及 ${fileCount} 个文件）` : ""}
          </span>
        </span>
        {open ? <ChevronUp size={14} className="shrink-0 text-faint" /> : <ChevronDown size={14} className="shrink-0 text-faint" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/80 px-3 py-2.5 text-caption">
          <div className="text-muted">独立复核：{formatStewardDetail(approval.stewardVerdict)}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-muted">
            {meta.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          {decisionMeta.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-muted">
              {decisionMeta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          {resumeDetail && (
            <div className="break-all font-mono text-danger">续跑详细日志：{resumeDetail}</div>
          )}
          {lastError && lastError !== resumeDetail && (
            <div className="break-all font-mono text-danger">异常详情：{lastError}</div>
          )}
          {approval.files.length > 0 ? (
            <ul className="max-h-36 space-y-0.5 overflow-y-auto font-mono text-fg">
              {approval.files.map((file) => (
                <li key={file} className="break-all">{file}</li>
              ))}
            </ul>
          ) : (
            <p className="text-faint">未附带具体文件清单。</p>
          )}
        </div>
      )}
    </div>
  );
}

function NonDecidedStatusBanner({ approval }: { approval: GovernanceApprovalViewItem }) {
  if (approval.status === "expired") {
    return (
      <div className="rounded-lg border border-border bg-bg/70 px-3 py-2.5 text-meta text-muted">
        该审批单已过期，下次需要确认时将自动生成新的审批卡。
      </div>
    );
  }
  if (approval.status === "approving") {
    return (
      <div className="rounded-lg border border-info/30 bg-info-soft/50 px-3 py-2.5 text-meta text-info">
        正在处理你的决定，请稍候刷新状态，无需重复提交。
      </div>
    );
  }
  if (approval.status !== "reconcile_required") return null;
  return (
    <Alert
      tone="danger"
      density="compact"
      live="off"
      icon={<AlertTriangle size={15} />}
      title="需核对状态，请勿重复提交"
      className="text-meta"
    >
      {approval.lastError && <div className="text-caption text-danger/90">排查详情见「查看技术详情」。</div>}
    </Alert>
  );
}

function ResumeActionRow({
  resumeStatus,
  busy,
  readOnly,
  onResume,
}: {
  resumeStatus?: GovernanceResumeStatus;
  busy: boolean;
  readOnly: boolean;
  onResume?: () => void;
}) {
  if (!onResume || readOnly || !resumeStatus) return null;
  if (RUNNING_RESUME_STATUSES.has(resumeStatus)) {
    return (
      <div className="pt-1">
        <Button variant="secondary" size="sm" disabled>
          <RotateCw size={13} className="animate-spin" />
          正在自动发版…
        </Button>
      </div>
    );
  }
  if (!RESUMABLE_STATUSES.has(resumeStatus)) return null;
  return (
    <div className="pt-1">
      <Button variant="secondary" size="sm" loading={busy} onClick={onResume}>
        <RotateCw size={13} />
        重试自动发版
      </Button>
    </div>
  );
}

function ResolvedDecisionBanner({
  approval,
  busy,
  readOnly,
  onResume,
}: {
  approval: GovernanceApprovalViewItem;
  busy: boolean;
  readOnly: boolean;
  onResume?: () => void;
}) {
  if (approval.status === "expired" || approval.status === "approving" || approval.status === "reconcile_required") {
    return <NonDecidedStatusBanner approval={approval} />;
  }
  const decision = approval.decision;
  if (!decision) return null;

  const isApproved = approval.status === "approved";
  const Icon = isApproved ? CheckCircle2 : XCircle;
  const toneBox = isApproved ? "oc-callout oc-callout-success border-success/30" : "oc-callout oc-callout-danger border-status-failed/30";
  const toneText = isApproved ? "text-success" : "text-danger";
  const headline = isApproved ? resolveApprovedHeadline(decision.resumeStatus) : "已由你驳回，线上版本保持不变";

  return (
    <div className={cn("space-y-1.5 rounded-lg border px-3 py-2.5 text-meta", toneBox)}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2 font-medium", toneText)}>
        <span className="inline-flex items-center gap-1.5">
          <Icon size={15} className="shrink-0" />
          <span>{headline}</span>
        </span>
        <TimeAgo value={decision.decidedAt} className="text-caption opacity-80" />
      </div>
      {decision.note && (
        <div className="text-caption text-muted">{isApproved ? "备注：" : "驳回理由："}{decision.note}</div>
      )}
      {isApproved && (
        <ResumeActionRow resumeStatus={decision.resumeStatus} busy={busy} readOnly={readOnly} onResume={onResume} />
      )}
    </div>
  );
}

function PendingActionPanel({
  approval,
  busy,
  onDecide,
}: {
  approval: GovernanceApprovalViewItem;
  busy: boolean;
  onDecide?: GovernanceApprovalCardViewProps["onDecide"];
}) {
  const [autoResumeTrain, setAutoResumeTrain] = useState(true);
  const [note, setNote] = useState("");
  const submit = (decision: "approve" | "reject") => {
    onDecide?.(decision, { note: note.trim() || undefined, autoResumeTrain });
  };

  return (
    <div className="space-y-3 border-t border-border/80 pt-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="governance-effect-comparison">
        <div className="oc-callout oc-callout-success rounded-lg border border-success/25 px-3 py-2">
          <div className="flex items-center gap-1.5 text-caption font-semibold text-success">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>如果批准</span>
          </div>
          <p className="mt-1 text-caption leading-snug text-fg">{approval.approveEffect}</p>
        </div>
        <div className="oc-callout oc-callout-danger rounded-lg border border-status-failed/30 px-3 py-2">
          <div className="flex items-center gap-1.5 text-caption font-semibold text-danger">
            <XCircle size={13} aria-hidden="true" />
            <span>如果驳回</span>
          </div>
          <p className="mt-1 text-caption leading-snug text-fg">{approval.rejectEffect}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} disabled={!onDecide} onClick={() => submit("approve")}>
          {autoResumeTrain ? "批准并自动继续" : "批准放行"}
        </Button>
        <Button variant="danger" size="sm" disabled={busy || !onDecide} onClick={() => submit("reject")}>
          驳回并退回
        </Button>
      </div>

      <div className="space-y-2 pt-0.5">
        <Input
          inputSize="sm"
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="可选备注（驳回时建议写一句调整意见）"
          aria-label="审批备注"
        />
        <Checkbox
          checked={autoResumeTrain}
          disabled={busy}
          onChange={(event) => setAutoResumeTrain(event.target.checked)}
          label="批准后自动继续发版列车"
        />
      </div>
    </div>
  );
}

export function GovernanceApprovalCardView({
  approval,
  busy = false,
  error = null,
  compact = false,
  readOnly = false,
  showConsoleLink = false,
  onDecide,
  onResume,
  onRefresh,
}: GovernanceApprovalCardViewProps) {
  const statusMeta = STATUS_META[approval.status] ?? STATUS_META.reconcile_required;
  const riskCategory = resolveRiskCategory(approval);
  const riskMeta = RISK_META[riskCategory];

  return (
    <article
      className={cn(
        "oc-surface-card rounded-xl border border-border bg-surface text-fg",
        compact ? "space-y-3 p-3.5" : "space-y-4 p-4 sm:p-5",
      )}
      data-approval-id={approval.id}
      data-approval-status={approval.status}
    >
      <header className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusMeta.tone} size="sm">{statusMeta.label}</Badge>
            <Badge tone={riskMeta.tone} size="sm">{riskMeta.label}</Badge>
            <span className="text-caption text-faint"><TimeAgo value={approval.createdAt} /></span>
          </div>
          <h3 className={cn("font-semibold tracking-tight text-fg", compact ? "text-body" : "text-title")}>
            {approval.title}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onRefresh && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh} aria-label="刷新审批状态" title="刷新审批状态">
              <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
            </Button>
          )}
          {showConsoleLink && (
            <a
              href="/admin/#tab=governance"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent-soft"
            >
              打开治理控制台
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      </header>

      <DecisionSummarySection approval={approval} riskCategory={riskCategory} />

      {approval.safetyLights.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {approval.safetyLights.map((light) => {
            const style = LIGHT_STYLE[light.level] ?? LIGHT_STYLE.unknown;
            return (
              <div key={light.key} className={cn("rounded-lg border px-3 py-2", style.box)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-meta font-medium text-fg">{light.label}</span>
                  <span className={cn("inline-flex items-center gap-1.5 text-caption font-semibold", style.text)}>
                    <StatusPill tone={style.dotTone} variant="dot" decorative />
                    {style.tag}
                  </span>
                </div>
                <p className="mt-1 text-caption leading-snug text-muted">{light.detail}</p>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <Alert tone="danger" density="compact" icon={<AlertTriangle size={14} />} className="text-meta">
          {error}
        </Alert>
      )}

      {approval.status === "pending" && !readOnly ? (
        <PendingActionPanel approval={approval} busy={busy} onDecide={onDecide} />
      ) : (
        <ResolvedDecisionBanner approval={approval} busy={busy} readOnly={readOnly} onResume={onResume} />
      )}

      <TechnicalDetailsDrawer approval={approval} />
    </article>
  );
}

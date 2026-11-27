import type {
  GovernanceApprovalDecision, GovernanceApprovalKind, GovernanceApprovalStatus,
  GovernanceResumeStatus, GovernanceSafetyLight, GovernanceStewardVerdict,
  PendingGovernanceApproval, SafetyLightLevel,
} from "@openclaude/protocol/browser";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, FileCode2, RefreshCw, RotateCw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
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
  approved: { label: "已批准生效", tone: "success" },
  rejected: { label: "已驳回", tone: "danger" },
  expired: { label: "已过期", tone: "neutral" },
  reconcile_required: { label: "需核对状态", tone: "danger" },
};

const LIGHT_STYLE: Record<SafetyLightLevelView, { tag: string; dotTone: SemanticTone; box: string; text: string }> = {
  green: { tag: "安全", dotTone: "done", box: "oc-callout oc-callout-success border-success/25", text: "text-success" },
  yellow: { tag: "注意", dotTone: "attention", box: "oc-callout oc-callout-warning border-warning/30", text: "text-warning" },
  red: { tag: "高危", dotTone: "failed", box: "oc-callout oc-callout-danger border-status-failed/30", text: "text-danger" },
  unknown: { tag: "未采集 / 待核验", dotTone: "idle", box: "border-border bg-bg/70", text: "text-muted" },
};

const RESUME_LABELS: Record<GovernanceResumeStatus, string> = {
  not_started: "凭证已签发，尚未触发发版列车",
  starting: "发版列车正在执行中…",
  started: "已自动拉起发版列车",
  running: "发版列车正在执行中…",
  not_started_busy: "发版锁正忙，凭证已签发但未自动发车",
  head_moved: "主分支已前进到新提交，未自动发版",
  completed: "发版列车已完成",
  failed: "凭证已生效，但自动续跑未能拉起",
  skipped: "已按设置跳过自动续跑发版列车",
  not_applicable: "本次操作无需拉起发版列车",
};

const RESUMABLE_STATUSES = new Set<GovernanceResumeStatus>(["not_started_busy", "failed", "not_started"]);
const RUNNING_RESUME_STATUSES = new Set<GovernanceResumeStatus>(["starting", "running"]);

function resolveKindLabel(approval: GovernanceApprovalViewItem): string {
  if (approval.kind === "a0_approval") return "红线规则审批";
  if (approval.kind === "breaker_unlock") return "熔断解锁确认";
  const upper = approval.code.toUpperCase();
  return upper.includes("DDL") || upper.includes("DATA") || approval.scope === "ddl" ? "数据安全拦截" : "计费防线拦截";
}

function formatFamilyLabel(v: GovernanceStewardVerdictView): string {
  const family = v.stewardFamily?.trim();
  const model = v.stewardModel?.trim();
  return family && model ? `${family}（${model}）` : family || model || "异家族强模型审计员";
}

function StewardEndorsementBar({ verdict }: { verdict: GovernanceStewardVerdictView }) {
  const approved = verdict.present && verdict.verdict === "approve";
  const vetoed = verdict.present && verdict.verdict === "veto";
  const tone = approved ? "success" : vetoed ? "danger" : "warning";
  const headline = approved
    ? `${formatFamilyLabel(verdict)} 独立审计通过${verdict.hmacVerified ? " · 签章有效" : ""}`
    : vetoed
      ? `${formatFamilyLabel(verdict)} 独立审计已否决，建议驳回整改`
      : "暂无跨家族审计背书，请谨慎核查";
  const Icon = approved ? ShieldCheck : ShieldAlert;

  return (
    <Alert tone={tone} density="compact" live="off" icon={<Icon size={15} />} title={headline} className="text-meta">
      {verdict.summary ? <p className="text-caption text-muted">{verdict.summary}</p> : null}
    </Alert>
  );
}

function TechnicalScopeDetails({ approval }: { approval: GovernanceApprovalViewItem }) {
  const [open, setOpen] = useState(false);
  const fileCount = approval.totalChangedFiles ?? approval.files.length;
  const meta = [
    approval.branch ? `分支 ${approval.branch}` : null,
    approval.sha ? `SHA ${approval.sha.slice(0, 10)}` : null,
    approval.ticketId ? `工单 ${approval.ticketId}` : null,
    approval.trainId ? `列车 ${approval.trainId}` : null,
    `拦截码 ${approval.code}`,
  ].filter((item): item is string => Boolean(item));

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
            查看涉及范围（{fileCount} 个文件{approval.branch ? ` / ${approval.branch}` : ""}）
          </span>
        </span>
        {open ? <ChevronUp size={14} className="shrink-0 text-faint" /> : <ChevronDown size={14} className="shrink-0 text-faint" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/80 px-3 py-2.5 text-caption">
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-muted">
            {meta.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
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
        该审批单已过期，下次发车拦截时将自动生成新一轮待拍板审批单
      </div>
    );
  }
  if (approval.status === "approving") {
    return (
      <div className="rounded-lg border border-info/30 bg-info-soft/50 px-3 py-2.5 text-meta text-info">
        正在处理审批并签发凭证，请稍候刷新状态，切勿重复提交。
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
      title="需核对状态，请勿重复签发"
      className="text-meta"
    >
      <div className="space-y-1">
        {approval.decision?.issuedArtifactId && (
          <div className="text-caption text-fg">
            已落盘凭证号：<span className="font-mono font-medium">{approval.decision.issuedArtifactId}</span>
          </div>
        )}
        {approval.lastError && <div className="text-caption text-danger/90">异常说明：{approval.lastError}</div>}
      </div>
    </Alert>
  );
}

function ResumeStatusLine({
  decision,
  lastError,
}: {
  decision: GovernanceApprovalDecisionView;
  lastError?: string;
}) {
  const resumeText = decision.resumeStatus ? RESUME_LABELS[decision.resumeStatus] : null;
  if (!resumeText) return null;
  const isFailed = decision.resumeStatus === "failed";
  const failureDetail = isFailed ? (decision.resumeDetail || lastError || "") : "";
  const suffix = [
    decision.resumeUnit ? `（${decision.resumeUnit}）` : "",
    !isFailed && decision.resumeDetail ? ` · ${decision.resumeDetail}` : "",
  ].join("");
  return (
    <div className="space-y-0.5 text-caption text-fg">
      <div>列车续跑状态：{resumeText}{suffix}</div>
      {failureDetail && <div className="text-danger">失败原因：{failureDetail}</div>}
    </div>
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
          仅重触发版（发版执行中）
        </Button>
      </div>
    );
  }
  if (!RESUMABLE_STATUSES.has(resumeStatus)) return null;
  return (
    <div className="pt-1">
      <Button variant="secondary" size="sm" loading={busy} onClick={onResume}>
        <RotateCw size={13} />
        仅重触发版（复用已签凭证）
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

  return (
    <div className={cn("space-y-1.5 rounded-lg border px-3 py-2.5 text-meta", toneBox)}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2 font-medium", toneText)}>
        <span className="inline-flex items-center gap-1.5">
          <Icon size={15} className="shrink-0" />
          {isApproved ? `已由 ${decision.decidedBy} 批准生效` : `已由 ${decision.decidedBy} 驳回退回`}
        </span>
        <TimeAgo value={decision.decidedAt} className="text-caption opacity-80" />
      </div>
      {isApproved && decision.issuedArtifactId && (
        <div className="text-caption text-fg">
          签发凭证号：<span className="font-mono font-medium">{decision.issuedArtifactId}</span>
        </div>
      )}
      {isApproved && <ResumeStatusLine decision={decision} lastError={approval.lastError} />}
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
      <Checkbox
        checked={autoResumeTrain}
        disabled={busy}
        onChange={(event) => setAutoResumeTrain(event.target.checked)}
        label="批准后自动继续卡住的发版列车"
      />
      <Input
        inputSize="sm"
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
        placeholder="可选备注（驳回时建议填写一句整改原因）"
        aria-label="审批备注"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} disabled={!onDecide} onClick={() => submit("approve")}>
          {autoResumeTrain ? "批准并自动继续发版" : "批准放行"}
        </Button>
        <Button variant="danger" size="sm" disabled={busy || !onDecide} onClick={() => submit("reject")}>
          驳回并退回整改
        </Button>
      </div>
      <div className="grid gap-1 text-caption text-faint sm:grid-cols-2">
        <span>批准后：{approval.approveEffect}</span>
        <span>驳回后：{approval.rejectEffect}</span>
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
  const kindLabel = resolveKindLabel(approval);

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
            <Badge tone="accent" size="sm">{kindLabel}</Badge>
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

      <p className="text-body leading-relaxed text-muted">{approval.plainSummary}</p>

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

      <StewardEndorsementBar verdict={approval.stewardVerdict} />
      <TechnicalScopeDetails approval={approval} />

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
    </article>
  );
}

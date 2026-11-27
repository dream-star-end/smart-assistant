import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, History, Inbox, Lock, PauseCircle, RefreshCw, Shield, ShieldAlert, ShieldCheck, Unlock, Zap } from "lucide-react";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, TimeAgo } from "../../../components/ui";
import { GovernanceApprovalCardView } from "../../../components/ui/GovernanceApprovalCardView";
import {
  type GovernanceAuditItem, type GovernanceBreakerState, type GovernanceCockpitGauge,
  type GovernanceMode, type GovernanceOverviewResponse, type PendingGovernanceApproval,
  type SafetyLightLevel, decideGovernanceApproval, getGovernanceOverview,
  resumeGovernanceApproval, setGovernanceMode, unlockGovernanceBreaker,
} from "../../../lib/api/governanceApi";
import { ApiError } from "../../../lib/api/http";
import { cn } from "../../../lib/utils";
import { adminSession } from "../../auth";
import { PageHeader, SectionCard } from "../../components";

const MIN_UNLOCK_REASON_LEN = 8;

const MODE_CARDS: ReadonlyArray<{
  mode: GovernanceMode; title: string; subtitle: string;
  tone: "success" | "warning" | "danger"; activeRing: string; icon: typeof Zap;
}> = [
  { mode: "autonomous", title: "全自动自治", subtitle: "自动修复、审计与自托管发版；触及高危红线时自动拦截待你拍板。", tone: "success", activeRing: "border-success bg-success-soft/40", icon: Zap },
  { mode: "debt_first", title: "仅修债暂停新功能", subtitle: "冻结新功能自动合入，仅保留故障修复、安全维护与稳定性治理。", tone: "warning", activeRing: "border-warning bg-warning-soft/45", icon: PauseCircle },
  { mode: "emergency_stop", title: "紧急急停", subtitle: "立即冻结全部自动合入与自动发版，等待管理员排查后手动恢复。", tone: "danger", activeRing: "oc-callout oc-callout-danger", icon: ShieldAlert },
];

const LIGHT_BADGE: Record<SafetyLightLevel, { label: string; tone: "success" | "warning" | "danger" | "neutral"; dot: string }> = {
  green: { label: "健康", tone: "success", dot: "bg-success" },
  yellow: { label: "需关注", tone: "warning", dot: "bg-warning" },
  red: { label: "告警", tone: "danger", dot: "bg-danger" },
  unknown: { label: "未采集 / 待核验", tone: "neutral", dot: "bg-faint" },
};

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

function conflictMessage(err: ApiError): string {
  const body = err.body as { approval?: { status?: string } } | null | undefined;
  if (err.code === "APPROVAL_IN_PROGRESS" || body?.approval?.status === "approving") {
    return "该审批单正在处理中，请稍候刷新";
  }
  return "该审批单已在其他页面完成处理，正在同步最新状态";
}

function ModeSwitchConfirmBox(props: {
  title: string;
  reason: string;
  busy: boolean;
  onReasonChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3.5 space-y-2.5 rounded-xl border border-accent/35 bg-accent-soft/30 p-3.5">
      <div className="text-meta font-medium text-fg">
        确认切换至「{props.title}」？请填写简短原因以便审计记录：
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          inputSize="sm"
          value={props.reason}
          disabled={props.busy}
          onChange={(e) => props.onReasonChange(e.target.value)}
          placeholder={`例如：切换为${props.title}`}
          aria-label="切换总闸原因"
          className="flex-1"
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="primary" size="sm" loading={props.busy} onClick={props.onConfirm}>确认切换</Button>
          <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>取消</Button>
        </div>
      </div>
    </div>
  );
}

function ModeControlSection(props: {
  modeState: GovernanceOverviewResponse["mode"];
  breakerTripped: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (mode: GovernanceMode, reason: string) => Promise<boolean>;
}) {
  const { modeState, breakerTripped, busy, error, onSubmit } = props;
  const [targetMode, setTargetMode] = useState<GovernanceMode | null>(null);
  const [reason, setReason] = useState("");
  const isCorrupt = Boolean(modeState.corrupt || modeState.effectiveMode === "unknown");
  const effectiveMode = isCorrupt ? null : (modeState.effectiveMode ?? modeState.mode);
  const targetMeta = MODE_CARDS.find((item) => item.mode === targetMode) ?? null;

  const confirmSwitch = async () => {
    if (!targetMode || (breakerTripped && targetMode === "autonomous")) return;
    const ok = await onSubmit(targetMode, reason.trim() || `管理员在控制台切换至${targetMeta?.title ?? targetMode}`);
    if (ok) { setTargetMode(null); setReason(""); }
  };

  return (
    <SectionCard
      title="物理总闸控制"
      hint="零终端切换自治档位；变更立即落盘并记录至宿主审计日志。"
      icon={Shield}
      iconTone={isCorrupt ? "danger" : "accent"}
      action={
        <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
          {isCorrupt && <Badge tone="danger" size="sm">模式状态异常</Badge>}
          {!isCorrupt && modeState.uninitialized && <Badge tone="warning" size="sm">尚未初始化（默认按全自动放行）</Badge>}
          {modeState.autoMergeFrozen && <Badge tone="warning" size="sm">自动合入已冻结</Badge>}
          <span>最近更新：{modeState.updatedBy} · <TimeAgo value={modeState.updatedAt} /></span>
        </div>
      }
    >
      {isCorrupt && (
        <div role="alert" className="oc-callout oc-callout-danger mb-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-meta text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>物理总闸配置文件缺失或已损坏，当前模式未知（已按异常拦截，请勿视为全自动正常），请立即核查并重新设定档位。</span>
        </div>
      )}
      {breakerTripped && (
        <div className="oc-callout oc-callout-warning mb-3 flex items-start gap-2 rounded-xl px-3.5 py-2 text-caption text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>熔断器触发期间禁止直接切回「全自动自治」，请先在上方完成根因核查并解锁熔断。</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {MODE_CARDS.map((card) => {
          const Icon = card.icon;
          const active = effectiveMode === card.mode;
          const blockedByBreaker = breakerTripped && card.mode === "autonomous";
          const cardCls = active
            ? card.activeRing
            : targetMode === card.mode
              ? "border-accent bg-accent-soft/35"
              : "border-border bg-bg/50 hover:border-border-strong hover:bg-hover/60";
          return (
            <button
              key={card.mode}
              type="button"
              disabled={busy || blockedByBreaker}
              onClick={() => setTargetMode(active ? null : card.mode)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                cardCls,
              )}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-body font-semibold text-fg">
                  <Icon size={16} className="shrink-0" />
                  {card.title}
                </span>
                {active && <Badge tone={card.tone} size="sm">当前生效</Badge>}
                {blockedByBreaker && !active && <Badge tone="warning" size="sm">需先解锁熔断</Badge>}
              </div>
              <p className="text-caption leading-relaxed text-muted">{card.subtitle}</p>
            </button>
          );
        })}
      </div>
      {modeState.reason && <p className="mt-3 text-caption text-faint">当前档位说明：{modeState.reason}</p>}
      {targetMeta && targetMeta.mode !== effectiveMode && !(breakerTripped && targetMeta.mode === "autonomous") && (
        <ModeSwitchConfirmBox
          title={targetMeta.title}
          reason={reason}
          busy={busy}
          onReasonChange={setReason}
          onConfirm={() => void confirmSwitch()}
          onCancel={() => { setTargetMode(null); setReason(""); }}
        />
      )}
      {error && <p role="alert" className="mt-2.5 text-meta text-danger">{error}</p>}
    </SectionCard>
  );
}

function BreakerBannerSection(props: {
  breaker: GovernanceBreakerState;
  busy: boolean;
  error: string | null;
  onUnlock: (reason: string) => Promise<boolean>;
}) {
  const { breaker, busy, error, onUnlock } = props;
  const [reason, setReason] = useState("");
  if (breaker.readError) {
    return (
      <div role="alert" className="oc-callout oc-callout-danger space-y-1.5 rounded-xl px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-body font-semibold text-danger">
          <span className="inline-flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0" />
            熔断状态文件读取异常，无法确认健康
          </span>
          <Badge tone="danger" size="sm">状态未知</Badge>
        </div>
        <p className="text-caption text-danger/90">
          {breaker.readErrorMessage || "请核查宿主控制目录权限及 breaker.json / cost-breaker.json 文件完整性。"}
        </p>
      </div>
    );
  }
  if (!breaker.tripped && !breaker.costTripped) {
    return (
      <div className="oc-callout oc-callout-success flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2 text-body font-medium text-success">
          <ShieldCheck size={16} className="shrink-0" />
          <span>运行健康 · 近 7 天回滚 {breaker.recentRollbacks} 次</span>
        </div>
        <Badge tone="success" size="sm">熔断器未触发</Badge>
      </div>
    );
  }

  const lines = breaker.cardLines.length > 0
    ? breaker.cardLines
    : [breaker.reason, breaker.costReason].filter((v): v is string => Boolean(v));
  const heading = breaker.tripped && breaker.costTripped
    ? "发版与成本双熔断已触发"
    : breaker.costTripped
      ? "预算成本熔断已触发"
      : "发版熔断器已触发";
  const trimmedReason = reason.trim();
  const canUnlock = trimmedReason.length >= MIN_UNLOCK_REASON_LEN;

  const submitUnlock = async () => {
    if (!canUnlock) return;
    const ok = await onUnlock(trimmedReason);
    if (ok) setReason("");
  };

  return (
    <section aria-label="熔断器警报" className="oc-callout oc-callout-danger space-y-3 rounded-xl px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-title font-semibold text-danger">
          <AlertTriangle size={17} className="shrink-0" />
          <span>{heading}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-caption text-danger/90">
          {breaker.train && <span className="font-mono">列车 {breaker.train}</span>}
          {breaker.triggeredAt && <TimeAgo value={breaker.triggeredAt} />}
          <Badge tone="danger" size="sm">近 7 天回滚 {breaker.recentRollbacks} 次</Badge>
        </div>
      </div>
      <div className="oc-surface-card space-y-1 rounded-lg px-3.5 py-2.5 text-body text-fg">
        <div className="text-caption font-semibold text-muted">根因摘要</div>
        {lines.map((line, index) => (
          <p key={`${index}-${line}`} className="text-meta leading-relaxed text-fg">{line}</p>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            inputSize="sm"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder="请填写至少 8 个字的真实根因核查与修复说明"
            aria-label="熔断解锁原因"
            className="flex-1"
          />
          <Button variant="danger" size="sm" loading={busy} disabled={!canUnlock} onClick={() => void submitUnlock()} className="shrink-0">
            <Unlock size={14} />
            确认根因并一键解锁
          </Button>
        </div>
        {!canUnlock && (
          <p className="text-caption text-muted">
            需填写至少 {MIN_UNLOCK_REASON_LEN} 个字的真实核查说明后才可解锁（当前 {trimmedReason.length} 字）。
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-meta text-danger">{error}</p>}
    </section>
  );
}

function ApprovalInboxSection(props: {
  pending: PendingGovernanceApproval[];
  recent: PendingGovernanceApproval[];
  busyIds: ReadonlySet<string>;
  cardErrors: Readonly<Record<string, string>>;
  onDecide: (approval: PendingGovernanceApproval, decision: "approve" | "reject", opts: { note?: string; autoResumeTrain: boolean }) => void;
  onResume: (id: string) => void;
  onRefresh: () => void;
}) {
  const { pending, recent, busyIds, cardErrors, onDecide, onResume, onRefresh } = props;
  const [showRecent, setShowRecent] = useState(false);

  return (
    <SectionCard
      title="待你拍板"
      hint="高风险改动已自动拦下，由你一键批准放行或驳回退回。"
      icon={Inbox}
      iconTone={pending.length > 0 ? "warning" : "success"}
      action={<Badge tone={pending.length > 0 ? "warning" : "success"}>{pending.length} 项待处理</Badge>}
    >
      {pending.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-success/25 bg-success-soft/45 px-4 py-4 text-body text-fg">
          <CheckCircle2 size={18} className="shrink-0 text-success" />
          <span>当前没有需要你拍板的拦截项，代码自治流水线正常运转中</span>
        </div>
      ) : (
        <div className="space-y-3.5">
          {pending.map((approval) => (
            <GovernanceApprovalCardView
              key={approval.id}
              approval={approval}
              busy={busyIds.has(approval.id)}
              error={cardErrors[approval.id] ?? null}
              onDecide={(decision, opts) => onDecide(approval, decision, opts)}
              onResume={() => onResume(approval.id)}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="mt-4 border-t border-border/80 pt-3">
          <button
            type="button"
            onClick={() => setShowRecent((prev) => !prev)}
            aria-expanded={showRecent}
            className="inline-flex items-center gap-1.5 text-meta font-medium text-muted transition-colors hover:text-fg"
          >
            {showRecent ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            近期已裁决记录（{recent.length}）
          </button>
          {showRecent && (
            <div className="mt-3 space-y-3">
              {recent.map((item) => (
                <GovernanceApprovalCardView
                  key={item.id}
                  approval={item}
                  compact
                  busy={busyIds.has(item.id)}
                  error={cardErrors[item.id] ?? null}
                  onResume={() => onResume(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function CockpitAndAuditSection({
  cockpit,
  auditTrail,
}: {
  cockpit: GovernanceOverviewResponse["cockpit"];
  auditTrail: GovernanceAuditItem[];
}) {
  const overall = LIGHT_BADGE[cockpit.overallLight] ?? LIGHT_BADGE.unknown;
  return (
    <div className="space-y-4">
      <SectionCard
        title="4 信号健康驾驶舱"
        hint="以业务与交付健康度为核心，实时观察自治系统运行状态。"
        icon={Activity}
        iconTone={overall.tone}
        action={
          <div className="flex items-center gap-2">
            {cockpit.generatedAt && <span className="text-caption text-faint">更新于 <TimeAgo value={cockpit.generatedAt} /></span>}
            <Badge tone={overall.tone}>{overall.label}</Badge>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {cockpit.gauges.map((gauge: GovernanceCockpitGauge) => {
            const meta = LIGHT_BADGE[gauge.light] ?? LIGHT_BADGE.unknown;
            return (
              <div key={gauge.id} className="oc-surface-card space-y-2.5 rounded-xl border border-border/80 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body font-semibold text-fg">{gauge.title}</span>
                  <Badge tone={meta.tone} size="sm">
                    <span className={cn("size-1.5 rounded-full", meta.dot)} aria-hidden="true" />
                    {meta.label}
                  </Badge>
                </div>
                <p className="text-caption leading-relaxed text-muted">{gauge.summary}</p>
                {gauge.metrics.length > 0 && (
                  <dl className="grid grid-cols-2 gap-2 border-t border-border/70 pt-2">
                    {gauge.metrics.map((m) => (
                      <div key={m.label} className="min-w-0">
                        <dt className="truncate text-caption text-faint">{m.label}</dt>
                        <dd className="truncate text-meta font-semibold tabular-nums text-fg">{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="宿主记录的近期治理操作流水" hint="展示宿主侧记录的总闸切换、熔断解锁与审批裁决操作历史。" icon={History} iconTone="neutral" bodyClassName="p-0">
        {auditTrail.length === 0 ? (
          <p className="px-5 py-4 text-body text-muted">暂无治理操作流水。</p>
        ) : (
          <ol className="divide-y divide-border/80">
            {auditTrail.map((item, idx) => (
              <li
                key={`${item.ts}-${item.action}-${idx}`}
                className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-medium text-fg">{item.label}</span>
                    <Badge tone="neutral" size="sm">{item.outcome}</Badge>
                    <span className="text-caption text-faint">操作人：{item.actor}</span>
                  </div>
                  {item.detail && <p className="text-caption text-muted">{item.detail}</p>}
                </div>
                <TimeAgo value={item.ts} className="shrink-0 text-caption text-faint" />
              </li>
            ))}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}

function applyApprovalUpdate(
  prev: GovernanceOverviewResponse | null,
  approval: PendingGovernanceApproval,
): GovernanceOverviewResponse | null {
  if (!prev) return prev;
  const isPending = approval.status === "pending" || approval.status === "approving";
  return {
    ...prev,
    pendingApprovals: isPending
      ? prev.pendingApprovals.map((item) => (item.id === approval.id ? approval : item))
      : prev.pendingApprovals.filter((item) => item.id !== approval.id),
    recentDecisions: isPending
      ? prev.recentDecisions
      : [approval, ...prev.recentDecisions.filter((item) => item.id !== approval.id)],
  };
}

function useApprovalActions(
  mountedRef: MutableRefObject<boolean>,
  setData: Dispatch<SetStateAction<GovernanceOverviewResponse | null>>,
  loadOverview: () => Promise<void>,
) {
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  const setCardBusy = (id: string, active: boolean) => {
    if (!mountedRef.current) return;
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleDecide = async (
    approval: PendingGovernanceApproval,
    decision: "approve" | "reject",
    opts: { note?: string; autoResumeTrain: boolean },
  ) => {
    const { id } = approval;
    setCardBusy(id, true);
    setCardErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await decideGovernanceApproval(adminSession, id, {
        decision,
        note: opts.note,
        autoResumeTrain: opts.autoResumeTrain,
        ...(approval.version !== undefined ? { expectedVersion: approval.version } : {}),
        ...(approval.sha256 ? { expectedSha256: approval.sha256 } : {}),
      });
      if (!mountedRef.current) return;
      setData((prev) => applyApprovalUpdate(prev, res.approval));
      void loadOverview();
    } catch (err) {
      if (!mountedRef.current) return;
      const isConflict = err instanceof ApiError && err.status === 409;
      setCardErrors((prev) => ({
        ...prev,
        [id]: isConflict ? conflictMessage(err) : describeError(err, "提交审批裁决失败"),
      }));
      if (isConflict) void loadOverview();
    } finally {
      setCardBusy(id, false);
    }
  };

  const handleResume = async (id: string) => {
    setCardBusy(id, true);
    setCardErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await resumeGovernanceApproval(adminSession, id);
      if (!mountedRef.current) return;
      setData((prev) => applyApprovalUpdate(prev, res.approval));
      void loadOverview();
    } catch (err) {
      if (mountedRef.current) setCardErrors((prev) => ({ ...prev, [id]: describeError(err, "重触发版失败") }));
    } finally {
      setCardBusy(id, false);
    }
  };

  return { busyIds, cardErrors, handleDecide, handleResume };
}

function useGovernanceController() {
  const [data, setData] = useState<GovernanceOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabledNotice, setDisabledNotice] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const overviewGenRef = useRef(0);

  const loadOverview = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = ++overviewGenRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const overview = await getGovernanceOverview(adminSession, controller.signal);
      if (!mountedRef.current || controller.signal.aborted || gen !== overviewGenRef.current) return;
      setDisabledNotice(false);
      setData(overview);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || isAbortError(err) || gen !== overviewGenRef.current) return;
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        setDisabledNotice(true);
        setData(null);
      } else {
        setLoadError(describeError(err, "加载自治治理状态失败"));
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted && gen === overviewGenRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadOverview();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [loadOverview]);

  const handleModeSwitch = async (mode: GovernanceMode, reason: string): Promise<boolean> => {
    setModeBusy(true); setModeError(null);
    try {
      const res = await setGovernanceMode(adminSession, { mode, reason });
      if (!mountedRef.current) return false;
      setData((prev) => (prev ? { ...prev, mode: res.mode } : prev));
      void loadOverview();
      return true;
    } catch (err) {
      if (mountedRef.current) setModeError(describeError(err, "切换物理总闸失败"));
      return false;
    } finally {
      if (mountedRef.current) setModeBusy(false);
    }
  };

  const handleUnlock = async (reason: string): Promise<boolean> => {
    setUnlockBusy(true); setUnlockError(null);
    try {
      const res = await unlockGovernanceBreaker(adminSession, { reason });
      if (!mountedRef.current) return false;
      setData((prev) => (prev ? { ...prev, breaker: res.breaker } : prev));
      void loadOverview();
      return true;
    } catch (err) {
      if (mountedRef.current) setUnlockError(describeError(err, "解除熔断失败"));
      return false;
    } finally {
      if (mountedRef.current) setUnlockBusy(false);
    }
  };

  const approvals = useApprovalActions(mountedRef, setData, loadOverview);
  return { data, loading, disabledNotice, loadError, modeBusy, modeError, unlockBusy, unlockError, ...approvals, loadOverview, handleModeSwitch, handleUnlock };
}

export function GovernancePage() {
  const ctrl = useGovernanceController();
  return (
    <div className="space-y-5">
      <PageHeader
        title="自治治理"
        desc="个人版自托管可视化控制面：物理总闸、熔断解锁、一键审批拍板与健康驾驶舱。"
        icon={Shield}
        actions={
          <Button variant="secondary" size="sm" loading={ctrl.loading} onClick={() => void ctrl.loadOverview()}>
            <RefreshCw size={14} />
            刷新状态
          </Button>
        }
      />
      {ctrl.disabledNotice && (
        <Card className="flex flex-col items-center gap-2.5 px-6 py-10 text-center">
          <span className="oc-icon-badge size-11 rounded-xl"><Lock size={20} /></span>
          <h2 className="text-title font-semibold text-fg">自治治理控制面仅在个人版自托管实例启用</h2>
          <p className="max-w-md text-body text-muted">
            当前实例未开启自托管宿主控制面，或当前管理员账号无权访问该控制台。
          </p>
        </Card>
      )}
      {!ctrl.disabledNotice && ctrl.loadError && !ctrl.data && (
        <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <p className="text-body text-danger">{ctrl.loadError}</p>
          <Button variant="secondary" size="sm" onClick={() => void ctrl.loadOverview()}>重试加载</Button>
        </Card>
      )}
      {!ctrl.disabledNotice && ctrl.loading && !ctrl.data && (
        <Card className="px-6 py-10 text-center text-body text-muted">正在读取自治治理控制面状态…</Card>
      )}
      {ctrl.data && (
        <div className="space-y-5">
          <BreakerBannerSection breaker={ctrl.data.breaker} busy={ctrl.unlockBusy} error={ctrl.unlockError} onUnlock={ctrl.handleUnlock} />
          <ModeControlSection
            modeState={ctrl.data.mode}
            breakerTripped={ctrl.data.breaker.tripped}
            busy={ctrl.modeBusy}
            error={ctrl.modeError}
            onSubmit={ctrl.handleModeSwitch}
          />
          <ApprovalInboxSection
            pending={ctrl.data.pendingApprovals}
            recent={ctrl.data.recentDecisions}
            busyIds={ctrl.busyIds}
            cardErrors={ctrl.cardErrors}
            onDecide={(approval, decision, opts) => void ctrl.handleDecide(approval, decision, opts)}
            onResume={(id) => void ctrl.handleResume(id)}
            onRefresh={() => void ctrl.loadOverview()}
          />
          <CockpitAndAuditSection cockpit={ctrl.data.cockpit} auditTrail={ctrl.data.auditTrail} />
        </div>
      )}
    </div>
  );
}

export default GovernancePage;

import { Check, ExternalLink, Lock, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAuth } from "../../hooks/useProjectScope";
import {
  GOVERNANCE_APPROVAL_ID_RE,
  decideGovernanceApproval,
  getGovernanceApproval,
  resumeGovernanceApproval,
  type PendingGovernanceApproval,
} from "../../lib/api/governanceApi";
import { ApiError } from "../../lib/api/http";
import { cn } from "../../lib/utils";
import { Button } from "../ui/Button";
import { GovernanceApprovalCardView } from "../ui/GovernanceApprovalCardView";

export type GovernanceApprovalSpec = {
  type: "governance_approval";
  approvalId: string;
  title?: string;
  subtitle?: string;
};

export type GovernanceApprovalBlockProps = {
  spec: GovernanceApprovalSpec;
  notes?: string[];
  streaming?: boolean;
  readOnly?: boolean;
  nested?: boolean;
  sendUserText?: (text: string) => void;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid_id" }
  | { kind: "restricted" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; approval: PendingGovernanceApproval };

function classifyLoadError(err: unknown): LoadState {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return { kind: "restricted" };
    if (err.status === 404) {
      return err.code === "SELFHOST_GOVERNANCE_DISABLED" ? { kind: "restricted" } : { kind: "not_found" };
    }
    return { kind: "error", message: err.message };
  }
  return { kind: "error", message: err instanceof Error ? err.message : "加载审批单失败，请稍后重试。" };
}

function buildContinueReceipt(approval: PendingGovernanceApproval): string {
  const action = approval.status === "approved" ? "已批准" : "已驳回";
  const artifact = approval.decision?.issuedArtifactId ? `（凭证 ${approval.decision.issuedArtifactId}）` : "";
  return `审批单 ${approval.id} ${action}${artifact}，请继续后续验收与处理。`;
}

function ApprovalSkeleton({ nested }: { nested?: boolean }) {
  return (
    <output
      aria-live="polite"
      aria-label="正在加载操作卡片"
      data-testid="governance-approval-skeleton"
      className={cn("oc-surface-card block space-y-3 rounded-xl border border-border bg-surface p-3.5", nested && "border-0 shadow-none")}
    >
      <div className="flex items-center gap-2">
        <span className="h-5 w-16 animate-pulse rounded-full bg-muted/20" />
        <span className="h-5 w-24 animate-pulse rounded-full bg-muted/20" />
      </div>
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted/20" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <span className="h-12 animate-pulse rounded-lg bg-muted/15" />
        <span className="h-12 animate-pulse rounded-lg bg-muted/15" />
      </div>
    </output>
  );
}

function NoticeCard({ icon, message, showConsoleLink, onRetry, testId }: {
  icon: "lock" | "alert"; message: string; showConsoleLink?: boolean; onRetry?: () => void; testId: string;
}) {
  return (
    <div data-testid={testId} className="oc-surface-card flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-meta text-muted">
      <span className="inline-flex items-center gap-2">
        {icon === "lock" ? <Lock size={15} className="shrink-0 text-faint" /> : <ShieldAlert size={15} className="shrink-0 text-warning" />}
        <span>{message}</span>
      </span>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden="true" />重试
          </Button>
        )}
        {showConsoleLink && (
          <a href="/admin/#tab=governance" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent-soft">
            打开治理控制台<ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

function buildDecideBody(
  decision: "approve" | "reject",
  opts: { note?: string; autoResumeTrain: boolean },
  current: PendingGovernanceApproval | null,
) {
  return {
    decision,
    note: opts.note,
    autoResumeTrain: opts.autoResumeTrain,
    ...(current?.version !== undefined ? { expectedVersion: current.version } : {}),
    ...(current?.sha256 ? { expectedSha256: current.sha256 } : {}),
  };
}

function conflictNoticeFor(synced: PendingGovernanceApproval): string {
  return synced.status === "approving"
    ? "该审批单正在处理中，请稍候刷新。"
    : "该审批单已在其他页面完成处理，已同步最新状态。";
}

function useGovernanceApprovalActions(params: {
  approvalId: string;
  validId: boolean;
  auth: ReturnType<typeof useOptionalAuth>;
  state: LoadState;
  busy: boolean;
  mountedRef: MutableRefObject<boolean>;
  reqGenRef: MutableRefObject<number>;
  currentApprovalIdRef: MutableRefObject<string>;
  isCurrent: (gen: number, targetId: string) => boolean;
  loadApproval: (targetId: string) => Promise<PendingGovernanceApproval | null>;
  setState: Dispatch<SetStateAction<LoadState>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  setSyncNotice: Dispatch<SetStateAction<string | null>>;
  setDecidedHere: Dispatch<SetStateAction<boolean>>;
}) {
  const {
    approvalId, validId, auth, state, busy, mountedRef, reqGenRef, currentApprovalIdRef,
    isCurrent, loadApproval, setState, setBusy, setActionError, setSyncNotice, setDecidedHere,
  } = params;

  const handleDecide = useCallback(async (decision: "approve" | "reject", opts: { note?: string; autoResumeTrain: boolean }) => {
    if (!auth || !validId || busy) return;
    const targetId = approvalId;
    const gen = ++reqGenRef.current;
    const body = buildDecideBody(decision, opts, state.kind === "ready" ? state.approval : null);
    setBusy(true); setActionError(null); setSyncNotice(null);
    try {
      const res = await decideGovernanceApproval(auth, targetId, body);
      if (!isCurrent(gen, targetId)) return;
      setState({ kind: "ready", approval: res.approval });
      setDecidedHere(true);
    } catch (err) {
      if (!isCurrent(gen, targetId)) return;
      if (err instanceof ApiError && err.status === 409) {
        const synced = await loadApproval(targetId);
        if (synced && mountedRef.current && currentApprovalIdRef.current === targetId) setSyncNotice(conflictNoticeFor(synced));
      } else {
        setActionError(err instanceof Error ? err.message : "提交审批决定失败，请稍后重试。");
      }
    } finally {
      if (mountedRef.current && currentApprovalIdRef.current === targetId) setBusy(false);
    }
  }, [approvalId, auth, busy, currentApprovalIdRef, isCurrent, loadApproval, mountedRef, reqGenRef, setActionError, setBusy, setDecidedHere, setState, setSyncNotice, state, validId]);

  const handleResume = useCallback(async () => {
    if (!auth || !validId || busy) return;
    const targetId = approvalId;
    const gen = ++reqGenRef.current;
    setBusy(true); setActionError(null); setSyncNotice(null);
    try {
      const res = await resumeGovernanceApproval(auth, targetId);
      if (!isCurrent(gen, targetId)) return;
      setState({ kind: "ready", approval: res.approval });
    } catch (err) {
      if (!isCurrent(gen, targetId)) return;
      setActionError(err instanceof Error ? err.message : "重触发版失败，请稍后重试。");
    } finally {
      if (mountedRef.current && currentApprovalIdRef.current === targetId) setBusy(false);
    }
  }, [approvalId, auth, busy, currentApprovalIdRef, isCurrent, mountedRef, reqGenRef, setActionError, setBusy, setState, setSyncNotice, validId]);

  return { handleDecide, handleResume };
}

function useGovernanceApprovalState(approvalId: string, validId: boolean, streaming: boolean) {
  const auth = useOptionalAuth();
  const [state, setState] = useState<LoadState>(() => (validId ? { kind: "loading" } : { kind: "invalid_id" }));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [decidedHere, setDecidedHere] = useState(false);
  const [notified, setNotified] = useState(false);

  const mountedRef = useRef(true);
  const activeAbortRef = useRef<AbortController | null>(null);
  const reqGenRef = useRef(0);
  const currentApprovalIdRef = useRef(approvalId);
  currentApprovalIdRef.current = approvalId;

  const isCurrent = useCallback(
    (gen: number, targetId: string) => mountedRef.current && reqGenRef.current === gen && currentApprovalIdRef.current === targetId,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, []);

  const loadApproval = useCallback(async (targetId: string): Promise<PendingGovernanceApproval | null> => {
    activeAbortRef.current?.abort();
    const gen = ++reqGenRef.current;
    if (!GOVERNANCE_APPROVAL_ID_RE.test(targetId)) { setState({ kind: "invalid_id" }); return null; }
    if (!auth) { setState({ kind: "restricted" }); return null; }
    const ctrl = new AbortController();
    activeAbortRef.current = ctrl;
    try {
      const res = await getGovernanceApproval(auth, targetId, ctrl.signal);
      if (ctrl.signal.aborted || !isCurrent(gen, targetId)) return null;
      if (res.approval.id !== targetId) { setState({ kind: "error", message: "审批单编号校验不一致，已拒绝展示。" }); return null; }
      setState({ kind: "ready", approval: res.approval });
      return res.approval;
    } catch (err) {
      if (ctrl.signal.aborted || !isCurrent(gen, targetId) || (err instanceof DOMException && err.name === "AbortError")) return null;
      setState(classifyLoadError(err));
      return null;
    } finally {
      if (activeAbortRef.current === ctrl) activeAbortRef.current = null;
    }
  }, [auth, isCurrent]);

  useEffect(() => {
    activeAbortRef.current?.abort();
    reqGenRef.current += 1;
    setBusy(false); setActionError(null); setSyncNotice(null); setDecidedHere(false); setNotified(false);
    if (streaming) return undefined;
    if (!validId) { setState({ kind: "invalid_id" }); return undefined; }
    if (!auth) { setState({ kind: "restricted" }); return undefined; }
    setState({ kind: "loading" });
    void loadApproval(approvalId);
    return () => { activeAbortRef.current?.abort(); };
  }, [approvalId, auth, loadApproval, streaming, validId]);

  const handleRefresh = useCallback(() => {
    setActionError(null); setSyncNotice(null);
    void loadApproval(approvalId);
  }, [approvalId, loadApproval]);

  const { handleDecide, handleResume } = useGovernanceApprovalActions({
    approvalId, validId, auth, state, busy, mountedRef, reqGenRef, currentApprovalIdRef,
    isCurrent, loadApproval, setState, setBusy, setActionError, setSyncNotice, setDecidedHere,
  });

  return { state, busy, actionError, syncNotice, decidedHere, notified, setNotified, handleRefresh, handleDecide, handleResume };
}

export function GovernanceApprovalBlock({ spec, streaming = false, readOnly = false, nested = false, sendUserText }: GovernanceApprovalBlockProps) {
  const approvalId = typeof spec.approvalId === "string" ? spec.approvalId.trim() : "";
  const validId = GOVERNANCE_APPROVAL_ID_RE.test(approvalId);
  const ctrl = useGovernanceApprovalState(approvalId, validId, streaming);

  if (streaming || ctrl.state.kind === "loading") return <ApprovalSkeleton nested={nested} />;
  if (ctrl.state.kind === "invalid_id") return <NoticeCard icon="alert" message="操作卡片编号格式无效，已拒绝加载。" testId="governance-approval-invalid" />;
  if (ctrl.state.kind === "restricted") return <NoticeCard icon="lock" message="该操作卡片当前不可用" testId="governance-approval-restricted" />;
  if (ctrl.state.kind === "not_found") return <NoticeCard icon="alert" message="审批单不存在或已归档" showConsoleLink testId="governance-approval-not-found" />;
  if (ctrl.state.kind === "error") return <NoticeCard icon="alert" message={ctrl.state.message} showConsoleLink onRetry={ctrl.handleRefresh} testId="governance-approval-error" />;

  const { approval } = ctrl.state;
  const canNotify = ctrl.decidedHere && approval.status !== "pending" && !readOnly && Boolean(sendUserText);

  return (
    <figure className={cn("oc-iui", nested ? "oc-iui-nested" : "oc-iui-bare", "space-y-2")} data-iui="governance_approval">
      {ctrl.syncNotice && (
        <output className="block rounded-lg border border-warning/30 bg-warning-soft/50 px-3 py-2 text-caption text-warning">{ctrl.syncNotice}</output>
      )}
      <GovernanceApprovalCardView
        approval={approval}
        compact
        showConsoleLink
        readOnly={readOnly || streaming}
        busy={ctrl.busy}
        error={ctrl.actionError}
        onDecide={ctrl.handleDecide}
        onResume={ctrl.handleResume}
        onRefresh={ctrl.handleRefresh}
      />
      {canNotify && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" disabled={ctrl.notified} onClick={() => { if (!ctrl.notified) { ctrl.setNotified(true); sendUserText?.(buildContinueReceipt(approval)); } }}>
            {ctrl.notified ? <Check size={13} aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
            {ctrl.notified ? "已通知助手继续" : "通知助手继续验收"}
          </Button>
        </div>
      )}
    </figure>
  );
}

export default GovernanceApprovalBlock;

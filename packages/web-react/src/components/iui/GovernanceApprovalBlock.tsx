import { ExternalLink, Lock, RefreshCw, Send, ShieldAlert } from "lucide-react";
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
import type { ChatInteraction } from "../tool/context";
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
  sendUserText?: ChatInteraction["sendUserText"];
  chatBusy?: boolean;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid_id" }
  | { kind: "restricted" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; approval: PendingGovernanceApproval };

type AutoNotifyState = "idle" | "queued" | "sending" | "sent" | "failed";
type QueuedReceipt = { approvalId: string; key: string; text: string };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

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

function describeResumeForReceipt(approval: PendingGovernanceApproval): string {
  const decision = approval.decision;
  if (!decision || approval.status !== "approved") return "";
  switch (decision.resumeStatus) {
    case "started":
    case "starting":
    case "running":
      return "，已自动拉起发版";
    case "completed":
      return "，发版已完成";
    case "not_started_busy":
      return "，当前有其他发版进行中暂未自动发车";
    case "head_moved":
      return "，主分支已有新提交未自动发版";
    case "failed": {
      const reason = (decision.resumeDetail || approval.lastError || "").trim();
      return reason ? `，但自动拉起发版失败（${reason}）` : "，但自动拉起发版失败";
    }
    case "skipped":
      return "，已按设置跳过自动发版";
    case "not_started":
      return "，尚未拉起发版";
    default:
      return "";
  }
}

export function buildContinueReceipt(approval: PendingGovernanceApproval): string {
  const approved = approval.status === "approved";
  const action = approved ? "已批准" : "已驳回";
  const artifact = approved && approval.decision?.issuedArtifactId
    ? `（凭证 ${approval.decision.issuedArtifactId}）`
    : "";
  const resumePart = describeResumeForReceipt(approval);
  const noteText = approval.decision?.note?.trim();
  const notePart = noteText ? `；备注：${noteText}` : "";
  const tail = approved ? "请直接继续后续验收与处理。" : "请根据驳回意见调整或给出后续方案。";
  return `审批单 ${approval.id} ${action}${artifact}${resumePart}${notePart}。${tail}`;
}

function receiptKeyFor(approval: PendingGovernanceApproval): string {
  return `${approval.id}:${approval.version ?? approval.status}`;
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
  onDecided: (approval: PendingGovernanceApproval) => void;
}) {
  const {
    approvalId, validId, auth, state, busy, mountedRef, reqGenRef, currentApprovalIdRef,
    isCurrent, loadApproval, setState, setBusy, setActionError, setSyncNotice, setDecidedHere, onDecided,
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
      onDecided(res.approval);
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
  }, [approvalId, auth, busy, currentApprovalIdRef, isCurrent, loadApproval, mountedRef, onDecided, reqGenRef, setActionError, setBusy, setDecidedHere, setState, setSyncNotice, state, validId]);

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

function buildQueuedReceipt(approval: PendingGovernanceApproval): QueuedReceipt {
  return {
    approvalId: approval.id,
    key: receiptKeyFor(approval),
    text: buildContinueReceipt(approval),
  };
}

async function runReceiptDelivery(params: {
  receipt: QueuedReceipt;
  sender: NonNullable<ChatInteraction["sendUserText"]>;
  isStillCurrent: () => boolean;
  onSending: () => void;
  onSettled: (accepted: boolean) => boolean;
  onDone: () => void;
}): Promise<boolean> {
  const { receipt, sender, isStillCurrent, onSending, onSettled, onDone } = params;
  try {
    const result = sender(receipt.text);
    if (isPromiseLike(result)) {
      onSending();
      try {
        const accepted = await result;
        return isStillCurrent() ? onSettled(accepted !== false) : false;
      } catch {
        return isStillCurrent() ? onSettled(false) : false;
      } finally {
        onDone();
      }
    }
    onDone();
    return isStillCurrent() ? onSettled(result !== false) : false;
  } catch {
    onDone();
    return isStillCurrent() ? onSettled(false) : false;
  }
}

function useAutoNotifyReceipt(params: {
  approvalId: string;
  readOnly: boolean;
  sendUserText?: ChatInteraction["sendUserText"];
  chatBusy: boolean;
  mountedRef: MutableRefObject<boolean>;
  currentApprovalIdRef: MutableRefObject<string>;
}) {
  const { approvalId, readOnly, sendUserText, chatBusy, mountedRef, currentApprovalIdRef } = params;
  const [autoNotifyState, setAutoNotifyState] = useState<AutoNotifyState>("idle");
  const [pendingAutoReceipt, setPendingAutoReceipt] = useState<QueuedReceipt | null>(null);
  const autoNotifiedKeyRef = useRef<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const notifyEpochRef = useRef(0);
  const chatBusyRef = useRef(chatBusy);
  const readOnlyRef = useRef(readOnly);
  const sendUserTextRef = useRef(sendUserText);

  chatBusyRef.current = chatBusy;
  readOnlyRef.current = readOnly;
  sendUserTextRef.current = sendUserText;

  const dispatchAutoReceipt = useCallback(async (receipt: QueuedReceipt): Promise<boolean> => {
    if (!mountedRef.current || receipt.approvalId !== currentApprovalIdRef.current) return false;
    if (autoNotifiedKeyRef.current === receipt.key) return true;
    if (inFlightKeyRef.current !== null) return false;
    const sender = sendUserTextRef.current;
    if (readOnlyRef.current || !sender) return false;
    const sendEpoch = notifyEpochRef.current;
    inFlightKeyRef.current = receipt.key;
    return runReceiptDelivery({
      receipt,
      sender,
      isStillCurrent: () =>
        mountedRef.current &&
        notifyEpochRef.current === sendEpoch &&
        receipt.approvalId === currentApprovalIdRef.current,
      onSending: () => {
        setPendingAutoReceipt(receipt);
        setAutoNotifyState("sending");
      },
      onSettled: (accepted) => {
        if (!accepted) {
          setPendingAutoReceipt(receipt);
          setAutoNotifyState("failed");
          return false;
        }
        autoNotifiedKeyRef.current = receipt.key;
        setPendingAutoReceipt(null);
        setAutoNotifyState("sent");
        return true;
      },
      onDone: () => {
        if (inFlightKeyRef.current === receipt.key) inFlightKeyRef.current = null;
      },
    });
  }, [currentApprovalIdRef, mountedRef]);

  const handleDecided = useCallback((approval: PendingGovernanceApproval) => {
    if (approval.status === "pending" || readOnlyRef.current || !sendUserTextRef.current) return;
    const receipt = buildQueuedReceipt(approval);
    if (autoNotifiedKeyRef.current === receipt.key || inFlightKeyRef.current === receipt.key) return;
    if (!chatBusyRef.current) {
      void dispatchAutoReceipt(receipt);
    } else {
      setPendingAutoReceipt(receipt);
      setAutoNotifyState("queued");
    }
  }, [dispatchAutoReceipt]);

  const resetAutoNotify = useCallback(() => {
    notifyEpochRef.current += 1;
    autoNotifiedKeyRef.current = null;
    inFlightKeyRef.current = null;
    setAutoNotifyState("idle");
    setPendingAutoReceipt(null);
  }, []);

  useEffect(() => {
    if (!chatBusy && autoNotifyState === "queued" && pendingAutoReceipt && pendingAutoReceipt.approvalId === approvalId) {
      void dispatchAutoReceipt(pendingAutoReceipt);
    }
  }, [approvalId, autoNotifyState, chatBusy, dispatchAutoReceipt, pendingAutoReceipt]);

  const retryNotifyFor = useCallback((approval: PendingGovernanceApproval | null) => {
    if (!approval || approval.status === "pending" || chatBusyRef.current || inFlightKeyRef.current !== null) return;
    const receipt = pendingAutoReceipt && pendingAutoReceipt.approvalId === approval.id
      ? pendingAutoReceipt
      : buildQueuedReceipt(approval);
    void dispatchAutoReceipt(receipt);
  }, [dispatchAutoReceipt, pendingAutoReceipt]);

  return { autoNotifyState, handleDecided, resetAutoNotify, retryNotifyFor };
}

function useGovernanceApprovalState(params: {
  approvalId: string;
  validId: boolean;
  streaming: boolean;
  readOnly: boolean;
  sendUserText?: ChatInteraction["sendUserText"];
  chatBusy: boolean;
}) {
  const { approvalId, validId, streaming, readOnly, sendUserText, chatBusy } = params;
  const auth = useOptionalAuth();
  const [state, setState] = useState<LoadState>(() => (validId ? { kind: "loading" } : { kind: "invalid_id" }));
  const [confirmedAuthorized, setConfirmedAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [decidedHere, setDecidedHere] = useState(false);

  const mountedRef = useRef(true);
  const activeAbortRef = useRef<AbortController | null>(null);
  const reqGenRef = useRef(0);
  const currentApprovalIdRef = useRef(approvalId);
  currentApprovalIdRef.current = approvalId;

  const { autoNotifyState, handleDecided, resetAutoNotify, retryNotifyFor } = useAutoNotifyReceipt({
    approvalId, readOnly, sendUserText, chatBusy, mountedRef, currentApprovalIdRef,
  });

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
    if (!auth) { setConfirmedAuthorized(false); setState({ kind: "restricted" }); return null; }
    const ctrl = new AbortController();
    activeAbortRef.current = ctrl;
    try {
      const res = await getGovernanceApproval(auth, targetId, ctrl.signal);
      if (ctrl.signal.aborted || !isCurrent(gen, targetId)) return null;
      if (res.approval.id !== targetId) { setState({ kind: "error", message: "审批单编号校验不一致，已拒绝展示。" }); return null; }
      setConfirmedAuthorized(true);
      setState({ kind: "ready", approval: res.approval });
      return res.approval;
    } catch (err) {
      if (ctrl.signal.aborted || !isCurrent(gen, targetId) || (err instanceof DOMException && err.name === "AbortError")) return null;
      const next = classifyLoadError(err);
      if (next.kind === "restricted") setConfirmedAuthorized(false);
      setState(next);
      return null;
    } finally {
      if (activeAbortRef.current === ctrl) activeAbortRef.current = null;
    }
  }, [auth, isCurrent]);

  useEffect(() => {
    activeAbortRef.current?.abort();
    reqGenRef.current += 1;
    setConfirmedAuthorized(false); setBusy(false); setActionError(null); setSyncNotice(null); setDecidedHere(false);
    resetAutoNotify();
    if (streaming) return undefined;
    if (!validId) { setState({ kind: "invalid_id" }); return undefined; }
    if (!auth) { setState({ kind: "restricted" }); return undefined; }
    setState({ kind: "loading" });
    void loadApproval(approvalId);
    return () => { activeAbortRef.current?.abort(); };
  }, [approvalId, auth, loadApproval, resetAutoNotify, streaming, validId]);

  const handleRefresh = useCallback(() => {
    setActionError(null); setSyncNotice(null);
    void loadApproval(approvalId);
  }, [approvalId, loadApproval]);

  const handleRetryNotify = useCallback(() => {
    retryNotifyFor(state.kind === "ready" ? state.approval : null);
  }, [retryNotifyFor, state]);

  const { handleDecide, handleResume } = useGovernanceApprovalActions({
    approvalId, validId, auth, state, busy, mountedRef, reqGenRef, currentApprovalIdRef,
    isCurrent, loadApproval, setState, setBusy, setActionError, setSyncNotice, setDecidedHere, onDecided: handleDecided,
  });

  return {
    state, confirmedAuthorized, busy, actionError, syncNotice, decidedHere, autoNotifyState,
    handleRefresh, handleDecide, handleResume, handleRetryNotify,
  };
}

function AutoNotifyFooter({
  autoNotifyState,
  canSend,
  chatBusy,
  onRetry,
}: {
  autoNotifyState: AutoNotifyState;
  canSend: boolean;
  chatBusy: boolean;
  onRetry: () => void;
}) {
  if (autoNotifyState === "sent") {
    return (
      <output
        data-testid="governance-approval-auto-notified"
        className="flex items-center justify-end px-1 text-caption font-medium text-success"
      >
        ✓ 已自动通知助手继续处理
      </output>
    );
  }
  if (autoNotifyState === "queued") {
    return (
      <output
        data-testid="governance-approval-auto-queued"
        className="flex items-center justify-end px-1 text-caption text-muted"
      >
        已生效，待助手本轮结束后自动通知继续
      </output>
    );
  }
  if (autoNotifyState === "sending") {
    return (
      <output
        data-testid="governance-approval-auto-sending"
        className="flex items-center justify-end px-1 text-caption text-muted"
      >
        正在通知助手继续处理…
      </output>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-caption text-muted">
        {autoNotifyState === "failed"
          ? "自动通知助手失败，请点击重试"
          : "当前无法自动通知助手，可手动通知继续"}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={!canSend || chatBusy}
        onClick={onRetry}
      >
        <Send size={13} aria-hidden="true" />
        {autoNotifyState === "failed" ? "重试通知助手继续" : "通知助手继续"}
      </Button>
    </div>
  );
}

export function GovernanceApprovalBlock({
  spec,
  streaming = false,
  readOnly = false,
  nested = false,
  sendUserText,
  chatBusy = false,
}: GovernanceApprovalBlockProps) {
  const approvalId = typeof spec.approvalId === "string" ? spec.approvalId.trim() : "";
  const validId = GOVERNANCE_APPROVAL_ID_RE.test(approvalId);
  const ctrl = useGovernanceApprovalState({ approvalId, validId, streaming, readOnly, sendUserText, chatBusy });

  if (streaming || ctrl.state.kind === "loading") return <ApprovalSkeleton nested={nested} />;
  if (ctrl.state.kind === "invalid_id") return <NoticeCard icon="alert" message="操作卡片编号格式无效，已拒绝加载。" testId="governance-approval-invalid" />;
  if (ctrl.state.kind === "restricted") return <NoticeCard icon="lock" message="该操作卡片当前不可用" testId="governance-approval-restricted" />;
  if (ctrl.state.kind === "not_found") {
    return ctrl.confirmedAuthorized ? (
      <NoticeCard icon="alert" message="审批单不存在或已归档" showConsoleLink testId="governance-approval-not-found" />
    ) : (
      <NoticeCard icon="lock" message="该操作卡片当前不可用" showConsoleLink={false} testId="governance-approval-not-found" />
    );
  }
  if (ctrl.state.kind === "error") {
    return ctrl.confirmedAuthorized ? (
      <NoticeCard icon="alert" message={ctrl.state.message} showConsoleLink onRetry={ctrl.handleRefresh} testId="governance-approval-error" />
    ) : (
      <NoticeCard icon="alert" message="暂时无法加载该操作卡片，请稍后重试" showConsoleLink={false} onRetry={ctrl.handleRefresh} testId="governance-approval-error" />
    );
  }

  const { approval } = ctrl.state;
  const showNotifyFooter = ctrl.decidedHere && approval.status !== "pending" && !readOnly;

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
      {showNotifyFooter && (
        <AutoNotifyFooter
          autoNotifyState={ctrl.autoNotifyState}
          canSend={Boolean(sendUserText)}
          chatBusy={chatBusy}
          onRetry={ctrl.handleRetryNotify}
        />
      )}
    </figure>
  );
}

export default GovernanceApprovalBlock;

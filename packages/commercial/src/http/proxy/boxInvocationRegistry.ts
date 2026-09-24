/** OCV5-289 cross-HTTP ownership for a supervised Box CLI awaiting a tool.
 *
 * In-memory control-plane primitive only. Production wiring must journal the
 * lease durably before exposing tool_use, and reconcile unknown after restart.
 * A request's close event is deliberately not the lifetime of a handed-off
 * remote CLI. No user content or account credential is held here.
 */
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-invocation" });
export type BoxInvocationState =
  | "running" | "waiting_tool_result" | "resuming" | "unknown"
  | "stopped_cleanup_pending" | "stopped_cleanup_failed" | "completed";

export interface BoxInvocationLease {
  readonly uid: bigint;
  readonly sessionId: string;
  readonly accountId: bigint;
  readonly signal: AbortSignal;
  readonly openedAt: number;
  readonly deadlineAt: number;
  state: BoxInvocationState;
  toolUseId: string | null;
  mcpRequestId: string | number | null;
}

interface PrivateLease extends BoxInvocationLease {
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onRemoteStopped?: () => void | Promise<void>;
}

export class BoxInvocationConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BoxInvocationConflict";
  }
}

export class BoxInvocationRegistry {
  private readonly active = new Map<string, PrivateLease>();
  private readonly userCounts = new Map<bigint, number>();
  private readonly accountCounts = new Map<bigint, number>();

  constructor(private readonly limits: {
    maxPerUser: number;
    maxPerAccount: number;
    leaseMs: number;
  }, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(limits.maxPerUser) || limits.maxPerUser < 1
      || !Number.isSafeInteger(limits.maxPerAccount) || limits.maxPerAccount < 1
      || !Number.isSafeInteger(limits.leaseMs) || limits.leaseMs < 1000
      || limits.leaseMs > 900_000) {
      throw new BoxInvocationConflict("BOX_LEASE_LIMIT_INVALID");
    }
  }

  private key(uid: bigint, sessionId: string): string {
    if (uid <= 0n || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
      throw new BoxInvocationConflict("BOX_LEASE_IDENTITY_INVALID");
    }
    return `${uid}:${sessionId}`;
  }

  open(input: { uid: bigint; sessionId: string; accountId: bigint;
    /** Remaining shared request budget; never exceeds the registry ceiling. */
    leaseMs?: number;
    /** Owns per-invocation egress resources until remote termination is proven. */
    onRemoteStopped?: () => void | Promise<void> }): BoxInvocationLease {
    const key = this.key(input.uid, input.sessionId);
    if (input.accountId <= 0n) throw new BoxInvocationConflict("BOX_ACCOUNT_ID_INVALID");
    if (this.active.has(key)) throw new BoxInvocationConflict("BOX_SESSION_BUSY");
    if ((this.userCounts.get(input.uid) ?? 0) >= this.limits.maxPerUser) {
      throw new BoxInvocationConflict("BOX_USER_CAPACITY_FULL");
    }
    if ((this.accountCounts.get(input.accountId) ?? 0) >= this.limits.maxPerAccount) {
      throw new BoxInvocationConflict("BOX_ACCOUNT_CAPACITY_FULL");
    }
    const leaseMs = input.leaseMs ?? this.limits.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > this.limits.leaseMs) {
      throw new BoxInvocationConflict("BOX_LEASE_LIMIT_INVALID");
    }
    const controller = new AbortController();
    const openedAt = this.now();
    const lease: PrivateLease = {
      uid: input.uid, sessionId: input.sessionId, accountId: input.accountId,
      signal: controller.signal, controller, openedAt,
      deadlineAt: openedAt + leaseMs,
      state: "running", toolUseId: null, mcpRequestId: null,
      timer: setTimeout(() => this.markUnknown(lease), leaseMs),
      onRemoteStopped: input.onRemoteStopped,
    };
    this.active.set(key, lease);
    this.userCounts.set(input.uid, (this.userCounts.get(input.uid) ?? 0) + 1);
    this.accountCounts.set(input.accountId, (this.accountCounts.get(input.accountId) ?? 0) + 1);
    return lease;
  }

  private requireActive(handle: BoxInvocationLease): PrivateLease {
    const key = this.key(handle.uid, handle.sessionId);
    const current = this.active.get(key);
    if (current !== handle) throw new BoxInvocationConflict("BOX_LEASE_STALE");
    return current;
  }

  private requireNotExpired(lease: PrivateLease): void {
    // Timer callbacks are not a clock: event-loop stalls can delay them while
    // another callback tries to claim an already-expired paid invocation.
    if (this.now() >= lease.deadlineAt) {
      this.markUnknown(lease);
      throw new BoxInvocationConflict("BOX_LEASE_EXPIRED");
    }
  }

  handoff(handle: BoxInvocationLease, toolUseId: string, mcpRequestId: string | number): void {
    const lease = this.requireActive(handle);
    this.requireNotExpired(lease);
    if (lease.state !== "running" || !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)
      || (typeof mcpRequestId !== "string" && !Number.isSafeInteger(mcpRequestId))
      || mcpRequestId === toolUseId) {
      throw new BoxInvocationConflict("BOX_HANDOFF_INVALID");
    }
    lease.toolUseId = toolUseId;
    lease.mcpRequestId = mcpRequestId;
    lease.state = "waiting_tool_result";
  }

  /** A normal first HTTP res.end() after handoff must NOT abort the CLI. */
  firstResponseClosed(handle: BoxInvocationLease): "held" | "aborted" {
    const lease = this.requireActive(handle);
    if (this.now() >= lease.deadlineAt) {
      this.markUnknown(lease);
      return "aborted";
    }
    if (lease.state === "waiting_tool_result" || lease.state === "resuming") return "held";
    if (lease.state === "running") {
      this.markUnknown(lease);
      return "aborted";
    }
    throw new BoxInvocationConflict("BOX_FIRST_RESPONSE_STATE_INVALID");
  }

  claimToolResult(input: {
    uid: bigint; sessionId: string; toolUseId: string;
  }): BoxInvocationLease {
    const lease = this.active.get(this.key(input.uid, input.sessionId));
    if (lease) this.requireNotExpired(lease);
    if (!lease || lease.state !== "waiting_tool_result" || lease.toolUseId !== input.toolUseId) {
      throw new BoxInvocationConflict("BOX_TOOL_RESULT_NOT_MATCHED");
    }
    lease.state = "resuming";
    return lease;
  }

  /** Transport ambiguity is not proof of remote termination. Keep capacity. */
  markUnknown(handle: BoxInvocationLease): void {
    const lease = this.requireActive(handle);
    if (lease.state === "completed" || lease.state === "unknown"
      || lease.state === "stopped_cleanup_pending" || lease.state === "stopped_cleanup_failed") return;
    lease.state = "unknown";
    lease.controller.abort();
  }

  /** Call only after an authoritative remote terminal event / watchdog fence. */
  confirmRemoteStopped(handle: BoxInvocationLease): void {
    const lease = this.requireActive(handle);
    clearTimeout(lease.timer);
    if (lease.state === "stopped_cleanup_pending" || lease.state === "stopped_cleanup_failed") {
      throw new BoxInvocationConflict("BOX_CLEANUP_ALREADY_OWNED");
    }
    if (!lease.onRemoteStopped) {
      this.release(lease);
      return;
    }
    this.startCleanup(lease);
  }

  /** Operator/reconciler action only, after a settled failed dispose. Never
   * blindly retry a pending close whose outcome is still unknown. */
  retryFailedCleanup(handle: BoxInvocationLease): void {
    const lease = this.requireActive(handle);
    if (lease.state !== "stopped_cleanup_failed") {
      throw new BoxInvocationConflict("BOX_CLEANUP_NOT_FAILED");
    }
    this.startCleanup(lease);
  }

  private startCleanup(lease: PrivateLease): void {
    lease.state = "stopped_cleanup_pending";
    void Promise.resolve().then(() => lease.onRemoteStopped!()).then(() => {
      if (lease.state === "stopped_cleanup_pending") this.release(lease);
    }, () => {
      lease.state = "stopped_cleanup_failed";
      log.error("BOX_EGRESS_DISPOSE_FAILED", { uid: lease.uid.toString(),
        accountId: lease.accountId.toString(), sessionId: lease.sessionId });
    });
  }

  private release(lease: PrivateLease): void {
    lease.state = "completed";
    this.active.delete(this.key(lease.uid, lease.sessionId));
    const userCount = (this.userCounts.get(lease.uid) ?? 0) - 1;
    const accountCount = (this.accountCounts.get(lease.accountId) ?? 0) - 1;
    if (userCount > 0) this.userCounts.set(lease.uid, userCount);
    else this.userCounts.delete(lease.uid);
    if (accountCount > 0) this.accountCounts.set(lease.accountId, accountCount);
    else this.accountCounts.delete(lease.accountId);
  }

  counts(uid: bigint, accountId: bigint): { user: number; account: number } {
    return { user: this.userCounts.get(uid) ?? 0, account: this.accountCounts.get(accountId) ?? 0 };
  }
}

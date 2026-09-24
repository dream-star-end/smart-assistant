/** OCV5-289 cross-HTTP ownership for a supervised Box CLI awaiting a tool.
 *
 * In-memory control-plane primitive only. Production wiring must journal the
 * lease durably before exposing tool_use, and reconcile unknown after restart.
 * A request's close event is deliberately not the lifetime of a handed-off
 * remote CLI. No user content or account credential is held here.
 */
export type BoxInvocationState =
  | "running" | "waiting_tool_result" | "resuming" | "unknown" | "completed";

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
      || limits.leaseMs > 120_000) {
      throw new BoxInvocationConflict("BOX_LEASE_LIMIT_INVALID");
    }
  }

  private key(uid: bigint, sessionId: string): string {
    if (uid <= 0n || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
      throw new BoxInvocationConflict("BOX_LEASE_IDENTITY_INVALID");
    }
    return `${uid}:${sessionId}`;
  }

  open(input: { uid: bigint; sessionId: string; accountId: bigint }): BoxInvocationLease {
    const key = this.key(input.uid, input.sessionId);
    if (input.accountId <= 0n) throw new BoxInvocationConflict("BOX_ACCOUNT_ID_INVALID");
    if (this.active.has(key)) throw new BoxInvocationConflict("BOX_SESSION_BUSY");
    if ((this.userCounts.get(input.uid) ?? 0) >= this.limits.maxPerUser) {
      throw new BoxInvocationConflict("BOX_USER_CAPACITY_FULL");
    }
    if ((this.accountCounts.get(input.accountId) ?? 0) >= this.limits.maxPerAccount) {
      throw new BoxInvocationConflict("BOX_ACCOUNT_CAPACITY_FULL");
    }
    const controller = new AbortController();
    const openedAt = this.now();
    const lease: PrivateLease = {
      uid: input.uid, sessionId: input.sessionId, accountId: input.accountId,
      signal: controller.signal, controller, openedAt,
      deadlineAt: openedAt + this.limits.leaseMs,
      state: "running", toolUseId: null, mcpRequestId: null,
      timer: setTimeout(() => this.markUnknown(lease), this.limits.leaseMs),
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
    if (lease.state === "completed" || lease.state === "unknown") return;
    lease.state = "unknown";
    lease.controller.abort();
  }

  /** Call only after an authoritative remote terminal event / watchdog fence. */
  confirmRemoteStopped(handle: BoxInvocationLease): void {
    const lease = this.requireActive(handle);
    clearTimeout(lease.timer);
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

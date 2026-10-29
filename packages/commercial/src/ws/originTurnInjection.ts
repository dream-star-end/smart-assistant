/** Shared durable origin-turn admission and delivery for cron, dlgcb and lsc. */
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { computeDispatchRequestHash, isClientMessageId } from "@openclaude/protocol";
import { containerLinkOriginInjected } from "../admin/metrics.js";
import { ModelSwitchCostError, type ModelSwitchCostService } from "../billing/modelSwitchCost.js";
import { readClientSessionModelId } from "../db/pgSessionsBackend.js";
import { casToTerminal } from "../dispatch/turnDispatchStore.js";
import type { Logger } from "../logging/logger.js";
import type { UserChatBridgeDeps } from "./userChatBridge.js";
import { getContainerLinkHandle } from "./containerLink.js";
import { waitForOriginExecutor, type ContainerLinkLease } from "./containerLinkWake.js";
import type { LinkCarrier } from "./containerLinkRecoveryStore.js";

function ensureRequestIdServerSide(): string {
  return randomBytes(16).toString("hex");
}

/** One shared origin pipe. The link owns transport availability; PG owns admission. */
export async function injectOriginTurn(options: {
  deps: UserChatBridgeDeps; input: CronOriginInjectInput; linksEnabled: boolean;
  getExecutors(): CronOriginExecutor[];
  acquire?: (carrier: LinkCarrier) => Promise<ContainerLinkLease | null>;
}): Promise<CronOriginInjectResult> {
  const { deps, input } = options;
  if (!deps.admitUserTurn) return { kind: "no_transport" };
  let lease: ContainerLinkLease | null = null;
  let carrier: { agentContainerId: number; runtimeKind: string } | undefined;
  let getExecutors = options.getExecutors;
  try {
    if (options.linksEnabled) {
      const result = await deps.pgPool!.query<{ id: string; runtime_kind: string }>(
        `SELECT id,runtime_kind FROM agent_containers WHERE user_id=$1 AND state='active' AND runtime_channel=$2
           ORDER BY (runtime_kind='desktop') DESC,id DESC LIMIT 1`,
        [String(input.uid), deps.containerLinkRecovery?.channel ?? "v5"],
      );
      const row = result.rows[0];
      if (!row || !options.acquire) return { kind: "no_transport" };
      carrier = { agentContainerId: Number(row.id), runtimeKind: row.runtime_kind };
      lease = await options.acquire({ uid: String(input.uid), containerId: Number(row.id) });
      if (!lease) return { kind: "no_transport" };
      await waitForOriginExecutor(lease.socket, deps.containerConnectTimeoutMs ?? 5000);
      const handle = getContainerLinkHandle(lease.socket)!;
      getExecutors = () => handle.link.executors.canInject ? [handle.link.executors.origin] : [];
    } else if (getExecutors().length === 0) return { kind: "no_transport" };
    return await executeCronOriginInject({ input, pgPool: deps.pgPool, modelSwitchCost: deps.modelSwitchCost,
      admitUserTurn: deps.admitUserTurn, getExecutors, log: deps.logger, carrier });
  } catch (error) {
    deps.logger?.warn("container-link: origin transport unavailable", { uid: String(input.uid), error });
    return { kind: "no_transport" };
  } finally { lease?.release(); }
}

export type CronOriginExecutorClaimResult =
  | { kind: "claimed" }
  | { kind: "not_claimed" }
  | { kind: "rejected" }
  | { kind: "delivery_unknown" }

export type CronOriginExecutor = (payload: {
  encoded: Buffer
  admitted: {
    clientMessageId: string
    sessionId: string
    agentId: string
    dispatchId: string
    billingRequestId: string
    attemptNo: number
    leaseEpoch: number
    /** Exact DB lease owner; cron-origin is not the bridge connId. */
    leaseOwnerId: string
    anchorSeq: bigint | null
    requestHash: string
  }
}) => CronOriginExecutorClaimResult | Promise<CronOriginExecutorClaimResult>

export type CronOriginInjectInput = {
  uid: bigint
  sessionId: string
  text: string
  clientMessageId: string
  agentId: string
}

export type CronOriginInjectResult =
  | { kind: "injected" }
  | { kind: "gone" }
  | { kind: "in_flight" }
  | { kind: "no_transport" }
  | { kind: "failed"; reason: string }

/** Origin-session cron must reuse the conversation's current model, not the
 *  process default (glm). An empty/missing model keeps the historical
 *  `admitUserTurn({ model: null })` path. */
export function resolveCronOriginAdmitModel(
  sessionModelId: string | null | undefined,
): string | null {
  if (typeof sessionModelId !== "string") return null;
  const trimmed = sessionModelId.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Cron-origin inject only needs the origin session's `model_id`. Do NOT go
 * through `getClientSession` here: that hydrates every turn tape of the
 * session (hundreds of MB for long-lived parents), routinely trips the 30s
 * `statement_timeout`, and keeps the container's 15s POST waiting past its
 * deadline — the container then retries the same id every minute and the
 * repeated hydrations saturate the master. One indexed row read is enough.
 */
export async function lookupCronOriginSessionModel(
  pool: Pick<Pool, "query">,
  sessionId: string,
  sessionUserId: string,
): Promise<string | null> {
  return readClientSessionModelId(pool, sessionId, sessionUserId);
}

/** Shared origin-session inject path used by the bridge and unit tests. */
export async function executeCronOriginInject(opts: {
  input: CronOriginInjectInput
  carrier?: { agentContainerId: number; runtimeKind: string }
  pgPool?: UserChatBridgeDeps["pgPool"]
  modelSwitchCost?: ModelSwitchCostService;
  lookupSessionModel?: (
    sessionId: string,
    sessionUserId: string,
  ) => Promise<string | null | undefined>
  admitUserTurn: NonNullable<UserChatBridgeDeps["admitUserTurn"]>
  /** Resolve transport candidates only after durable admission. A bridge that
   * disappeared during the admission await must never be called as a stale
   * closure. `executor` remains as a focused-test convenience. */
  getExecutors?: () => Iterable<CronOriginExecutor>
  executor?: CronOriginExecutor
  log?: Logger
}): Promise<CronOriginInjectResult> {
  const { input, pgPool, lookupSessionModel, admitUserTurn, getExecutors, executor, log, modelSwitchCost } = opts;
  if (!isClientMessageId(input.clientMessageId) || input.sessionId.trim() === "" || input.text.trim() === "") {
    return { kind: "failed", reason: "invalid_payload" };
  }
  const content = { text: input.text };
  const requestHash = computeDispatchRequestHash(content);
  const sessionUserId = `c:${input.uid.toString()}`;
  let originModel: string | null = null;
  try {
    let raw: string | null | undefined;
    if (lookupSessionModel) {
      raw = await lookupSessionModel(input.sessionId, sessionUserId);
    } else if (pgPool) {
      // Single-row model read; never the tape-hydrating getClientSession.
      raw = await lookupCronOriginSessionModel(pgPool, input.sessionId, sessionUserId);
    }
    originModel = resolveCronOriginAdmitModel(raw);
  } catch (err) {
    log?.warn("user-chat-bridge: cron origin session model lookup failed", {
      uid: input.uid.toString(),
      sessionId: input.sessionId,
      err,
    });
  }
  if(modelSwitchCost && originModel){
    try {await modelSwitchCost.assertAuthorized(input.uid.toString(),{sessionId:input.sessionId,requestId:input.clientMessageId,
      targetModel:originModel,agentId:input.agentId||'main',text:input.text});}
    catch(error){return {kind:'failed',reason:error instanceof ModelSwitchCostError?error.code:'MODEL_SWITCH_UNAVAILABLE'};}
  }
  const message = {
    id: input.clientMessageId,
    role: "user" as const,
    text: input.text,
    ts: Date.now(),
    _routing: {
      teamMode: false,
      effortLevel: null as string | null,
      ...(originModel ? { model: originModel } : {}),
    },
  };
  let admit: Awaited<ReturnType<typeof admitUserTurn>>;
  try {
    admit = await admitUserTurn({
      uid: input.uid,
      sessionUserId,
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      agentId: input.agentId || "main",
      model: originModel,
      requestHash,
      billingRequestId: ensureRequestIdServerSide(),
      dispatchId: randomUUID(),
      ownerId: `cron-origin:${input.clientMessageId}`,
      exclusiveSession: true,
      ...opts.carrier,
      message,
    });
  } catch (err) {
    log?.warn("user-chat-bridge: cron origin admit threw", {
      uid: input.uid.toString(),
      sessionId: input.sessionId,
      err,
    });
    return { kind: "failed", reason: "admit_threw" };
  }
  if (admit.kind === "session_not_found" || admit.kind === "session_deleted") {
    return { kind: "gone" };
  }
  if (admit.kind === "session_busy") return { kind: "in_flight" };
  if (
    admit.kind === "append_error" ||
    admit.kind === "recovery_conflict" ||
    admit.kind === "previously_failed" ||
    admit.kind === "manual_hold" ||
    admit.kind === "immutable_conflict"
  ) {
    return { kind: "failed", reason: admit.kind };
  }
  if (admit.kind === "deduplicated") return { kind: "injected" };
  if (admit.kind === "already_owned") return { kind: "in_flight" };
  if (admit.kind === "in_flight") {
    // accepted is the durable container receipt. rejecting is not success and
    // must stay retryable; never ACK from the Master admission lease alone.
    return admit.dispatch.status === "accepted"
      ? { kind: "injected" }
      : { kind: "in_flight" };
  }
  const d = admit.dispatch;
  if (typeof d.ownerId !== "string" || d.ownerId.length === 0) {
    log?.error("user-chat-bridge: cron origin admitted row missing lease owner", {
      dispatchId: d.dispatchId,
    });
    if (pgPool) {
      await casToTerminal(pgPool, {
        dispatchId: d.dispatchId,
        outcome: "executed_error",
        failureCode: "dispatch_lease_owner_missing",
        clientNotified: false,
        fromStatuses: ["admitted"],
        expectedEpoch: d.leaseEpoch,
      });
    }
    return { kind: "failed", reason: "dispatch_lease_owner_missing" };
  }
  const frame = {
    type: "inbound.message",
    channel: "webchat",
    peer: { kind: "dm", id: input.sessionId },
    agentId: input.agentId || "main",
    clientMessageId: input.clientMessageId,
    idempotencyKey: `cron-origin:${input.clientMessageId}`,
    content,
    ts: message.ts,
    ...(originModel ? { model: originModel } : {}),
  };
  const payload = {
    encoded: Buffer.from(JSON.stringify(frame), "utf8"),
    admitted: {
      clientMessageId: d.clientMessageId,
      sessionId: d.sessionId,
      agentId: d.agentId,
      dispatchId: d.dispatchId,
      billingRequestId: d.billingRequestId,
      attemptNo: d.attemptNo,
      leaseEpoch: d.leaseEpoch,
      leaseOwnerId: d.ownerId,
      anchorSeq: d.anchorSeq,
      requestHash: d.requestHash,
    },
  };
  const candidates = getExecutors
    ? [...getExecutors()]
    : executor
      ? [executor]
      : [];
  if (candidates.length === 0) return { kind: "no_transport" };
  for (const candidate of candidates) {
    let claim: CronOriginExecutorClaimResult;
    try {
      claim = await candidate(payload);
    } catch (err) {
      log?.warn("user-chat-bridge: cron executor delivery became unknown", {
        dispatchId: d.dispatchId,
        err,
      });
      return { kind: "failed", reason: "delivery_unknown" };
    }
    if (claim.kind === "claimed") {
      const kind = input.clientMessageId.startsWith("dlgcb-")
        ? "dlgcb"
        : input.clientMessageId.startsWith("lsc-") ? "lsc" : "cron";
      containerLinkOriginInjected.inc({ kind });
      return { kind: "injected" };
    }
    if (claim.kind === "rejected") {
      return { kind: "failed", reason: "dispatch_rejected" };
    }
    if (claim.kind === "delivery_unknown") {
      return { kind: "failed", reason: "delivery_unknown" };
    }
    // Only a synchronous, explicit not_claimed result may select another
    // bridge. claimed/delivery_unknown can already have bytes in flight.
  }
  return { kind: "no_transport" };
}

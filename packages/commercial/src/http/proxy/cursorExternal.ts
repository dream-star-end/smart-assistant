/**
 * External API-key proxy → Cursor Sand (`cursor-*` models) on the master.
 *
 * Why this exists: `makeAnthropicProxyHandler` only knows `oauth` (Anthropic
 * account pool) and `static` (key providers) upstreams. Cursor models are an
 * *engine* — inside a user container the CCB subprocess talks to a local
 * `CursorSandRelay` that translates Anthropic Messages ⇄ Cursor Sand connect
 * frames. A local Claude Code connecting through `/api/anthropic/v1/messages`
 * with an `oc-cc.*` key has no container, so the master has to run that relay
 * itself: pick an eligible `claude_accounts(provider='cursor')` row, decrypt
 * its credential, serve the request through `CursorSandRelay.serveMessages`
 * and settle credits from the returned usage via `settleCursorExternalUsage`
 * (the same path the web engine's usage frames take).
 *
 * Handler contract: `handle()` is invoked by `http/proxy/index.ts` after the
 * shared identity / rate-limit / concurrency / body steps, only when
 * `deps.cursorExternal` is injected (external API-key instance) and
 * `isCursorEngineModel(body.model)`. It owns the response from that point on
 * (every early exit writes a JSON error; the relay writes SSE / JSON itself).
 *
 * Deliberately NOT done here (operator decisions 2026-09-06):
 *   - no `OC_V5_CURSOR_CREDENTIAL_UIDS` check — API-key access is governed by
 *     model authorization only (role / grants / min_plan / visibility);
 *   - no pre-reservation (preCheck/journal): balance <= 0 → 402, otherwise
 *     settle clamps like the web engine does;
 *   - no server-side session refresh: expired session rows are skipped.
 *
 * Credential hygiene: decrypted token buffers are copied into a per-account
 * relay cache (keyed by sha256 fingerprint so a re-login rebuilds the relay)
 * and zeroed on `close()`. The relay zeroes whatever `readApiKey()` hands it
 * after each use, so `readApiKey` must return a fresh copy every call.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  CursorSandRelay,
  type CursorSandServeResult,
  type RelayCredentialKind,
} from "@openclaude/gateway";
import type { Logger } from "../../logging/logger.js";
import type { ProxyIdentity } from "../../auth/proxyIdentity.js";
import { AuthzDeniedError, AuthzLoadError } from "../../auth/proxyIdentity.js";
import type { ModelPricing, PricingCache } from "../../billing/pricing.js";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import { settleCursorExternalUsage } from "../../billing/cursorExternalSettle.js";
import type { SettleResult } from "../../billing/proxyBilling.js";
import {
  getCursorTokenSnapshot,
  listAccounts,
  type AccountRow,
  type CursorTokenSnapshot,
} from "../../account-pool/store.js";
import { computeCursorSlotWeight, cursorModelFamily } from "../../account-pool/cursorQuota.js";
import { incrAnthropicProxyReject, incrAnthropicProxySettle } from "../../admin/metrics.js";
import { trackModelRequestStart, trackModelRequestEnd } from "./inflightTracker.js";
import {
  errSummary,
  extractUsageAttribution,
  sendJsonError,
  type ProxyBody,
} from "./shared.js";

// ─── public types ──────────────────────────────────────────────────────────

/** Minimal relay surface used here; lets tests inject a fake without Sand. */
export interface CursorSandRelayLike {
  serveMessages(
    body: Record<string, unknown>,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<CursorSandServeResult>;
  close(): Promise<void>;
}

export interface CursorExternalRelayFactoryArgs {
  credentialKind: RelayCredentialKind;
  machineId: string | null;
  readApiKey: () => Buffer;
  fetchImpl?: typeof fetch;
}

export interface CursorExternalDeps {
  pgPool: Pool;
  pricing: PricingCache;
  logger?: Logger;
  now?: () => number;
  /** Optional outbound fetch override (defaults to the process-global fetch,
   * which on the master already goes through the global EnvHttpProxyAgent). */
  fetchImpl?: typeof fetch;
  // ── test seams (defaults are the production store / billing helpers) ──
  listCursorAccounts?: () => Promise<AccountRow[]>;
  loadSnapshot?: (id: bigint) => Promise<CursorTokenSnapshot | null>;
  readBalance?: (uid: bigint) => Promise<bigint>;
  settle?: typeof settleCursorExternalUsage;
  relayFactory?: (args: CursorExternalRelayFactoryArgs) => CursorSandRelayLike;
  /** Per-uid account stickiness window (default 15 min, mirrors oc-cursor.sh). */
  stickyTtlMs?: number;
  /** In-process cooldown after a credential rejection (default 10 min). */
  credentialCooldownMs?: number;
}

export interface CursorExternalHandleArgs {
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
  uid: bigint;
  identity: ProxyIdentity;
  body: ProxyBody;
  /** `deps.identity.authorize(identity, pricing, model)` bound by the handler. */
  authorize: (pricing: ModelPricing) => Promise<void>;
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>;
  broadcastToUser?: (uid: bigint, payload: unknown) => void;
  userLog: Logger;
}

export interface CursorExternalRoute {
  handle(args: CursorExternalHandleArgs): Promise<void>;
  close(): Promise<void>;
  /** Test/inspection hook: account ids currently in credential cooldown. */
  _cooledAccountIds(): bigint[];
}

// ─── constants ─────────────────────────────────────────────────────────────

export const CURSOR_EXTERNAL_STICKY_TTL_MS = 15 * 60_000;
export const CURSOR_EXTERNAL_CREDENTIAL_COOLDOWN_MS = 10 * 60_000;
/** Session tokens expiring within this window are treated as unusable. */
export const CURSOR_EXTERNAL_SESSION_MIN_REMAINING_MS = 60_000;

// ─── implementation ────────────────────────────────────────────────────────

interface CachedRelay {
  relay: CursorSandRelayLike;
  fingerprint: string;
  token: Buffer;
}

interface StickyPick {
  accountId: bigint;
  expiresAt: number;
}

function tokenFingerprint(token: Buffer, machineId: string | null, kind: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\u0000")
    .update(machineId ?? "")
    .update("\u0000")
    .update(token)
    .digest("hex");
}

/** Pure selection helper, exported for unit tests. */
export function selectCursorAccount(args: {
  accounts: AccountRow[];
  model: string;
  now: Date;
  cooled: ReadonlySet<string>;
  sticky: bigint | null;
  random?: () => number;
}): AccountRow | null {
  const nowMs = args.now.getTime();
  let eligible = args.accounts.filter((row) => {
    if (row.provider !== "cursor") return false;
    if (row.status !== "active") return false;
    if (!row.cursor_sand_enabled) return false;
    if (row.cooldown_until && row.cooldown_until.getTime() > nowMs) return false;
    if (args.cooled.has(row.id.toString())) return false;
    if (row.cursor_credential_kind === "session") {
      // No server-side refresh: a session token that is (about to be) expired
      // would only produce a 401 → cooldown loop. Skip it up front.
      if (!row.oauth_expires_at) return false;
      if (row.oauth_expires_at.getTime() <= nowMs + CURSOR_EXTERNAL_SESSION_MIN_REMAINING_MS) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  if (cursorModelFamily(args.model) === "other_models") {
    // `other_models` = Claude / Gemini families; slots learned as `cursor_only`
    // (quota left only for Cursor's own grok/composer models) cannot serve
    // them. Fall back to the whole set if that filter empties (class may be stale).
    const narrowed = eligible.filter((row) => row.cursor_quota_class !== "cursor_only");
    if (narrowed.length > 0) eligible = narrowed;
  }
  if (args.sticky !== null) {
    const hit = eligible.find((row) => row.id === args.sticky);
    if (hit) return hit;
  }
  const weights = eligible.map((row) =>
    computeCursorSlotWeight(
      {
        sandUsagePct: row.cursor_sand_usage_pct,
        sandNextResetAt: row.cursor_sand_next_reset_at,
        billingCycleEnd: row.cursor_billing_cycle_end,
        sandAccessState: row.cursor_sand_access_state,
      },
      args.now,
    ),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = (args.random ?? Math.random)() * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return eligible[i]!;
  }
  return eligible[eligible.length - 1]!;
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || /abort/i.test(err.message);
}

export function makeCursorExternalRoute(deps: CursorExternalDeps): CursorExternalRoute {
  const log = deps.logger;
  const now = deps.now ?? (() => Date.now());
  const stickyTtl = deps.stickyTtlMs ?? CURSOR_EXTERNAL_STICKY_TTL_MS;
  const cooldownMs = deps.credentialCooldownMs ?? CURSOR_EXTERNAL_CREDENTIAL_COOLDOWN_MS;
  const listCursorAccounts =
    deps.listCursorAccounts
    ?? (() => listAccounts({ provider: "cursor", status: "active", limit: 500 }));
  const loadSnapshot = deps.loadSnapshot ?? ((id: bigint) => getCursorTokenSnapshot(id));
  const readBalance = deps.readBalance ?? ((uid: bigint) => readTotalSpendableBalance(uid));
  const settle = deps.settle ?? settleCursorExternalUsage;
  const relayFactory =
    deps.relayFactory
    ?? ((args: CursorExternalRelayFactoryArgs): CursorSandRelayLike =>
      new CursorSandRelay({
        credentialKind: args.credentialKind,
        machineId: args.machineId,
        readApiKey: args.readApiKey,
        fetchImpl: args.fetchImpl,
        // The master has no internal loopback proxy to hand non-Sand models to;
        // serveMessages already 400s NOT_SAND_ROUTE before reaching passthrough.
        passthrough: null,
      }));

  const relays = new Map<string, CachedRelay>();
  const sticky = new Map<string, StickyPick>();
  const cooled = new Map<string, number>();
  let closed = false;

  function pruneCooldowns(nowMs: number): Set<string> {
    const active = new Set<string>();
    for (const [id, until] of cooled) {
      if (until <= nowMs) cooled.delete(id);
      else active.add(id);
    }
    return active;
  }

  function stickyFor(uid: bigint, nowMs: number): bigint | null {
    const hit = sticky.get(uid.toString());
    if (!hit) return null;
    if (hit.expiresAt <= nowMs) {
      sticky.delete(uid.toString());
      return null;
    }
    return hit.accountId;
  }

  async function relayFor(account: AccountRow): Promise<CursorSandRelayLike | null> {
    const snapshot = await loadSnapshot(account.id);
    if (!snapshot) return null;
    try {
      if (snapshot.credential_kind === "session" && !snapshot.machine_id) {
        log?.warn("cursor_external_session_machine_id_missing", { accountId: account.id.toString() });
        return null;
      }
      const fingerprint = tokenFingerprint(snapshot.token, snapshot.machine_id, snapshot.credential_kind);
      const key = account.id.toString();
      const cached = relays.get(key);
      if (cached && cached.fingerprint === fingerprint) return cached.relay;
      if (cached) {
        relays.delete(key);
        cached.token.fill(0);
        void cached.relay.close().catch(() => undefined);
      }
      const token = Buffer.from(snapshot.token);
      let relay: CursorSandRelayLike;
      try {
        relay = relayFactory({
          credentialKind: snapshot.credential_kind,
          machineId: snapshot.machine_id,
          readApiKey: () => Buffer.from(token),
          fetchImpl: deps.fetchImpl,
        });
      } catch (err) {
        token.fill(0);
        log?.warn("cursor_external_relay_build_failed", {
          accountId: key,
          credentialKind: snapshot.credential_kind,
          err: errSummary(err),
        });
        return null;
      }
      relays.set(key, { relay, fingerprint, token });
      return relay;
    } finally {
      snapshot.token.fill(0);
      snapshot.refresh?.fill(0);
    }
  }

  async function handle(args: CursorExternalHandleArgs): Promise<void> {
    const { req, res, requestId, uid, body, userLog } = args;
    const model = body.model;
    const nowMs = now();

    // 1) pricing — unknown / disabled cursor model
    const pricing = deps.pricing.get(model);
    if (!pricing || !pricing.enabled) {
      userLog.warn("proxy_unknown_model", { model, cursorExternal: true });
      incrAnthropicProxyReject("unknown_model");
      sendJsonError(res, 400, "UNKNOWN_MODEL", `model '${model}' not enabled`, requestId);
      return;
    }

    // 2) authorization (role / grants / min_plan / visibility) — same strategy as
    //    the regular path; API-key access is governed by this alone.
    try {
      await args.authorize(pricing);
    } catch (err) {
      if (err instanceof AuthzLoadError) {
        userLog.error("proxy_authz_load_failed", { err: errSummary(err.cause), cursorExternal: true });
        sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
        return;
      }
      if (err instanceof AuthzDeniedError) {
        userLog.warn("proxy_unauthorized_model", { model: err.modelId, role: err.role, cursorExternal: true });
        incrAnthropicProxyReject("unauthorized_model");
        sendJsonError(res, 403, "NOT_AUTHORIZED", "model not authorized", requestId);
        return;
      }
      throw err;
    }

    // 3) balance pre-check — no reservation, just refuse an empty wallet.
    const balance = await readBalance(uid);
    if (balance <= 0n) {
      userLog.warn("proxy_insufficient_credits", { balance: balance.toString(), cursorExternal: true });
      incrAnthropicProxyReject("insufficient");
      sendJsonError(
        res,
        402,
        "INSUFFICIENT_CREDITS",
        `insufficient credits: balance=${balance.toString()} required=1`,
        requestId,
      );
      return;
    }

    // 4) pick an eligible cursor pool row (+ build/reuse its relay). A row whose
    //    credential cannot be materialised is dropped and we try the next one.
    const nowDate = new Date(nowMs);
    const cooledNow = pruneCooldowns(nowMs);
    const accounts = await listCursorAccounts();
    const excluded = new Set<string>(cooledNow);
    let account: AccountRow | null = null;
    let relay: CursorSandRelayLike | null = null;
    for (;;) {
      account = selectCursorAccount({
        accounts,
        model,
        now: nowDate,
        cooled: excluded,
        sticky: stickyFor(uid, nowMs),
      });
      if (!account) break;
      try {
        relay = await relayFor(account);
      } catch (err) {
        userLog.warn("cursor_external_snapshot_failed", { accountId: account.id.toString(), err: errSummary(err) });
        relay = null;
      }
      if (relay) break;
      excluded.add(account.id.toString());
    }
    if (!account || !relay) {
      userLog.warn("cursor_external_pool_unavailable", {
        model,
        candidates: accounts.length,
        excluded: excluded.size,
      });
      incrAnthropicProxyReject("account_pool");
      sendJsonError(
        res,
        503,
        "CURSOR_POOL_UNAVAILABLE",
        "no cursor account available for this model, retry later",
        requestId,
        { "retry-after": "30" },
      );
      return;
    }
    const accountId = account.id;
    sticky.set(uid.toString(), { accountId, expiresAt: nowMs + stickyTtl });

    // 5) run the relay. Anthropic semantics: missing `stream` = non-streaming.
    trackModelRequestStart(model);
    res.once("close", () => trackModelRequestEnd(model));
    const attribution = extractUsageAttribution(body.metadata);
    const relayBody: Record<string, unknown> = { ...body };
    if (body.stream !== true) relayBody.stream = false;

    // Client-disconnect detection: `res` emits 'close' both after a normal
    // `end()` and when the peer hangs up. Only the latter happens while the
    // response is still writable, so sample `writableEnded` at close time
    // instead of reading `signal.aborted` afterwards (core.ts has the same
    // caveat: our own end() would otherwise look like an abort).
    const ac = new AbortController();
    let clientAborted = false;
    const onClose = () => {
      if (!res.writableEnded) clientAborted = true;
      ac.abort();
    };
    res.on("close", onClose);

    let result: CursorSandServeResult | null = null;
    let failure: unknown = null;
    const startedAt = nowMs;
    try {
      result = await relay.serveMessages(relayBody, res, ac.signal);
    } catch (err) {
      failure = err;
    } finally {
      res.off("close", onClose);
    }

    // 6) classify → settle
    type Outcome = {
      engineStatus: "success" | "error";
      terminalCode: string | null;
      usage: unknown;
      settleKind: "final" | "partial" | "aborted";
    };
    let outcome: Outcome;
    if (result && result.kind === "completed") {
      outcome = { engineStatus: "success", terminalCode: null, usage: result.usage, settleKind: "final" };
    } else if (result && result.kind === "failed") {
      // Mid-stream failure: the relay already emitted an SSE `error` event.
      // A client that hung up mid-stream is still charged for what reached it
      // (same USER_CANCELLED semantics as the web engine's Stop button); a
      // genuine upstream fault leaves an audit row with no debit.
      outcome = {
        engineStatus: "error",
        terminalCode: clientAborted ? "USER_CANCELLED" : "CURSOR_STREAM_FAILED",
        usage: result.usage,
        settleKind: clientAborted ? "aborted" : "partial",
      };
      userLog.warn("cursor_external_stream_failed", {
        model,
        accountId: accountId.toString(),
        reason: result.reason,
        clientAborted,
      });
    } else if (result && result.kind === "rejected") {
      if (result.status === 401) {
        cooled.set(accountId.toString(), nowMs + cooldownMs);
        sticky.delete(uid.toString());
        userLog.warn("cursor_external_credential_rejected", {
          model,
          accountId: accountId.toString(),
          reason: result.reason,
          cooldownMs,
        });
        incrAnthropicProxyReject("upstream_auth");
      } else {
        userLog.warn("cursor_external_upstream_rejected", {
          model,
          accountId: accountId.toString(),
          status: result.status,
          reason: result.reason,
        });
      }
      if (!result.written && !res.headersSent) {
        sendJsonError(res, result.status, "CURSOR_UPSTREAM_REJECTED", result.reason, requestId);
      }
      outcome = { engineStatus: "error", terminalCode: result.reason, usage: {}, settleKind: "aborted" };
    } else {
      if (clientAborted || (isAbortLike(failure) && ac.signal.aborted)) {
        userLog.info("cursor_external_client_aborted", { model, accountId: accountId.toString() });
        outcome = { engineStatus: "error", terminalCode: "USER_CANCELLED", usage: {}, settleKind: "aborted" };
      } else {
        userLog.error("cursor_external_relay_failed", {
          model,
          accountId: accountId.toString(),
          err: errSummary(failure),
        });
        if (!res.headersSent) {
          sendJsonError(res, 502, "CURSOR_UPSTREAM_FAILED", "cursor upstream failed", requestId);
        } else if (!res.writableEnded) {
          res.end();
        }
        outcome = { engineStatus: "error", terminalCode: "CURSOR_RELAY_FAILED", usage: {}, settleKind: "aborted" };
      }
    }
    if (!res.writableEnded) res.end();

    let settled: SettleResult | null = null;
    try {
      settled = await settle({
        pool: deps.pgPool,
        pricing: deps.pricing,
        userId: uid,
        requestId,
        modelId: model,
        sessionId: attribution.sessionId,
        engineStatus: outcome.engineStatus,
        terminalCode: outcome.terminalCode,
        usage: outcome.usage,
        accountId,
        turnKey: attribution.turnKey,
        parentTurnKey: attribution.parentTurnKey,
        parentSessionId: attribution.parentSessionId,
        delegateAgentId: attribution.delegateAgentId,
      });
    } catch (err) {
      userLog.error("cursor_external_settle_failed", { model, accountId: accountId.toString(), err: errSummary(err) });
    }
    incrAnthropicProxySettle(outcome.settleKind);

    // 7) post-commit — same order as core.ts: persist first, broadcast second;
    //    both fail-soft.
    if (settled) {
      const persisted =
        settled.attributionCredits !== null
          ? settled.attributionCredits
          : settled.debitedCredits !== null && settled.debitedCredits > 0n
            ? settled.debitedCredits
            : null;
      if (persisted !== null && args.appendCostCredits) {
        try {
          await args.appendCostCredits(
            requestId,
            uid.toString(),
            persisted.toString(),
            attribution.sessionId,
            attribution.parentSessionId,
            attribution.delegateAgentId,
            attribution.turnKey,
            attribution.parentTurnKey,
          );
        } catch (err) {
          userLog.warn("proxy_persist_costcredits_failed", { err: errSummary(err), requestId });
        }
      }
      if (settled.debitedCredits !== null && settled.debitedCredits > 0n && args.broadcastToUser) {
        try {
          args.broadcastToUser(uid, {
            type: "outbound.cost_charged",
            requestId,
            costCredits: settled.debitedCredits.toString(),
            balanceAfter: settled.balanceAfter === null ? null : settled.balanceAfter.toString(),
            sessionId: attribution.sessionId,
            parentSessionId: attribution.parentSessionId,
          });
        } catch (err) {
          userLog.warn("proxy_broadcast_cost_failed", { err: errSummary(err) });
        }
      }
    }
    userLog.info("cursor_external_settled", {
      model,
      accountId: accountId.toString(),
      engineStatus: outcome.engineStatus,
      terminalCode: outcome.terminalCode,
      usage: outcome.usage,
      debitedCredits: settled?.debitedCredits?.toString() ?? null,
      clamped: settled?.clamped ?? null,
      durationMs: now() - startedAt,
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const entries = [...relays.values()];
    relays.clear();
    sticky.clear();
    cooled.clear();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.relay.close();
        } finally {
          entry.token.fill(0);
        }
      }),
    );
  }

  return {
    handle,
    close,
    _cooledAccountIds: () => [...cooled.keys()].map((id) => BigInt(id)),
  };
}

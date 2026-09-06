/**
 * External API-key → cursor-* via master-side Sand relay (http/proxy/cursorExternal.ts).
 *
 * Pure unit tests: store / billing / relay are all injected fakes. Locks the
 * reject ladder (400/403/402/503), account eligibility rules, settle inputs,
 * post-commit ordering (persist before broadcast) and credential cooldown.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { CursorSandServeResult } from "@openclaude/gateway";
import { AuthzDeniedError, AuthzLoadError, type ProxyIdentity } from "../auth/proxyIdentity.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import type { SettleResult } from "../billing/proxyBilling.js";
import type { AccountRow, CursorTokenSnapshot } from "../account-pool/store.js";
import type { IdentityStrategy } from "../auth/proxyIdentity.js";
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyDeps,
  type ProxyBody,
} from "../http/anthropicProxy.js";
import {
  makeCursorExternalRoute,
  selectCursorAccount,
  type CursorExternalDeps,
  type CursorExternalRelayFactoryArgs,
  type CursorSandRelayLike,
} from "../http/proxy/cursorExternal.js";
import { createLogger } from "../logging/logger.js";

const MODEL = "cursor-fable-5.1-high";
const OTHER_MODEL = "cursor-gemini-3.8-flash-low";
const NOW = Date.parse("2026-09-06T12:00:00Z");
const quiet = createLogger({ level: "error", out: () => undefined });

class MockReq extends Readable {
  method = "POST";
  url = "/v1/messages";
  headers: Record<string, string>;
  constructor(body?: unknown, headers: Record<string, string> = {}) {
    super();
    this.headers = { "content-type": "application/json", ...headers };
    if (body !== undefined) this.push(JSON.stringify(body));
    this.push(null);
  }
}

class MockRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
  }
  write(chunk: string) { this.headersSent = true; this.body += chunk; return true; }
  end(chunk?: string) {
    this.headersSent = true;
    this.body += chunk ?? "";
    this.writableEnded = true;
    this.emit("close");
  }
  json(): { error?: { code?: string; message?: string } } { return JSON.parse(this.body); }
}

function pricingRow(model: string, enabled = true): ModelPricing {
  return {
    model_id: model,
    display_name: model,
    input_per_mtok: 1500n,
    output_per_mtok: 7500n,
    cache_read_per_mtok: 150n,
    cache_write_per_mtok: 1875n,
    multiplier: "1.000",
    enabled,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    min_plan_code: null,
  } as unknown as ModelPricing;
}

function account(over: Partial<AccountRow> & { id: bigint }): AccountRow {
  return {
    provider: "cursor",
    status: "active",
    health_score: 100,
    cooldown_until: null,
    oauth_expires_at: new Date(NOW + 30 * 86_400_000),
    cursor_quota_class: "other_ok",
    cursor_sand_enabled: true,
    cursor_credential_kind: "api_key",
    cursor_sand_usage_pct: 10,
    cursor_sand_next_reset_at: null,
    cursor_sand_access_state: null,
    cursor_billing_cycle_end: null,
    ...over,
  } as unknown as AccountRow;
}

function snapshot(id: bigint, over: Partial<CursorTokenSnapshot> = {}): CursorTokenSnapshot {
  return {
    id,
    token: Buffer.from(`crsr_token_${id.toString()}`),
    credential_kind: "api_key",
    machine_id: null,
    refresh: null,
    expires_at: null,
    ...over,
  } as CursorTokenSnapshot;
}

interface Harness {
  deps: CursorExternalDeps;
  settleCalls: Parameters<NonNullable<CursorExternalDeps["settle"]>>[0][];
  relayCalls: { accountToken: string; body: Record<string, unknown> }[];
  factoryCalls: CursorExternalRelayFactoryArgs[];
  order: string[];
}

function harness(opts: {
  pricing?: ModelPricing | null;
  balance?: bigint;
  accounts?: AccountRow[];
  snapshots?: Map<string, CursorTokenSnapshot | null>;
  relay?: (body: Record<string, unknown>, res: ServerResponse, signal: AbortSignal) => Promise<CursorSandServeResult>;
  settleResult?: SettleResult | null;
  settleThrows?: boolean;
} = {}): Harness {
  const settleCalls: Harness["settleCalls"] = [];
  const relayCalls: Harness["relayCalls"] = [];
  const factoryCalls: CursorExternalRelayFactoryArgs[] = [];
  const order: string[] = [];
  const accounts = opts.accounts ?? [account({ id: 17n })];
  const snapshots = opts.snapshots ?? new Map(accounts.map((a) => [a.id.toString(), snapshot(a.id)]));
  const deps: CursorExternalDeps = {
    pgPool: {} as Pool,
    pricing: {
      get: (m: string) => (opts.pricing === undefined ? (m === MODEL || m === OTHER_MODEL ? pricingRow(m) : null) : opts.pricing),
    } as unknown as PricingCache,
    logger: quiet,
    now: () => NOW,
    listCursorAccounts: async () => accounts,
    loadSnapshot: async (id) => {
      const snap = snapshots.get(id.toString());
      if (!snap) return null;
      // Store contract: caller zeroes; hand out a fresh copy each time so the
      // Map stays reusable across calls.
      return { ...snap, token: Buffer.from(snap.token), refresh: snap.refresh ? Buffer.from(snap.refresh) : null };
    },
    readBalance: async () => opts.balance ?? 1000n,
    settle: async (args) => {
      settleCalls.push(args);
      order.push("settle");
      if (opts.settleThrows) throw new Error("db down");
      return opts.settleResult === undefined
        ? { usageId: 1n, ledgerId: 2n, clamped: false, debitedCredits: 42n, attributionCredits: 42n, balanceAfter: 958n }
        : opts.settleResult;
    },
    relayFactory: (args) => {
      factoryCalls.push(args);
      const relay: CursorSandRelayLike = {
        async serveMessages(body, res, signal) {
          const key = args.readApiKey();
          relayCalls.push({ accountToken: key.toString(), body });
          key.fill(0);
          if (opts.relay) return opts.relay(body, res, signal);
          res.setHeader("content-type", "text/event-stream");
          res.write("event: message_start\n\n");
          res.end("event: message_stop\n\n");
          return {
            kind: "completed",
            upstreamModel: String(body.model),
            usage: { input_tokens: 100, output_tokens: 9, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
          };
        },
        async close() {},
      };
      return relay;
    },
  };
  return { deps, settleCalls, relayCalls, factoryCalls, order };
}

function body(over: Partial<ProxyBody> & Record<string, unknown> = {}): ProxyBody {
  return {
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...over,
  } as unknown as ProxyBody;
}

async function run(h: Harness, over: {
  body?: ProxyBody;
  authorize?: (p: ModelPricing) => Promise<void>;
  appendCostCredits?: (...a: unknown[]) => Promise<unknown>;
  broadcastToUser?: (uid: bigint, payload: unknown) => void;
  req?: MockReq;
  res?: MockRes;
} = {}) {
  const route = makeCursorExternalRoute(h.deps);
  const req = over.req ?? new MockReq();
  const res = over.res ?? new MockRes();
  await route.handle({
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestId: "req-1",
    uid: 3n,
    identity: { uid: 3n, containerId: null } as ProxyIdentity,
    body: over.body ?? body(),
    authorize: over.authorize ?? (async () => {}),
    appendCostCredits: over.appendCostCredits,
    broadcastToUser: over.broadcastToUser,
    userLog: quiet,
  });
  return { route, req, res };
}

describe("cursorExternal route — reject ladder", () => {
  test("unknown / disabled cursor model → 400 UNKNOWN_MODEL, nothing settled", async () => {
    const h = harness({ pricing: null });
    const { res } = await run(h);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error?.code, "UNKNOWN_MODEL");
    const h2 = harness({ pricing: pricingRow(MODEL, false) });
    const r2 = await run(h2);
    assert.equal(r2.res.statusCode, 400);
    assert.equal(h.settleCalls.length + h2.settleCalls.length, 0);
    assert.equal(h.relayCalls.length + h2.relayCalls.length, 0);
  });

  test("authorize denied → 403 NOT_AUTHORIZED; authz load failure → 500", async () => {
    const h = harness();
    const denied = await run(h, { authorize: async () => { throw new AuthzDeniedError(MODEL, "user"); } });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.json().error?.code, "NOT_AUTHORIZED");
    const load = await run(h, { authorize: async () => { throw new AuthzLoadError(new Error("pg")); } });
    assert.equal(load.res.statusCode, 500);
    assert.equal(h.relayCalls.length, 0);
  });

  test("balance <= 0 → 402 INSUFFICIENT_CREDITS before touching the pool", async () => {
    const h = harness({ balance: 0n });
    const { res } = await run(h);
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().error?.code, "INSUFFICIENT_CREDITS");
    assert.match(res.json().error?.message ?? "", /balance=0/);
    assert.equal(h.factoryCalls.length, 0);
  });

  test("no eligible account → 503 CURSOR_POOL_UNAVAILABLE with retry-after", async () => {
    const h = harness({ accounts: [account({ id: 1n, cursor_sand_enabled: false })] });
    const { res } = await run(h);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error?.code, "CURSOR_POOL_UNAVAILABLE");
    assert.equal(res.headers["retry-after"], "30");
    assert.equal(h.settleCalls.length, 0);
  });

  test("account whose snapshot is missing is skipped and the next one is used", async () => {
    const snaps = new Map<string, CursorTokenSnapshot | null>([["1", null], ["2", snapshot(2n)]]);
    const h = harness({ accounts: [account({ id: 1n, cursor_sand_usage_pct: 0 }), account({ id: 2n })], snapshots: snaps });
    const { res } = await run(h);
    assert.equal(res.statusCode, 200);
    assert.equal(h.relayCalls.length, 1);
    assert.equal(h.relayCalls[0]!.accountToken, "crsr_token_2");
    assert.equal(h.settleCalls[0]!.accountId, 2n);
  });
});

describe("cursorExternal route — account eligibility (selectCursorAccount)", () => {
  const now = new Date(NOW);
  const base = { model: MODEL, now, cooled: new Set<string>(), sticky: null, random: () => 0 };

  test("filters provider/status/sand_enabled/cooldown_until", () => {
    const rows = [
      account({ id: 1n, provider: "claude" as AccountRow["provider"] }),
      account({ id: 2n, status: "disabled" as AccountRow["status"] }),
      account({ id: 3n, cursor_sand_enabled: false }),
      account({ id: 4n, cooldown_until: new Date(NOW + 60_000) }),
      account({ id: 5n, cooldown_until: new Date(NOW - 60_000) }),
    ];
    assert.equal(selectCursorAccount({ ...base, accounts: rows })?.id, 5n);
  });

  test("session rows expiring within 60s (or without expiry) are excluded; api_key rows ignore expiry", () => {
    const rows = [
      account({ id: 1n, cursor_credential_kind: "session", oauth_expires_at: new Date(NOW + 30_000) }),
      account({ id: 2n, cursor_credential_kind: "session", oauth_expires_at: null }),
      account({ id: 3n, cursor_credential_kind: "api_key", oauth_expires_at: new Date(NOW - 1) }),
    ];
    assert.equal(selectCursorAccount({ ...base, accounts: rows })?.id, 3n);
    const okSession = account({ id: 4n, cursor_credential_kind: "session", oauth_expires_at: new Date(NOW + 120_000) });
    assert.equal(selectCursorAccount({ ...base, accounts: [okSession] })?.id, 4n);
  });

  test("other_models family (claude/gemini) excludes cursor_only slots; cursor_models (grok) does not; empty → fallback", () => {
    const GROK = "cursor-grok-4.6-low";
    const rows = [account({ id: 1n, cursor_quota_class: "cursor_only" }), account({ id: 2n, cursor_quota_class: "other_ok" })];
    assert.equal(selectCursorAccount({ ...base, model: MODEL, accounts: rows })?.id, 2n);
    assert.equal(selectCursorAccount({ ...base, model: OTHER_MODEL, accounts: rows })?.id, 2n);
    assert.equal(selectCursorAccount({ ...base, model: GROK, accounts: rows })?.id, 1n);
    const onlyCursorOnly = [account({ id: 1n, cursor_quota_class: "cursor_only" })];
    assert.equal(selectCursorAccount({ ...base, model: MODEL, accounts: onlyCursorOnly })?.id, 1n);
  });

  test("in-process cooled set and sticky preference are honoured", () => {
    const rows = [account({ id: 1n }), account({ id: 2n }), account({ id: 3n })];
    assert.equal(selectCursorAccount({ ...base, accounts: rows, cooled: new Set(["1"]) })?.id, 2n);
    assert.equal(selectCursorAccount({ ...base, accounts: rows, sticky: 3n })?.id, 3n);
    // sticky pointing at an ineligible row falls back to weighted pick
    assert.equal(selectCursorAccount({ ...base, accounts: rows, sticky: 9n })?.id, 1n);
  });
});

describe("cursorExternal route — relay + settle + post-commit", () => {
  test("success: relay gets stream:false by default, settle receives usage/account, persist before broadcast", async () => {
    const h = harness();
    const append = async (...a: unknown[]) => { h.order.push("append"); return a; };
    const broadcasts: unknown[] = [];
    const { res } = await run(h, {
      body: body({ metadata: { user_id: "u", session_id: "web-abc" } }),
      appendCostCredits: append,
      broadcastToUser: (_uid, p) => { h.order.push("broadcast"); broadcasts.push(p); },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(h.relayCalls.length, 1);
    assert.equal(h.relayCalls[0]!.body.stream, false);
    assert.equal(h.relayCalls[0]!.accountToken, "crsr_token_17");
    assert.equal(h.factoryCalls[0]!.credentialKind, "api_key");
    assert.equal(h.settleCalls.length, 1);
    const s = h.settleCalls[0]!;
    assert.equal(s.engineStatus, "success");
    assert.equal(s.accountId, 17n);
    assert.equal(s.modelId, MODEL);
    assert.equal(s.userId, 3n);
    assert.equal(s.sessionId, "web-abc");
    assert.deepEqual(s.usage, { input_tokens: 100, output_tokens: 9, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 });
    assert.deepEqual(h.order, ["settle", "append", "broadcast"]);
    assert.deepEqual(broadcasts[0], {
      type: "outbound.cost_charged",
      requestId: "req-1",
      costCredits: "42",
      balanceAfter: "958",
      sessionId: "web-abc",
      parentSessionId: null,
    });
  });

  test("stream:true is passed through untouched", async () => {
    const h = harness();
    await run(h, { body: body({ stream: true }) });
    assert.equal(h.relayCalls[0]!.body.stream, true);
  });

  test("relay is cached per account and rebuilt when the credential fingerprint changes", async () => {
    const snaps = new Map<string, CursorTokenSnapshot | null>([["17", snapshot(17n)]]);
    const h = harness({ snapshots: snaps });
    const route = makeCursorExternalRoute(h.deps);
    const call = async () => route.handle({
      req: new MockReq() as unknown as IncomingMessage,
      res: new MockRes() as unknown as ServerResponse,
      requestId: "r", uid: 3n, identity: { uid: 3n, containerId: null } as ProxyIdentity,
      body: body(), authorize: async () => {}, userLog: quiet,
    });
    await call();
    await call();
    assert.equal(h.factoryCalls.length, 1);
    snaps.set("17", snapshot(17n, { token: Buffer.from("crsr_rotated") }));
    await call();
    assert.equal(h.factoryCalls.length, 2);
    assert.equal(h.relayCalls[2]!.accountToken, "crsr_rotated");
    await route.close();
  });

  test("session snapshot without machine_id is unusable → 503", async () => {
    const snaps = new Map<string, CursorTokenSnapshot | null>([
      ["17", snapshot(17n, { credential_kind: "session", machine_id: null })],
    ]);
    const h = harness({ accounts: [account({ id: 17n, cursor_credential_kind: "session" })], snapshots: snaps });
    const { res } = await run(h);
    assert.equal(res.statusCode, 503);
    assert.equal(h.factoryCalls.length, 0);
  });

  test("relay 401 → account enters cooldown, settle records error with 0 usage, next request 503s", async () => {
    const h = harness({
      relay: async (_b, res) => {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: "error" }));
        return { kind: "rejected", status: 401, reason: "CURSOR_SAND_SESSION_EXPIRED", written: true };
      },
    });
    const route = makeCursorExternalRoute(h.deps);
    const first = new MockRes();
    await route.handle({
      req: new MockReq() as unknown as IncomingMessage, res: first as unknown as ServerResponse,
      requestId: "r1", uid: 3n, identity: { uid: 3n, containerId: null } as ProxyIdentity,
      body: body(), authorize: async () => {}, userLog: quiet,
    });
    assert.equal(first.statusCode, 401);
    assert.deepEqual(route._cooledAccountIds(), [17n]);
    assert.equal(h.settleCalls[0]!.engineStatus, "error");
    assert.equal(h.settleCalls[0]!.terminalCode, "CURSOR_SAND_SESSION_EXPIRED");
    const second = new MockRes();
    await route.handle({
      req: new MockReq() as unknown as IncomingMessage, res: second as unknown as ServerResponse,
      requestId: "r2", uid: 3n, identity: { uid: 3n, containerId: null } as ProxyIdentity,
      body: body(), authorize: async () => {}, userLog: quiet,
    });
    assert.equal(second.statusCode, 503);
    assert.equal(h.relayCalls.length, 1);
  });

  test("relay rejected without writing (NOT_SAND_ROUTE) → JSON error with that status", async () => {
    const h = harness({ relay: async () => ({ kind: "rejected", status: 400, reason: "NOT_SAND_ROUTE", written: false }) });
    const { res } = await run(h);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error?.code, "CURSOR_UPSTREAM_REJECTED");
  });

  test("client disconnect mid-stream → settle error USER_CANCELLED with partial usage", async () => {
    const h = harness({
      relay: async (_b, res, signal) => {
        res.write("event: message_start\n\n");
        // simulate the peer hanging up: close fires while still writable
        (res as unknown as MockRes).emit("close");
        assert.equal(signal.aborted, true);
        return { kind: "failed", reason: "aborted", usage: { input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      },
    });
    await run(h);
    assert.equal(h.settleCalls.length, 1);
    assert.equal(h.settleCalls[0]!.engineStatus, "error");
    assert.equal(h.settleCalls[0]!.terminalCode, "USER_CANCELLED");
    assert.deepEqual(h.settleCalls[0]!.usage, { input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test("relay throws before headers → 502 CURSOR_UPSTREAM_FAILED, settle error", async () => {
    const h = harness({ relay: async () => { throw new Error("ECONNRESET"); } });
    const { res } = await run(h);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error?.code, "CURSOR_UPSTREAM_FAILED");
    assert.equal(h.settleCalls[0]!.engineStatus, "error");
    assert.equal(h.settleCalls[0]!.terminalCode, "CURSOR_RELAY_FAILED");
  });

  test("settle throwing does not break the response; no post-commit fires", async () => {
    const h = harness({ settleThrows: true });
    let appended = 0;
    const { res } = await run(h, { appendCostCredits: async () => { appended++; } });
    assert.equal(res.statusCode, 200);
    assert.equal(appended, 0);
  });

  test("zero debit → no broadcast, attribution-only persist still happens", async () => {
    const h = harness({ settleResult: { usageId: 1n, ledgerId: null, clamped: false, debitedCredits: 0n, attributionCredits: 0n, balanceAfter: null } });
    const appends: unknown[][] = [];
    let broadcast = 0;
    await run(h, { appendCostCredits: async (...a) => { appends.push(a); }, broadcastToUser: () => { broadcast++; } });
    assert.equal(appends.length, 1);
    assert.equal(appends[0]![2], "0");
    assert.equal(broadcast, 0);
  });
});

describe("anthropic proxy handler — cursorExternal wiring", () => {
  function handlerDeps(over: Partial<AnthropicProxyDeps> = {}): AnthropicProxyDeps {
    const identity: IdentityStrategy = {
      async resolve() { return { uid: 3n, containerId: null }; },
      async authorize() {},
    };
    return {
      pgPool: {} as Pool,
      pricing: { get: (m: string) => (m === MODEL ? pricingRow(m) : null) } as unknown as PricingCache,
      preCheckRedis: { async atomicReserve() { throw new Error("no"); }, async releaseReservation() { return true; } },
      scheduler: {} as AnthropicProxyDeps["scheduler"],
      identity,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      rateLimitRedis: { async incr() { return 1; }, async expire() { return 1; } },
      logger: quiet,
      ...over,
    };
  }

  test("cursor model with cursorExternal injected is delegated (never reaches oauth routing)", async () => {
    const calls: string[] = [];
    const handler = makeAnthropicProxyHandler(handlerDeps({
      cursorExternal: {
        async handle(a) { calls.push(a.body.model); a.res.statusCode = 200; a.res.end("{}"); },
        async close() {},
        _cooledAccountIds: () => [],
      },
    }));
    const res = new MockRes();
    await handler(
      new MockReq(body()) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { hostUuid: "external-api-key", boundIp: "external-api-key" },
    );
    assert.deepEqual(calls, [MODEL]);
    assert.equal(res.statusCode, 200);
  });

  test("without cursorExternal a cursor model is not delegated (legacy path, regression lock)", async () => {
    const handler = makeAnthropicProxyHandler(handlerDeps());
    const res = new MockRes();
    await handler(
      new MockReq(body()) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { hostUuid: "self", boundIp: "1.1.1.1" },
    );
    // legacy path: cursor-* has no oauth/static route in this stub → non-2xx, not a 200 from a relay
    assert.notEqual(res.statusCode, 200);
    assert.ok(res.body.length > 0);
  });

  test("count_tokens: rejected 404 unless allowCountTokens; estimate = ceil(bytes/4)", async () => {
    const payload = { model: MODEL, messages: [{ role: "user", content: "hello world" }] };
    const off = makeAnthropicProxyHandler(handlerDeps());
    const resOff = new MockRes();
    const reqOff = new MockReq(payload); reqOff.url = "/v1/messages/count_tokens";
    await off(reqOff as unknown as IncomingMessage, resOff as unknown as ServerResponse, { hostUuid: "x", boundIp: "y" });
    assert.equal(resOff.statusCode, 404);

    const on = makeAnthropicProxyHandler(handlerDeps({ allowCountTokens: true }));
    const resOn = new MockRes();
    const reqOn = new MockReq(payload); reqOn.url = "/v1/messages/count_tokens";
    await on(reqOn as unknown as IncomingMessage, resOn as unknown as ServerResponse, { hostUuid: "x", boundIp: "y" });
    assert.equal(resOn.statusCode, 200);
    const expected = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / 4));
    assert.deepEqual(JSON.parse(resOn.body), { input_tokens: expected });
  });
});

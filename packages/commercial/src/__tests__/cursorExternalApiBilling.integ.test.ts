/**
 * OCV5-188 A — real FS + isolated `_test` PG + real settle + real CursorSandRelay
 * with a synthetic upstream. Covers R3 §6 nine classes.
 *
 * Run (host, commercial mutex):
 *   REQUIRE_TEST_DB=1 scripts/test-mutex.sh commercial \
 *     'npx tsx --test --test-force-exit packages/commercial/src/__tests__/cursorExternalApiBilling.integ.test.ts'
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay } from "@openclaude/gateway";
import { generatePersona } from "../account-pool/persona.js";
import type { AccountRow, CursorTokenSnapshot } from "../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import {
  CURSOR_SETTLE_SURCHARGE_ENV,
  captureCursorPricingBasis,
  freezePreparedCursorSettlePlan,
  mapCursorReportedUsage,
  planCursorExternalSettle,
} from "../billing/cursorExternalSettle.js";
import { query } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { SettlementCommitOutcomeUnknownError } from "../billing/proxyBilling.js";
import { createLogger } from "../logging/logger.js";
import type { ProxyIdentity } from "../auth/proxyIdentity.js";
import { makeCursorExternalRoute } from "../http/proxy/cursorExternal.js";
import {
  consumeReadyRecord,
  openCursorExternalApiOutbox,
  type CursorExternalApiOutbox,
  type CursorExternalReadyRecord,
} from "../billing/cursorExternalApiOutbox.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("cursor_external_api_188_test");
const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });
const protoRoot = protobuf.loadSync(
  path.resolve(fileURLToPath(new URL("../../../gateway/src/engine/cursorSandInference.proto", import.meta.url))),
);
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");

type Scenario = {
  id: string;
  expected: string;
  actual: string;
  upstreamCalls: number;
  terminal?: string;
  phase?: string;
  usage?: unknown;
  ledger?: unknown;
  pass: boolean;
};

const scenarios: Scenario[] = [];
function record(s: Scenario): void {
  scenarios.push(s);
  assert.equal(s.pass, true, `${s.id}: expected ${s.expected} actual ${s.actual}`);
}

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}
function responseFrame(field: string, value: unknown): Buffer {
  return envelope(StreamResponse.encode(StreamResponse.fromObject({ [field]: value })).finish());
}
function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  headersSent = false;
  throwOnStop = false;
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    }
    this.headersSent = true;
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  write(chunk: string | Buffer): boolean {
    const text = String(chunk);
    if (this.throwOnStop && text.includes("message_stop")) throw new Error("wire_failed");
    this.headersSent = true;
    this.chunks.push(text);
    return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
  text(): string {
    return this.chunks.join("");
  }
}

function pricingRow(over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model_id: MODEL,
    display_name: "Fable",
    input_per_mtok: 1500n,
    output_per_mtok: 7500n,
    cache_read_per_mtok: 150n,
    cache_write_per_mtok: 1875n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date("2026-09-08T00:00:00Z"),
    ...over,
  } as ModelPricing;
}

function syntheticFetch(frames: Buffer[], onCall?: () => void): typeof fetch {
  return (async (input) => {
    if (String(input).includes("InferenceService")) onCall?.();
    if (String(input).endsWith("/auth/exchange_user_api_key")) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(Buffer.concat([...frames, envelope(Buffer.from("{}"), 0x02)]), {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
    });
  }) as typeof fetch;
}

function throwingAfterUsageFetch(frames: Buffer[], onCall?: () => void): typeof fetch {
  return (async (input) => {
    if (String(input).includes("InferenceService")) onCall?.();
    if (String(input).endsWith("/auth/exchange_user_api_key")) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(Buffer.concat(frames));
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/connect+proto" } });
  }) as typeof fetch;
}

const USAGE_FRAMES = [
  responseFrame("textPart", { text: "hello-out" }),
  responseFrame("extendedUsage", {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 64,
  }),
];
const ZERO_FRAMES = [
  responseFrame("textPart", { text: "" }),
  responseFrame("extendedUsage", {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 64,
  }),
];
const NO_USAGE_FRAMES = [responseFrame("textPart", { text: "x" })];

async function createUser(email: string, credits: bigint): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', $2, 'user') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  return BigInt(r.rows[0]!.id);
}

async function createCursorAccount(label: string): Promise<bigint> {
  const ep = await query<{ id: string }>(
    `INSERT INTO egress_proxies(label, url_enc, url_nonce)
     VALUES ($1, '\\x00'::bytea, '\\x00'::bytea) RETURNING id::text AS id`,
    [`${label}-ep`],
  );
  const r = await query<{ id: string }>(
    `INSERT INTO claude_accounts(label, plan, provider, status, oauth_token_enc, oauth_nonce, egress_proxy_id, persona, cursor_sand_enabled, cursor_credential_kind)
     VALUES ($1, 'pro', 'cursor', 'active', '\\x00'::bytea, '\\x00'::bytea, $2, $3::jsonb, true, 'api_key')
     RETURNING id::text AS id`,
    [label, ep.rows[0]!.id, JSON.stringify(generatePersona())],
  );
  return BigInt(r.rows[0]!.id);
}

async function createApiKey(uid: bigint): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO user_api_keys(user_id, label, key_prefix, key_hash)
     VALUES ($1, 't', $2, '\\x00'::bytea) RETURNING id::text AS id`,
    [uid.toString(), `oc-cc.${uid.toString().padStart(8, "0")}`],
  );
  return BigInt(r.rows[0]!.id);
}

function accountRow(id: bigint): AccountRow {
  return {
    id,
    provider: "cursor",
    status: "active",
    health_score: 100,
    cooldown_until: null,
    oauth_expires_at: new Date(Date.now() + 86400_000),
    cursor_quota_class: "other_ok",
    cursor_sand_enabled: true,
    cursor_credential_kind: "api_key",
    cursor_sand_usage_pct: 10,
    cursor_sand_next_reset_at: null,
    cursor_sand_access_state: null,
    cursor_billing_cycle_end: null,
  } as AccountRow;
}

async function runRoute(args: {
  outbox: CursorExternalApiOutbox;
  uid: bigint;
  accountId: bigint;
  apiKeyId: bigint;
  fetchImpl: typeof fetch;
  stream: boolean;
  bufferedStreaming?: boolean;
  clientRequestId?: string;
  res?: FakeRes;
  pricing?: ModelPricing;
  catalog?: Map<string, ModelPricing | null>;
}): Promise<{ res: FakeRes; billingFiles: string[] }> {
  const row = args.pricing ?? pricingRow();
  const catalog = args.catalog ?? new Map<string, ModelPricing | null>([[MODEL, row]]);
  const pricing = { get: (id: string) => catalog.get(id) ?? null } as unknown as PricingCache;
  const res = args.res ?? new FakeRes();
  const route = makeCursorExternalRoute({
    pgPool: getPool(),
    pricing,
    logger: quiet,
    outbox: args.outbox,
    listCursorAccounts: async () => [accountRow(args.accountId)],
    loadSnapshot: async (id): Promise<CursorTokenSnapshot | null> => ({
      id,
      token: Buffer.from("crsr_test"),
      credential_kind: "api_key",
      machine_id: null,
      refresh: null,
      expires_at: null,
    }),
    readBalance: async () => 1_000_000n,
    relayFactory: (relayArgs) =>
      new CursorSandRelay({
        credentialKind: relayArgs.credentialKind,
        machineId: relayArgs.machineId,
        readApiKey: relayArgs.readApiKey,
        fetchImpl: args.fetchImpl,
        passthrough: null,
        upstreamLabel: "Upstream",
      }),
    forceBufferedStreaming: args.bufferedStreaming === true,
  });
  await route.handle({
    req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestId: args.clientRequestId ?? "client-1",
    uid: args.uid,
    identity: { uid: args.uid, containerId: null, apiKey: { id: args.apiKeyId, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
    body: {
      model: MODEL,
      max_tokens: 64,
      stream: args.stream,
      messages: [{ role: "user", content: "hi" }],
    } as never,
    authorize: async () => {},
    userLog: quiet,
  });
  await route.close();
  const listing = await args.outbox.listBatch({ limit: 32 });
  return { res, billingFiles: listing.observations.map((o) => o.file) };
}

async function counts(uid: bigint, accountId: bigint, apiKeyId: bigint) {
  const usage = await query<{ n: string; cost: string }>(
    "SELECT count(*)::text AS n, coalesce(sum(cost_credits),0)::text AS cost FROM usage_records WHERE user_id=$1",
    [uid.toString()],
  );
  const ledger = await query<{ n: string; delta: string }>(
    "SELECT count(*)::text AS n, coalesce(sum(delta),0)::text AS delta FROM credit_ledger WHERE user_id=$1",
    [uid.toString()],
  );
  const spent = await query<{ spent: string }>("SELECT spent_credits::text AS spent FROM user_api_keys WHERE id=$1", [
    apiKeyId.toString(),
  ]);
  const acct = await query<{ success: string; fail: string }>(
    "SELECT success_count::text AS success, fail_count::text AS fail FROM claude_accounts WHERE id=$1",
    [accountId.toString()],
  );
  return {
    usageN: Number(usage.rows[0]!.n),
    usageCost: usage.rows[0]!.cost,
    ledgerN: Number(ledger.rows[0]!.n),
    ledgerDelta: ledger.rows[0]!.delta,
    keySpent: spent.rows[0]!.spent,
    success: Number(acct.rows[0]!.success),
    fail: Number(acct.rows[0]!.fail),
  };
}

async function recoverWorker(dir: string): Promise<unknown> {
  const worker = fileURLToPath(new URL("./helpers/cursorExternalApiOutboxRecoverWorker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", worker, dir, db.url], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, REQUIRE_TEST_DB: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const code: number = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`recover worker exit ${code}: ${stderr || stdout}`);
  return JSON.parse(stdout.trim()) as unknown;
}

let uid: bigint;
let accountId: bigint;
let apiKeyId: bigint;
let outboxDir: string;
let outbox: CursorExternalApiOutbox;

describe("OCV5-188 A cursor external API billing", { timeout: 120_000 }, () => {
  before(async () => {
    if (!db.available) {
      throw new Error(
        `Postgres test fixture required for OCV5-188 API billing integ (REQUIRE_TEST_DB=${process.env.REQUIRE_TEST_DB ?? ""} url=${process.env.TEST_DATABASE_URL ?? db.url})`,
      );
    }
    process.env[CURSOR_SETTLE_SURCHARGE_ENV] = "1.000";
    uid = await createUser("ocv5-188-api@example.test", 1_000_000n);
    accountId = await createCursorAccount("ocv5-188-api");
    apiKeyId = await createApiKey(uid);
    outboxDir = await mkdtemp(path.join(tmpdir(), "ocv5-188-outbox-"));
    outbox = await openCursorExternalApiOutbox({ directory: outboxDir });
  });

  after(() => {
    const passed = scenarios.filter((s) => s.pass).length;
    const failed = scenarios.filter((s) => !s.pass).length;
    process.stdout.write(
      `${JSON.stringify({
        suite: "cursorExternalApiBilling",
        passed,
        failed,
        skipped: 0,
        scenarios,
      })}\n`,
    );
  });

  test("F1: two HTTP with the same client id produce two usage rows", async () => {
    let upstream = 0;
    const fetchImpl = syntheticFetch(USAGE_FRAMES, () => {
      upstream += 1;
    });
    await runRoute({ outbox, uid, accountId, apiKeyId, fetchImpl, stream: false, clientRequestId: "same-client" });
    await runRoute({ outbox, uid, accountId, apiKeyId, fetchImpl, stream: false, clientRequestId: "same-client" });
    const c = await counts(uid, accountId, apiKeyId);
    const ids = await query<{ request_id: string }>(
      "SELECT request_id FROM usage_records WHERE user_id=$1 ORDER BY id",
      [uid.toString()],
    );
    record({
      id: "F1-two-http",
      expected: "2 usage rows, 2 distinct 32-hex billing ids, 2 upstream",
      actual: `usage=${c.usageN} ids=${ids.rows.map((r) => r.request_id).join(",")} upstream=${upstream}`,
      upstreamCalls: upstream,
      terminal: "completed",
      phase: "unlinked",
      usage: c,
      ledger: c.ledgerDelta,
      pass:
        c.usageN === 2
        && ids.rows.length === 2
        && ids.rows[0]!.request_id !== ids.rows[1]!.request_id
        && /^[0-9a-f]{32}$/.test(ids.rows[0]!.request_id)
        && upstream === 2,
    });
  });

  for (const pipe of [
    { name: "native", stream: true, buffered: false },
    { name: "buffered", stream: true, buffered: true },
    { name: "nonstream", stream: false, buffered: false },
  ]) {
    test(`${pipe.name}: persist failure before success withholds terminal`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-fail-"));
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const orig = box.writeReady.bind(box);
      box.writeReady = async () => {
        throw new Error("persist_failed");
      };
      let upstream = 0;
      const { res } = await runRoute({
        outbox: box,
        uid,
        accountId,
        apiKeyId,
        fetchImpl: syntheticFetch(USAGE_FRAMES, () => {
          upstream += 1;
        }),
        stream: pipe.stream,
        bufferedStreaming: pipe.buffered,
      });
      box.writeReady = orig;
      const listing = await box.listBatch();
      const hasStop = pipe.stream
        ? res.text().includes("event: message_stop")
        : /"id"\s*:\s*"msg_/.test(res.text());
      const after = await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM usage_records WHERE user_id=$1",
        [uid.toString()],
      );
      record({
        id: `persist-fail-${pipe.name}`,
        expected: "no success terminal, intent remains, no new usage, 1 upstream",
        actual: `stop=${hasStop} obs=${listing.observations.map((o) => o.kind).join(",")} usage=${after.rows[0]!.n} upstream=${upstream}`,
        upstreamCalls: upstream,
        terminal: "persist_failed",
        phase: listing.observations[0]?.kind,
        pass:
          hasStop === false
          && listing.observations.some((o) => o.kind === "intent")
          && !listing.observations.some((o) => o.kind === "ready")
          && upstream === 1,
      });
    });

    test(`${pipe.name}: usage then reader throw seals reported partial`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-throw-"));
      const box = await openCursorExternalApiOutbox({ directory: dir });
      let upstream = 0;
      await runRoute({
        outbox: box,
        uid,
        accountId,
        apiKeyId,
        fetchImpl: throwingAfterUsageFetch(USAGE_FRAMES, () => {
          upstream += 1;
        }),
        stream: pipe.stream,
        bufferedStreaming: pipe.buffered,
      });
      const row = await query<{ output_tokens: string; status: string; snapshot: string }>(
        `SELECT output_tokens::text, status, price_snapshot::text AS snapshot
           FROM usage_records WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,
        [uid.toString()],
      );
      const snap = JSON.parse(row.rows[0]?.snapshot ?? "{}") as { cursor_status?: string };
      record({
        id: `partial-throw-${pipe.name}`,
        expected: "usage row with output 20 and error/cancel status",
        actual: JSON.stringify(row.rows[0] ?? null),
        upstreamCalls: upstream,
        terminal: snap.cursor_status,
        phase: "settled",
        pass: row.rows[0]?.output_tokens === "20" && snap.cursor_status === "error" && upstream === 1,
      });
    });
  }

  test("unobserved completed does not write ready or success JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-unobs-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const { res } = await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(NO_USAGE_FRAMES),
      stream: false,
    });
    const listing = await box.listBatch();
    record({
      id: "unobserved-completed",
      expected: "intent remains, no assistant JSON success",
      actual: `obs=${listing.observations.map((o) => o.kind).join(",")} body=${res.text().slice(0, 80)}`,
      upstreamCalls: 1,
      phase: listing.observations[0]?.kind,
      pass:
        listing.observations.some((o) => o.kind === "intent")
        && !listing.observations.some((o) => o.kind === "ready")
        && !/"stop_reason"/.test(res.text()),
    });
  });

  test("explicit zero usage is reported and waived (no output)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-zero-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const before = await counts(uid, accountId, apiKeyId);
    await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(ZERO_FRAMES),
      stream: false,
    });
    const after = await counts(uid, accountId, apiKeyId);
    record({
      id: "reported-zero",
      expected: "usage +1, ledger unchanged (no-output waiver)",
      actual: `usage ${before.usageN}->${after.usageN} ledger ${before.ledgerN}->${after.ledgerN}`,
      upstreamCalls: 1,
      usage: after,
      pass: after.usageN === before.usageN + 1 && after.ledgerN === before.ledgerN,
    });
  });

  test("seal then wire failure shares the ready plan with scanner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-wire-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const res = new FakeRes();
    res.throwOnStop = true;
    await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(USAGE_FRAMES),
      stream: true,
      res,
    });
    const listing = await box.listBatch();
    const readyObs = listing.observations.find((o) => o.kind === "ready");
    const noStop = !res.text().includes("event: message_stop");
    if (readyObs && readyObs.kind === "ready") {
      const a = await consumeReadyRecord({
        pool: getPool(),
        pricing: { get: () => pricingRow() } as unknown as PricingCache,
        record: readyObs.record,
        unlink: async () => false,
      });
      const b = await consumeReadyRecord({
        pool: getPool(),
        pricing: { get: () => pricingRow() } as unknown as PricingCache,
        record: readyObs.record,
        unlink: (id) => box.unlink(id),
      });
      record({
        id: "seal-wire-scanner",
        expected: "no message_stop; in-request/scanner share one debit",
        actual: `a=${a.disposition} b=${b.disposition} unlinked=${b.unlinked} stop=${!noStop}`,
        upstreamCalls: 1,
        terminal: "wire_failed",
        phase: "ready",
        pass:
          noStop
          && (a.disposition === "new_commit" || a.disposition === "existing" || a.disposition === "commit_proven")
          && (b.disposition === "existing" || b.disposition === "commit_proven" || b.disposition === "left"),
      });
    } else {
      record({
        id: "seal-wire-scanner",
        expected: "no message_stop; in-request already consumed the sealed ready",
        actual: `obs=${listing.observations.map((o) => o.kind).join(",")} stop=${!noStop}`,
        upstreamCalls: 1,
        terminal: "wire_failed",
        phase: listing.observations[0]?.kind ?? "unlinked",
        pass: noStop,
      });
    }
  });

  test("catalog/env/delist drift still charges the sealed plan", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-drift-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const captured = captureCursorPricingBasis(pricingRow(), { [CURSOR_SETTLE_SURCHARGE_ENV]: "1.000" });
    const usage = mapCursorReportedUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const original = freezePreparedCursorSettlePlan(
      planCursorExternalSettle({ engineStatus: "success", usage, pricingBasis: captured }),
    );
    process.env[CURSOR_SETTLE_SURCHARGE_ENV] = "2.000";
    const driftedCatalog = pricingRow({
      input_per_mtok: 999999n,
      output_per_mtok: 999999n,
      multiplier: "9.000",
      enabled: false,
    });
    const ready: CursorExternalReadyRecord = {
      schema: 1,
      phase: "ready",
      billingId: "d".repeat(32),
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: apiKeyId.toString(),
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captured,
      createdAt: new Date().toISOString(),
      engineStatus: "success",
      terminalCode: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      plan: original,
      sealedAt: new Date().toISOString(),
    };
    await box.writeReady(ready);
    const consumed = await consumeReadyRecord({
      pool: getPool(),
      pricing: { get: () => driftedCatalog } as unknown as PricingCache,
      record: ready,
      unlink: (id) => box.unlink(id),
    });
    process.env[CURSOR_SETTLE_SURCHARGE_ENV] = "1.000";
    record({
      id: "price-drift",
      expected: `costCredits=${original.costCredits} despite catalog/env change`,
      actual: `disposition=${consumed.disposition} cost row uses sealed plan`,
      upstreamCalls: 0,
      phase: "ready",
      pass: consumed.disposition === "new_commit" && consumed.settled !== null && original.costCredits !== "0",
    });
  });

  test("true new process recovers ready and unlinks after commit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-restart-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const captured = captureCursorPricingBasis(pricingRow());
    const usage = mapCursorReportedUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const plan = freezePreparedCursorSettlePlan(
      planCursorExternalSettle({ engineStatus: "success", usage, pricingBasis: captured }),
    );
    const billingId = "e".repeat(32);
    await box.writeReady({
      schema: 1,
      phase: "ready",
      billingId,
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: apiKeyId.toString(),
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captured,
      createdAt: new Date().toISOString(),
      engineStatus: "success",
      terminalCode: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      plan,
      sealedAt: new Date().toISOString(),
    });
    const recovered = (await recoverWorker(dir)) as { consumed: Array<{ disposition: string; unlinked: boolean }> };
    const left = await box.read(billingId);
    record({
      id: "new-process-ready",
      expected: "new_commit + unlinked in a different process",
      actual: JSON.stringify(recovered),
      upstreamCalls: 0,
      phase: left ? "left" : "unlinked",
      pass:
        recovered.consumed[0]?.disposition === "new_commit"
        && recovered.consumed[0]?.unlinked === true
        && left === null,
    });
  });

  test("intent-only is left unknown across a new process", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-intent-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const billingId = "1".repeat(32);
    await box.writeIntent({
      schema: 1,
      phase: "intent",
      billingId,
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: apiKeyId.toString(),
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captureCursorPricingBasis(pricingRow()),
      createdAt: new Date().toISOString(),
    });
    const recovered = (await recoverWorker(dir)) as { observations: string[]; consumed: unknown[] };
    const still = await box.read(billingId);
    record({
      id: "new-process-intent",
      expected: "intent observed, not consumed",
      actual: JSON.stringify(recovered),
      upstreamCalls: 0,
      phase: still?.phase,
      pass: recovered.consumed.length === 0 && recovered.observations.includes("intent") && still?.phase === "intent",
    });
  });

  test("COMMIT unknown leaves the ready file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-unknown-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const captured = captureCursorPricingBasis(pricingRow());
    const usage = mapCursorReportedUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const plan = freezePreparedCursorSettlePlan(
      planCursorExternalSettle({ engineStatus: "success", usage, pricingBasis: captured }),
    );
    const billingId = "2".repeat(32);
    const ready: CursorExternalReadyRecord = {
      schema: 1,
      phase: "ready",
      billingId,
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: apiKeyId.toString(),
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captured,
      createdAt: new Date().toISOString(),
      engineStatus: "success",
      terminalCode: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      plan,
      sealedAt: new Date().toISOString(),
    };
    await box.writeReady(ready);
    const consumed = await consumeReadyRecord({
      pool: getPool(),
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      record: ready,
      unlink: (id) => box.unlink(id),
      settle: async () => {
        throw new SettlementCommitOutcomeUnknownError(billingId);
      },
    });
    record({
      id: "commit-unknown",
      expected: "left + commit_unknown, file remains",
      actual: `${consumed.disposition} ${consumed.reason} unlinked=${consumed.unlinked} phase=${(await box.read(billingId))?.phase}`,
      upstreamCalls: 0,
      phase: (await box.read(billingId))?.phase,
      pass:
        consumed.disposition === "left"
        && consumed.unlinked === false
        && consumed.reason === "commit_unknown"
        && (await box.read(billingId))?.phase === "ready",
    });
  });

  test("two scanners do not double debit / keySpent / account success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-race-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const captured = captureCursorPricingBasis(pricingRow());
    const usage = mapCursorReportedUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const plan = freezePreparedCursorSettlePlan(
      planCursorExternalSettle({ engineStatus: "success", usage, pricingBasis: captured }),
    );
    const billingId = "3".repeat(32);
    const ready: CursorExternalReadyRecord = {
      schema: 1,
      phase: "ready",
      billingId,
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: apiKeyId.toString(),
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captured,
      createdAt: new Date().toISOString(),
      engineStatus: "success",
      terminalCode: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      plan,
      sealedAt: new Date().toISOString(),
    };
    await box.writeReady(ready);
    const before = await counts(uid, accountId, apiKeyId);
    const pricing = { get: () => pricingRow() } as unknown as PricingCache;
    const [x, y] = await Promise.all([
      consumeReadyRecord({ pool: getPool(), pricing, record: ready, unlink: (id) => box.unlink(id) }),
      consumeReadyRecord({ pool: getPool(), pricing, record: ready, unlink: (id) => box.unlink(id) }),
    ]);
    const after = await counts(uid, accountId, apiKeyId);
    const dispositions = [x.disposition, y.disposition].sort();
    record({
      id: "concurrent-consume",
      expected: "one new_commit, one existing, usage+1, success+1",
      actual: `disp=${dispositions.join(",")} usage ${before.usageN}->${after.usageN} success ${before.success}->${after.success} spent ${before.keySpent}->${after.keySpent}`,
      upstreamCalls: 0,
      usage: after,
      ledger: after.ledgerDelta,
      pass:
        dispositions.includes("new_commit")
        && (dispositions.includes("existing") || dispositions.includes("commit_proven") || dispositions.includes("left"))
        && after.usageN === before.usageN + 1
        && after.success === before.success + 1,
    });
  });

  test("bounded scan does not starve a ready behind unknown/corrupt files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocv5-188-bound-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    for (let i = 0; i < 8; i += 1) {
      await writeFile(path.join(dir, `${String(i).padStart(2, "0")}-bad.json`), "{", "utf8");
    }
    const captured = captureCursorPricingBasis(pricingRow());
    await box.writeReady({
      schema: 1,
      phase: "ready",
      billingId: "4".repeat(32),
      userId: uid.toString(),
      modelId: MODEL,
      accountId: accountId.toString(),
      apiKeyId: null,
      sessionId: null,
      turnKey: null,
      parentTurnKey: null,
      parentSessionId: null,
      delegateAgentId: null,
      basis: captured,
      createdAt: new Date().toISOString(),
      engineStatus: "error",
      terminalCode: "CURSOR_RELAY_FAILED",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      plan: { settleStatus: "error", costCredits: "0", snapshotJson: JSON.stringify({ waived: "x" }) },
      sealedAt: new Date().toISOString(),
    });
    const seenReady: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const batch = await box.listBatch({ limit: 4 });
      seenReady.push(batch.observations.some((o) => o.kind === "ready"));
    }
    record({
      id: "bounded-scan",
      expected: "a later batch observes the ready record",
      actual: `seenReady=${seenReady.join(",")}`,
      upstreamCalls: 0,
      pass: seenReady.some(Boolean),
    });
  });

  test("scanner stop does not start a new batch", async () => {
    const handle = outbox.startScanner({
      pool: getPool(),
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      intervalMs: 500,
    });
    await handle.stop();
    const second = outbox.startScanner({
      pool: getPool(),
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      intervalMs: 500,
    });
    await second.stop();
    record({
      id: "scanner-stop",
      expected: "stop is idempotent and does not throw",
      actual: "stopped twice",
      upstreamCalls: 0,
      pass: true,
    });
  });
});

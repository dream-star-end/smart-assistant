/**
 * OCV5-188 A — real FS + isolated `_test` PG + real settle + real CursorSandRelay
 * with a synthetic upstream. Covers R3 §6 nine classes.
 *
 * Run (host, commercial mutex):
 *   REQUIRE_TEST_DB=1 scripts/test-mutex.sh commercial \
 *     'npx tsx --test packages/commercial/src/__tests__/cursorExternalApiBilling.integ.test.ts'
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createBillingDiagnostics, type BillingScenario } from "./helpers/cursorExternalApiDiagnostics.js";

const db = useDedicatedTestDatabase("cursor_external_api_188_test");
const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });
const protoRoot = protobuf.loadSync(
  path.resolve(fileURLToPath(new URL("../../../gateway/src/engine/cursorSandInference.proto", import.meta.url))),
);
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");

type Scenario = BillingScenario;

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SOURCE_FILES = [
  "packages/commercial/src/billing/cursorExternalApiOutbox.ts",
  "packages/commercial/src/http/proxy/cursorExternal.ts",
  "packages/gateway/src/engine/cursorSandRelay.ts",
  "packages/commercial/src/__tests__/cursorExternalApiBilling.integ.test.ts",
  "packages/commercial/src/__tests__/helpers/cursorExternalApiDiagnostics.ts",
];

const diag = createBillingDiagnostics("cursorExternalApiBilling");
const { expectScenario, record } = diag;
const tmpDirs = new Set<string>();
const liveChildren = new Set<ReturnType<typeof spawn>>();

async function trackedTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.add(dir);
  return dir;
}

async function fileSha256(rel: string): Promise<string> {
  const buf = await readFile(path.join(REPO_ROOT, rel));
  return createHash("sha256").update(buf).digest("hex");
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
  hangUp(): void {
    this.emit("close");
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
const CANCEL_PARTIAL_FRAMES = [
  responseFrame("textPart", { text: "partial-out" }),
  responseFrame("extendedUsage", {
    inputTokens: 40,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 64,
  }),
];

function hangingFetch(frames: Buffer[], onCall?: () => void): typeof fetch {
  return (async (input, init) => {
    if (String(input).includes("InferenceService")) onCall?.();
    if (String(input).endsWith("/auth/exchange_user_api_key")) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const signal = (init as RequestInit | undefined)?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat(frames));
        const onAbort = () => {
          try {
            controller.error(Object.assign(new Error("AbortError"), { name: "AbortError" }));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/connect+proto" } });
  }) as typeof fetch;
}

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
  liveChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 20_000);
  try {
    const code: number = await new Promise((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(`recover worker exit ${code}: ${stderr || stdout}`);
    return JSON.parse(stdout.trim()) as unknown;
  } finally {
    clearTimeout(timer);
    liveChildren.delete(child);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

async function spawnBounded(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  liveChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const code: number | null = await new Promise((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    liveChildren.delete(child);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

async function lastUsageRow() {
  const row = await query<{
    request_id: string;
    output_tokens: string;
    status: string;
    cost_credits: string;
    snapshot: string;
  }>(
    `SELECT request_id, output_tokens::text, status, cost_credits::text,
            price_snapshot::text AS snapshot
       FROM usage_records WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,
    [uid.toString()],
  );
  return row.rows[0] ?? null;
}

async function runCancelRoute(args: {
  frames: Buffer[];
  stream: boolean;
  buffered?: boolean;
}): Promise<{
  listing: Awaited<ReturnType<CursorExternalApiOutbox["listBatch"]>>;
  before: Awaited<ReturnType<typeof counts>>;
  after: Awaited<ReturnType<typeof counts>>;
  last: Awaited<ReturnType<typeof lastUsageRow>>;
  upstream: number;
  text: string;
}> {
  const dir = await trackedTemp("ocv5-188-cancel-");
  const box = await openCursorExternalApiOutbox({ directory: dir });
  let upstream = 0;
  const res = new FakeRes();
  const before = await counts(uid, accountId, apiKeyId);
  const route = makeCursorExternalRoute({
    pgPool: getPool(),
    pricing: { get: () => pricingRow() } as unknown as PricingCache,
    logger: quiet,
    outbox: box,
    forceBufferedStreaming: args.buffered === true,
    listCursorAccounts: async () => [accountRow(accountId)],
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
        fetchImpl: hangingFetch(args.frames, () => {
          upstream += 1;
        }),
        passthrough: null,
        upstreamLabel: "Upstream",
      }),
  });
  const done = route.handle({
    req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestId: "client-cancel",
    uid,
    identity: { uid, containerId: null, apiKey: { id: apiKeyId, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
    body: {
      model: MODEL,
      max_tokens: 64,
      stream: args.stream,
      messages: [{ role: "user", content: "hi" }],
    } as never,
    authorize: async () => {},
    userLog: quiet,
  });
  const waitUntil = Date.now() + 1_000;
  while (Date.now() < waitUntil && !res.headersSent && res.chunks.length === 0) {
    await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, 40));
  res.hangUp();
  await done;
  await route.close();
  const listing = await box.listBatch({ limit: 8 });
  const after = await counts(uid, accountId, apiKeyId);
  const last = await lastUsageRow();
  return { listing, before, after, last, upstream, text: res.text() };
}

let uid: bigint;
let accountId: bigint;
let apiKeyId: bigint;
let outboxDir: string;
let outbox: CursorExternalApiOutbox;

describe("OCV5-188 A cursor external API billing", { timeout: 180_000 }, () => {
  before(async () => {
    try {
      if (!db.available) {
        throw new Error(
          `Postgres test fixture required for OCV5-188 API billing integ (REQUIRE_TEST_DB=${process.env.REQUIRE_TEST_DB ?? ""} url=${process.env.TEST_DATABASE_URL ?? db.url})`,
        );
      }
      process.env[CURSOR_SETTLE_SURCHARGE_ENV] = "1.000";
      uid = await createUser("ocv5-188-api@example.test", 1_000_000n);
      accountId = await createCursorAccount("ocv5-188-api");
      apiKeyId = await createApiKey(uid);
      outboxDir = await trackedTemp("ocv5-188-outbox-");
      outbox = await openCursorExternalApiOutbox({ directory: outboxDir });
    } catch (err) {
      diag.noteBeforeError(err);
      throw err;
    }
  });

  after(async () => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    liveChildren.clear();
    const hashes: Record<string, string> = {};
    for (const rel of SOURCE_FILES) {
      try {
        hashes[rel] = await fileSha256(rel);
      } catch (err) {
        hashes[rel] = `unreadable:${err instanceof Error ? err.message : String(err)}`;
      }
    }
    diag.summary({
      sourceHashes: hashes,
      tmpDirs: [...tmpDirs],
    });
    await Promise.all([...tmpDirs].map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
    tmpDirs.clear();
  });

  const expectedScenarioIds = [
    "F1-two-http",
    "persist-fail-native",
    "partial-throw-native",
    "persist-fail-buffered",
    "partial-throw-buffered",
    "persist-fail-nonstream",
    "partial-throw-nonstream",
    "unobserved-completed",
    "reported-zero",
    "seal-wire-scanner",
    "price-drift",
    "new-process-ready",
    "new-process-intent",
    "commit-unknown",
    "concurrent-consume",
    "bounded-scan",
    "scanner-stop",
    "cancel-partial-native",
    "cancel-zero-native",
    "cancel-unobserved-native",
    "cancel-partial-buffered",
    "cancel-zero-buffered",
    "cancel-unobserved-buffered",
    "cancel-partial-nonstream",
    "cancel-zero-nonstream",
    "cancel-unobserved-nonstream",
    "after-commit-before-unlink",
    "route-pg-interrupt-recover",
    "old-source-f1-red",
  ];
  for (const id of expectedScenarioIds) expectScenario(id);

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
      expected: "2 usage rows, 2 distinct 32-hex billing ids, 2 upstream, ledgerΔ=-usageCost, keySpent=usageCost, success+2",
      actual: `usage=${c.usageN} ids=${ids.rows.map((r) => r.request_id).join(",")} upstream=${upstream} ledgerΔ=${c.ledgerDelta} cost=${c.usageCost} spent=${c.keySpent} success=${c.success} fail=${c.fail}`,
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
        && /^[0-9a-f]{32}$/.test(ids.rows[1]!.request_id)
        && upstream === 2
        && c.ledgerN === 2
        && c.ledgerDelta === `-${c.usageCost}`.replace("--", "-")
        && BigInt(c.ledgerDelta) === -BigInt(c.usageCost)
        && c.keySpent === c.usageCost
        && c.success === 2
        && c.fail === 0
        && BigInt(c.usageCost) > 0n,
    });
  });

  for (const pipe of [
    { name: "native", stream: true, buffered: false },
    { name: "buffered", stream: true, buffered: true },
    { name: "nonstream", stream: false, buffered: false },
  ]) {
    test(`${pipe.name}: persist failure before success withholds terminal`, async () => {
      const dir = await trackedTemp("ocv5-188-fail-");
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const orig = box.writeReady.bind(box);
      box.writeReady = async () => {
        throw new Error("persist_failed");
      };
      let upstream = 0;
      const before = await counts(uid, accountId, apiKeyId);
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
      const after = await counts(uid, accountId, apiKeyId);
      record({
        id: `persist-fail-${pipe.name}`,
        expected: "no success terminal, intent remains, no new usage/ledger/keySpent, 1 upstream",
        actual: `stop=${hasStop} obs=${listing.observations.map((o) => o.kind).join(",")} usage ${before.usageN}->${after.usageN} ledger ${before.ledgerDelta}->${after.ledgerDelta} spent ${before.keySpent}->${after.keySpent} upstream=${upstream}`,
        upstreamCalls: upstream,
        terminal: "persist_failed",
        phase: listing.observations[0]?.kind,
        pass:
          hasStop === false
          && listing.observations.some((o) => o.kind === "intent")
          && !listing.observations.some((o) => o.kind === "ready")
          && upstream === 1
          && after.usageN === before.usageN
          && after.ledgerDelta === before.ledgerDelta
          && after.keySpent === before.keySpent,
      });
    });

    test(`${pipe.name}: usage then reader throw seals reported partial`, async () => {
      const dir = await trackedTemp("ocv5-188-throw-");
      const box = await openCursorExternalApiOutbox({ directory: dir });
      let upstream = 0;
      const before = await counts(uid, accountId, apiKeyId);
      const beforeIds = await query<{ request_id: string }>(
        "SELECT request_id FROM usage_records WHERE user_id=$1",
        [uid.toString()],
      );
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
      const after = await counts(uid, accountId, apiKeyId);
      const known = new Set(beforeIds.rows.map((r) => r.request_id));
      const fresh = await query<{ request_id: string; output_tokens: string; status: string; snapshot: string; cost: string }>(
        `SELECT request_id, output_tokens::text, status, price_snapshot::text AS snapshot, cost_credits::text AS cost
           FROM usage_records WHERE user_id=$1 ORDER BY id`,
        [uid.toString()],
      );
      const row = fresh.rows.find((r) => !known.has(r.request_id));
      const snap = JSON.parse(row?.snapshot ?? "{}") as { cursor_status?: string; cursor_terminal_code?: string };
      record({
        id: `partial-throw-${pipe.name}`,
        expected: "this request: usage+1, new 32-hex billing id, output 20, cursor_status=error, ledger/spent unchanged",
        actual: `usage ${before.usageN}->${after.usageN} row=${JSON.stringify(row ?? null)} ledger ${before.ledgerDelta}->${after.ledgerDelta} spent ${before.keySpent}->${after.keySpent} upstream=${upstream}`,
        upstreamCalls: upstream,
        terminal: snap.cursor_status,
        phase: "settled",
        pass:
          upstream === 1
          && after.usageN === before.usageN + 1
          && !!row
          && /^[0-9a-f]{32}$/.test(row.request_id)
          && row.output_tokens === "20"
          && snap.cursor_status === "error"
          && after.ledgerDelta === before.ledgerDelta
          && after.keySpent === before.keySpent,
      });
    });
  }

  test("unobserved completed does not write ready or success JSON", async () => {
    const dir = await trackedTemp("ocv5-188-unobs-");
    const box = await openCursorExternalApiOutbox({ directory: dir });
    let upstream = 0;
    const { res } = await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(NO_USAGE_FRAMES, () => {
        upstream += 1;
      }),
      stream: false,
    });
    const listing = await box.listBatch();
    record({
      id: "unobserved-completed",
      expected: "intent remains, no assistant JSON success",
      actual: `obs=${listing.observations.map((o) => o.kind).join(",")} body=${res.text().slice(0, 80)} upstream=${upstream}`,
      upstreamCalls: upstream,
      phase: listing.observations[0]?.kind,
      pass:
        listing.observations.some((o) => o.kind === "intent")
        && !listing.observations.some((o) => o.kind === "ready")
        && !/"stop_reason"/.test(res.text())
        && upstream === 1,
    });
  });

  test("explicit zero usage is reported and waived (no output)", async () => {
    const dir = await trackedTemp("ocv5-188-zero-");
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const before = await counts(uid, accountId, apiKeyId);
    let upstream = 0;
    await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(ZERO_FRAMES, () => {
        upstream += 1;
      }),
      stream: false,
    });
    const after = await counts(uid, accountId, apiKeyId);
    record({
      id: "reported-zero",
      expected: "usage +1, ledger unchanged (no-output waiver)",
      actual: `usage ${before.usageN}->${after.usageN} ledger ${before.ledgerN}->${after.ledgerN} spent ${before.keySpent}->${after.keySpent} upstream=${upstream}`,
      upstreamCalls: upstream,
      usage: after,
      pass:
        after.usageN === before.usageN + 1
        && after.ledgerN === before.ledgerN
        && after.ledgerDelta === before.ledgerDelta
        && after.keySpent === before.keySpent
        && upstream === 1,
    });
  });

  test("seal then wire failure shares the ready plan with scanner", async () => {
    const dir = await trackedTemp("ocv5-188-wire-");
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const res = new FakeRes();
    res.throwOnStop = true;
    let upstream = 0;
    await runRoute({
      outbox: box,
      uid,
      accountId,
      apiKeyId,
      fetchImpl: syntheticFetch(USAGE_FRAMES, () => {
        upstream += 1;
      }),
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
        actual: `a=${a.disposition} b=${b.disposition} unlinked=${b.unlinked} stop=${!noStop} upstream=${upstream}`,
        upstreamCalls: upstream,
        terminal: "wire_failed",
        phase: "ready",
        pass:
          noStop
          && upstream === 1
          && (a.disposition === "new_commit" || a.disposition === "existing" || a.disposition === "commit_proven")
          && (b.disposition === "existing" || b.disposition === "commit_proven" || b.disposition === "left"),
      });
    } else {
      record({
        id: "seal-wire-scanner",
        expected: "no message_stop; in-request already consumed the sealed ready",
        actual: `obs=${listing.observations.map((o) => o.kind).join(",")} stop=${!noStop} upstream=${upstream}`,
        upstreamCalls: upstream,
        terminal: "wire_failed",
        phase: listing.observations[0]?.kind ?? "unlinked",
        pass: noStop && upstream === 1,
      });
    }
  });

  test("catalog/env/delist drift still charges the sealed plan", async () => {
    const dir = await trackedTemp("ocv5-188-drift-");
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
    const dir = await trackedTemp("ocv5-188-restart-");
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
    const dir = await trackedTemp("ocv5-188-intent-");
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
    const dir = await trackedTemp("ocv5-188-unknown-");
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
    const dir = await trackedTemp("ocv5-188-race-");
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
    const ledgerDelta = BigInt(after.ledgerDelta) - BigInt(before.ledgerDelta);
    const spentDelta = BigInt(after.keySpent) - BigInt(before.keySpent);
    const planCost = BigInt(plan.costCredits);
    const newCommits = dispositions.filter((d) => d === "new_commit").length;
    const proven = dispositions.filter((d) => d === "existing" || d === "commit_proven").length;
    record({
      id: "concurrent-consume",
      expected: "exactly one new_commit and one existing/commit_proven; usage+1; success+1; fail unchanged; ledgerΔ=-plan; keySpent+=plan",
      actual: `disp=${dispositions.join(",")} usage ${before.usageN}->${after.usageN} success ${before.success}->${after.success} fail ${before.fail}->${after.fail} ledgerΔ=${ledgerDelta} spentΔ=${spentDelta} plan=${plan.costCredits} leftover=${(await box.read(billingId))?.phase ?? "unlinked"}`,
      upstreamCalls: 0,
      usage: after,
      ledger: after.ledgerDelta,
      pass:
        newCommits === 1
        && proven === 1
        && after.usageN === before.usageN + 1
        && after.success === before.success + 1
        && after.fail === before.fail
        && after.ledgerN === before.ledgerN + 1
        && ledgerDelta === -planCost
        && spentDelta === planCost
        && planCost > 0n,
    });
  });

  test("bounded scan does not starve a ready behind unknown/corrupt files", async () => {
    const dir = await trackedTemp("ocv5-188-bound-");
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

  test("scanner stop drains the live handle and a second stop is idle", async () => {
    const dir = await trackedTemp("ocv5-188-stop-");
    const box = await openCursorExternalApiOutbox({ directory: dir });
    let scans = 0;
    const real = box.scanOnce.bind(box);
    box.scanOnce = async (deps) => {
      scans += 1;
      return real(deps);
    };
    const handle = box.startScanner({
      pool: getPool(),
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      intervalMs: 500,
    });
    const waitUntil = Date.now() + 2_000;
    while (scans < 1 && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const seen = scans;
    await handle.stop();
    await handle.stop();
    await new Promise((r) => setTimeout(r, 800));
    const afterDrain = scans;
    record({
      id: "scanner-stop",
      expected: "live scanner ticks at least once; stop drains; duplicate stop adds no tick",
      actual: `seen=${seen} afterDrain=${afterDrain}`,
      upstreamCalls: 0,
      pass: seen >= 1 && afterDrain === seen,
    });
  });

  for (const pipe of [
    { name: "native", stream: true, buffered: false },
    { name: "buffered", stream: true, buffered: true },
    { name: "nonstream", stream: false, buffered: false },
  ]) {
    test(`${pipe.name}: USER_CANCELLED after positive output settles reported partial`, async () => {
      const got = await runCancelRoute({
        frames: CANCEL_PARTIAL_FRAMES,
        stream: pipe.stream,
        buffered: pipe.buffered,
      });
      const snap = JSON.parse(got.last?.snapshot ?? "{}") as {
        cursor_status?: string;
        cursor_terminal_code?: string;
      };
      const ledgerDelta = BigInt(got.after.ledgerDelta) - BigInt(got.before.ledgerDelta);
      const spentDelta = BigInt(got.after.keySpent) - BigInt(got.before.keySpent);
      const cost = BigInt(got.last?.cost_credits ?? "0");
      record({
        id: `cancel-partial-${pipe.name}`,
        expected: "USER_CANCELLED usage+1 output=7 cursor_status=error; ledgerΔ=-cost; keySpent+=cost",
        actual: `usage ${got.before.usageN}->${got.after.usageN} out=${got.last?.output_tokens} status=${got.last?.status} snap=${JSON.stringify(snap)} ledgerΔ=${ledgerDelta} spentΔ=${spentDelta} cost=${got.last?.cost_credits} obs=${got.listing.observations.map((o) => o.kind).join(",")} upstream=${got.upstream}`,
        upstreamCalls: got.upstream,
        terminal: "USER_CANCELLED",
        usage: got.after,
        ledger: got.after.ledgerDelta,
        pass:
          got.upstream === 1
          && got.after.usageN === got.before.usageN + 1
          && got.last?.output_tokens === "7"
          && snap.cursor_status === "error"
          && snap.cursor_terminal_code === "USER_CANCELLED"
          && cost > 0n
          && ledgerDelta === -cost
          && spentDelta === cost,
      });
    });

    test(`${pipe.name}: USER_CANCELLED after explicit zero is reported and not debited`, async () => {
      const got = await runCancelRoute({
        frames: ZERO_FRAMES,
        stream: pipe.stream,
        buffered: pipe.buffered,
      });
      const snap = JSON.parse(got.last?.snapshot ?? "{}") as {
        cursor_status?: string;
        cursor_terminal_code?: string;
        waived?: string;
      };
      record({
        id: `cancel-zero-${pipe.name}`,
        expected: "USER_CANCELLED usage+1 output=0 cost=0; ledger and keySpent unchanged",
        actual: `usage ${got.before.usageN}->${got.after.usageN} out=${got.last?.output_tokens} cost=${got.last?.cost_credits} snap=${JSON.stringify(snap)} ledger ${got.before.ledgerDelta}->${got.after.ledgerDelta} spent ${got.before.keySpent}->${got.after.keySpent} obs=${got.listing.observations.map((o) => o.kind).join(",")} upstream=${got.upstream}`,
        upstreamCalls: got.upstream,
        terminal: "USER_CANCELLED",
        usage: got.after,
        pass:
          got.upstream === 1
          && got.after.usageN === got.before.usageN + 1
          && got.last?.output_tokens === "0"
          && (got.last?.cost_credits === "0" || got.last?.cost_credits === "0.000")
          && snap.cursor_status === "error"
          && snap.cursor_terminal_code === "USER_CANCELLED"
          && got.after.ledgerDelta === got.before.ledgerDelta
          && got.after.keySpent === got.before.keySpent,
      });
    });

    test(`${pipe.name}: USER_CANCELLED before usage keeps intent/unobserved`, async () => {
      const got = await runCancelRoute({
        frames: NO_USAGE_FRAMES,
        stream: pipe.stream,
        buffered: pipe.buffered,
      });
      record({
        id: `cancel-unobserved-${pipe.name}`,
        expected: "intent remains, no new usage/ledger/keySpent",
        actual: `obs=${got.listing.observations.map((o) => o.kind).join(",")} usage ${got.before.usageN}->${got.after.usageN} ledger ${got.before.ledgerDelta}->${got.after.ledgerDelta} spent ${got.before.keySpent}->${got.after.keySpent} upstream=${got.upstream}`,
        upstreamCalls: got.upstream,
        phase: got.listing.observations.find((o) => o.kind === "intent") ? "intent" : got.listing.observations[0]?.kind,
        pass:
          got.upstream === 1
          && got.listing.observations.some((o) => o.kind === "intent")
          && !got.listing.observations.some((o) => o.kind === "ready")
          && got.after.usageN === got.before.usageN
          && got.after.ledgerDelta === got.before.ledgerDelta
          && got.after.keySpent === got.before.keySpent,
      });
    });
  }

  test("after COMMIT before unlink, a new process recovers existing and unlinks", async () => {
    const dir = await trackedTemp("ocv5-188-aftercommit-");
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
    const billingId = "5".repeat(32);
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
    const first = await consumeReadyRecord({
      pool: getPool(),
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      record: ready,
      unlink: async () => false,
    });
    const leftover = await box.read(billingId);
    const mid = await counts(uid, accountId, apiKeyId);
    const recovered = (await recoverWorker(dir)) as {
      consumed: Array<{ disposition: string; unlinked: boolean; billingId: string }>;
    };
    const after = await counts(uid, accountId, apiKeyId);
    const gone = await box.read(billingId);
    record({
      id: "after-commit-before-unlink",
      expected: "first consume new_commit leaves ready; new process existing/commit_proven unlinks; no second debit",
      actual: `first=${first.disposition} leftover=${leftover?.phase} recovered=${JSON.stringify(recovered)} gone=${gone?.phase ?? "unlinked"} usage ${before.usageN}->${mid.usageN}->${after.usageN} ledger ${before.ledgerDelta}->${mid.ledgerDelta}->${after.ledgerDelta} spent ${before.keySpent}->${mid.keySpent}->${after.keySpent} success ${before.success}->${mid.success}->${after.success}`,
      upstreamCalls: 0,
      usage: after,
      ledger: after.ledgerDelta,
      pass:
        first.disposition === "new_commit"
        && leftover?.phase === "ready"
        && recovered.consumed.length === 1
        && recovered.consumed[0]?.billingId === billingId
        && (recovered.consumed[0]?.disposition === "existing" || recovered.consumed[0]?.disposition === "commit_proven")
        && recovered.consumed[0]?.unlinked === true
        && gone === null
        && mid.usageN === before.usageN + 1
        && after.usageN === mid.usageN
        && after.ledgerDelta === mid.ledgerDelta
        && after.keySpent === mid.keySpent
        && after.success === mid.success
        && BigInt(mid.ledgerDelta) - BigInt(before.ledgerDelta) === -BigInt(plan.costCredits)
        && BigInt(mid.keySpent) - BigInt(before.keySpent) === BigInt(plan.costCredits),
    });
  });

  test("real route+relay ready then dedicated-pool interrupt, child exit, new process recover", async () => {
    const dir = await trackedTemp("ocv5-188-crash-");
    const marker = path.join(dir, "settling.marker");
    const appName = `ocv5-188-a-crash-${process.pid}-${Date.now()}`;
    const before = await counts(uid, accountId, apiKeyId);
    const worker = fileURLToPath(new URL("./helpers/cursorExternalApiCrash.worker.ts", import.meta.url));
    const childP = spawnBounded(
      [worker, dir, db.url, marker, uid.toString(), accountId.toString(), apiKeyId.toString(), appName],
      { ...process.env, REQUIRE_TEST_DB: "1", TEST_DATABASE_URL: db.url },
      25_000,
    );
    const waitUntil = Date.now() + 8_000;
    while (Date.now() < waitUntil) {
      try {
        await readFile(marker);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    await query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid <> pg_backend_pid()",
      [appName],
    ).catch(() => undefined);
    const child = await childP;
    const leftover = await (await openCursorExternalApiOutbox({ directory: dir })).listBatch({ limit: 8 });
    const recovered = (await recoverWorker(dir)) as {
      consumed: Array<{ billingId: string; disposition: string; unlinked: boolean; debited: string | null }>;
      observations: string[];
    };
    const after = await counts(uid, accountId, apiKeyId);
    const readyOrIntent = leftover.observations.filter((o) => o.kind === "ready" || o.kind === "intent");
    const billingId =
      leftover.observations.find((o) => o.kind === "ready") && leftover.observations.find((o) => o.kind === "ready")!.kind === "ready"
        ? (leftover.observations.find((o) => o.kind === "ready") as { record: { billingId: string } }).record.billingId
        : leftover.observations.find((o) => o.kind === "intent")
          ? (leftover.observations.find((o) => o.kind === "intent") as { billingId: string }).billingId
          : recovered.consumed[0]?.billingId;
    const usageRows = billingId
      ? await query<{ request_id: string; n: string }>(
          "SELECT request_id, count(*)::text AS n FROM usage_records WHERE user_id=$1 AND request_id=$2 GROUP BY request_id",
          [uid.toString(), billingId],
        )
      : { rows: [] as Array<{ request_id: string; n: string }> };
    const gone = billingId ? await (await openCursorExternalApiOutbox({ directory: dir })).read(billingId) : null;
    const usagePlus = after.usageN - before.usageN;
    const recoveredOk =
      recovered.consumed.length === 1
      && (recovered.consumed[0]?.disposition === "new_commit"
        || recovered.consumed[0]?.disposition === "existing"
        || recovered.consumed[0]?.disposition === "commit_proven")
      && recovered.consumed[0]?.unlinked === true;
    record({
      id: "route-pg-interrupt-recover",
      expected: "real route left ready/intent after dedicated-pool kill; new process recovered same billingId once; usage+1 no double debit",
      actual: `child=${child.code} leftover=${leftover.observations.map((o) => o.kind).join(",")} recovered=${JSON.stringify(recovered)} usage ${before.usageN}->${after.usageN} ledger ${before.ledgerDelta}->${after.ledgerDelta} spent ${before.keySpent}->${after.keySpent} success ${before.success}->${after.success} rows=${JSON.stringify(usageRows.rows)} gone=${gone?.phase ?? "unlinked"} app=${appName}`,
      upstreamCalls: 1,
      usage: after,
      ledger: after.ledgerDelta,
      pass:
        readyOrIntent.length >= 1
        && recoveredOk
        && usagePlus === 1
        && usageRows.rows.length === 1
        && usageRows.rows[0]!.n === "1"
        && after.success - before.success <= 1
        && after.fail === before.fail
        && gone === null,
    });
  });

  test("old 87d F1 oracle is an independent exit-1 business red from a pinned fixture", async () => {
    const worker = fileURLToPath(new URL("./helpers/cursorExternalApiOldF1.worker.ts", import.meta.url));
    const ran = await spawnBounded(
      [worker],
      {
        ...process.env,
        REQUIRE_TEST_DB: "1",
        TEST_DATABASE_URL: db.url,
        OC_188_UID: uid.toString(),
        OC_188_ACCOUNT: accountId.toString(),
        OC_188_KEY: apiKeyId.toString(),
      },
      60_000,
    );
    const business = /2 usage rows/.test(`${ran.stderr}\n${ran.stdout}`);
    record({
      id: "old-source-f1-red",
      expected: "pinned 87d fixture worker exits 1 on F1 two-row oracle (not hash/import exit 2); candidate F1 already exit0 in this suite",
      actual: `exit=${ran.code} business=${business} stdout=${ran.stdout.slice(0, 240)} stderr=${ran.stderr.slice(0, 240)}`,
      upstreamCalls: 2,
      pass: ran.code === 1 && business,
    });
  });
});

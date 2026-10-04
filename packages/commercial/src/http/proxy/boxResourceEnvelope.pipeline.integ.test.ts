import { assertTestDatabaseUrl, assertConnectedTestDatabase } from "../../../../../scripts/lib/testDatabaseIdentity.mjs";
/**
 * OCV5-296 C pipeline proof.
 *
 * On and off candidates are unpacked from one `git archive HEAD` of this
 * checkout. After normalizing the ready literal, commercial source bytes
 * match except that literal. Product files are not modified and are not
 * required to be false. The off phases import the off module. Plan bytes
 * stay the archived bytes (autoCompactSourceUnchanged). Remote Claude argv
 * (plan.run) is not executed; the injected transport runs the real
 * makeBoxTextPlan stage with local Python, then returns a legal SSE
 * terminal. It does not fake HTTP 200. The SSE is synthetic.
 *
 * Default command runs every scenario and does not skip. Set
 * OC_V5_296_PIPELINE_SUBSET=core,seam to omit matrix; omitted phases are
 * reported not-run and are not PASS.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_TTL_MS,
  MODEL_AUTHORITY_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type ModelAuthorityPayload,
  type TurnLease,
} from "@openclaude/protocol";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import Redis from "ioredis";
import pg from "pg";
import { LOCAL_CATALOG_HEADER, encodeLocalCatalogToken } from "./modelAuthorityGate.js";

const MODEL = "box-api-claude-opus-5-5";
const CHUNK = 128 * 1024;
const TEST_DB = "postgres://test:test@127.0.0.1:55432/openclaude_test";
assertTestDatabaseUrl(TEST_DB);
const SCHEMA = `ocv5_296_cpipe_${randomBytes(3).toString("hex")}`;
const REDIS_URL = "redis://127.0.0.1:56379/14";
const READY_FALSE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = false;";
const READY_TRUE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = true;";
const CHECKOUT_PROXY = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_COMMERCIAL = join(CHECKOUT_PROXY, "../../..");
const CHECKOUT_ROOT = join(CHECKOUT_COMMERCIAL, "../..");
const SUBSET = new Set((process.env.OC_V5_296_PIPELINE_SUBSET ?? "all").split(",").map((part) => part.trim()).filter(Boolean));
function phaseOn(name: "core" | "matrix" | "seam"): boolean {
  return SUBSET.has("all") || SUBSET.has(name);
}

function projectReady(source: string, ready: boolean): string {
  const want = ready ? READY_TRUE : READY_FALSE;
  const other = ready ? READY_FALSE : READY_TRUE;
  const wantCount = source.split(want).length - 1;
  const otherCount = source.split(other).length - 1;
  assert.equal(wantCount + otherCount, 1, "official archive owner must contain exactly one ready literal");
  return otherCount === 1 ? source.replace(other, want) : source;
}

function maskReady(source: string): string {
  const token = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = <ready>;";
  return source.replaceAll(READY_TRUE, token).replaceAll(READY_FALSE, token);
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

function buildCandidate(): {
  root: string;
  offRoot: string;
  owner: string;
  offOwner: string;
  autoCompactChanged: boolean;
  autoCompactSourceUnchanged: boolean;
  archiveOwnerHash: string;
  onOwnerHash: string;
  offOwnerHash: string;
  resolution: Record<string, string | boolean>;
} {
  const root = mkdtempOwned();
  const offRoot = mkdtempOwned();
  try {
  const archived = spawnSync("git", [
    "-c", `safe.directory=${CHECKOUT_ROOT}`,
    "-C", CHECKOUT_ROOT,
    "archive", "--format=tar", "HEAD",
    "packages/commercial/package.json",
    "packages/commercial/src",
  ], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(archived.status, 0, archived.stderr?.toString("utf8").slice(0, 500) || "git archive failed");
  for (const dest of [root, offRoot]) {
    const unpacked = spawnSync("tar", ["-x", "-C", dest], { input: archived.stdout });
    assert.equal(unpacked.status, 0, unpacked.stderr?.toString("utf8").slice(0, 500) || "tar extract failed");
  }
  const ownerRel = "packages/commercial/src/http/proxy/boxNativeContextOwner.ts";
  const planRel = "packages/commercial/src/http/proxy/boxTextPlan.ts";
  const productOwnerPath = join(CHECKOUT_PROXY, "boxNativeContextOwner.ts");
  const productPlanPath = join(CHECKOUT_PROXY, "boxTextPlan.ts");
  const productOwnerBefore = readFileSync(productOwnerPath);
  const productPlanBefore = readFileSync(productPlanPath);
  const officialOwner = readFileSync(join(root, ownerRel), "utf8");
  const officialPlan = readFileSync(join(root, planRel), "utf8");
  assert.equal(readFileSync(join(offRoot, ownerRel), "utf8"), officialOwner);
  assert.equal(readFileSync(join(offRoot, planRel), "utf8"), officialPlan);
  const onOwnerText = projectReady(officialOwner, true);
  const offOwnerText = projectReady(officialOwner, false);
  assert.equal(maskReady(onOwnerText), maskReady(offOwnerText));
  assert.equal(maskReady(onOwnerText), maskReady(officialOwner));
  assert.notEqual(onOwnerText, offOwnerText);
  const owner = join(root, ownerRel);
  const offOwner = join(offRoot, ownerRel);
  writeFileSync(owner, onOwnerText);
  writeFileSync(offOwner, offOwnerText);
  const diffs: string[] = [];
  const onBase = join(root, "packages/commercial");
  const offBase = join(offRoot, "packages/commercial");
  for (const file of listFiles(onBase)) {
    const rel = file.slice(onBase.length + 1);
    const other = join(offBase, rel);
    assert.equal(existsSync(other), true, rel);
    if (!readFileSync(file).equals(readFileSync(other))) diffs.push(rel);
  }
  diffs.sort();
  assert.deepEqual(diffs, ["src/http/proxy/boxNativeContextOwner.ts"]);
  const onPlan = readFileSync(join(root, planRel), "utf8");
  const offPlan = readFileSync(join(offRoot, planRel), "utf8");
  const autoCompactSourceUnchanged = onPlan === officialPlan && offPlan === officialPlan;
  assert.equal(autoCompactSourceUnchanged, true);
  assert.equal(readFileSync(productOwnerPath).equals(productOwnerBefore), true);
  assert.equal(readFileSync(productPlanPath).equals(productPlanBefore), true);
  const nodeModules = join(CHECKOUT_ROOT, "node_modules");
  assert.equal(existsSync(join(nodeModules, "pg")), true, "checkout lock is missing pg");
  for (const dest of [root, offRoot]) {
    symlinkSync(nodeModules, join(dest, "node_modules"));
    assert.equal(lstatSync(join(dest, "node_modules")).isSymbolicLink(), true);
  }
  const requireFrom = createRequire(join(root, "packages/commercial/package.json"));
  const protocol = realpathSync(requireFrom.resolve("@openclaude/protocol"));
  const pgPath = realpathSync(requireFrom.resolve("pg"));
  const ioredis = realpathSync(requireFrom.resolve("ioredis"));
  const commercialEntry = realpathSync(requireFrom.resolve("@openclaude/commercial"));
  const checkoutReal = realpathSync(CHECKOUT_ROOT);
  assert.equal(protocol.startsWith(`${checkoutReal}/packages/protocol`), true, protocol);
  assert.equal(commercialEntry, realpathSync(join(root, "packages/commercial/src/index.ts")));
  assert.notEqual(commercialEntry, realpathSync(join(CHECKOUT_COMMERCIAL, "src/index.ts")));
  const offEntry = realpathSync(createRequire(join(offRoot, "packages/commercial/package.json")).resolve("@openclaude/commercial"));
  assert.equal(offEntry, realpathSync(join(offRoot, "packages/commercial/src/index.ts")));
  assert.notEqual(offEntry, commercialEntry);
  const linkedPg = realpathSync(join(nodeModules, "pg"));
  const linkedIoredis = realpathSync(join(nodeModules, "ioredis"));
  assert.equal(pgPath.startsWith(`${linkedPg}/`), true, pgPath);
  assert.equal(ioredis.startsWith(`${linkedIoredis}/`), true, ioredis);
  assert.equal(pgPath.includes(`${root}/`), false);
  assert.equal(ioredis.includes(`${root}/`), false);
  return {
    root,
    offRoot,
    owner,
    offOwner,
    autoCompactChanged: false,
    autoCompactSourceUnchanged,
    archiveOwnerHash: createHash("sha256").update(officialOwner).digest("hex"),
    onOwnerHash: createHash("sha256").update(onOwnerText).digest("hex"),
    offOwnerHash: createHash("sha256").update(offOwnerText).digest("hex"),
    resolution: {
      candidateRoot: root,
      offRoot,
      checkoutRoot: checkoutReal,
      source: "git-archive-HEAD",
      protocol,
      pg: pgPath,
      pgPackage: linkedPg,
      ioredis,
      ioredisPackage: linkedIoredis,
      commercialEntry,
      offEntry,
      commercialEntryIsOwnedCopy: true,
      offEntryIsOwnedCopy: true,
      nodeModulesIsSymlinkToCheckoutLock: true,
      readyLiteralOnlyBetweenOnAndOff: true,
    },
  };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(offRoot, { recursive: true, force: true });
    throw error;
  }
}

function mkdtempOwned(): string {
  return mkdtempSync(join(tmpdir(), "ocv5-296-cand-"));
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
const KEY_ID = "mak1_testkey00000001";
const keyring = new Map<string, Uint8Array>([[KEY_ID, new Uint8Array(publicRaw)]]);
const EPOCH = 12;
const supervisor = readFileSync(new URL("../../../../../scripts/ocv5-289/box_supervisor.py", import.meta.url));
const keeper = readFileSync(new URL("../../../../../scripts/ocv5-289/box_keeper.py", import.meta.url));

function rounds(n: number): unknown[] {
  const messages: unknown[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < n; i += 1) {
    const id = `toolu_${String(i).padStart(6, "0")}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { path: `f${i}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(CHUNK) }],
    });
  }
  return messages;
}

function textBody(messages: unknown[]): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 128,
    stream: true,
    messages,
    metadata: {
      user_id: JSON.stringify({
        oc_turn_key: "ab".repeat(32),
        session_id: "box-budget-session",
      }),
    },
  };
}

function signAuthority(over: {
  uid?: number;
  containerId?: number;
  authorityTurnId?: string;
  canonicalModel?: string;
  securityEpoch?: number;
  connectionChallenge?: string;
  expiresAt?: number;
  auxModels?: string[];
} = {}): string {
  const now = Date.now();
  const expiresAt = over.expiresAt ?? now + AUTHORITY_TTL_MS;
  const payload: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: KEY_ID,
    uid: over.uid ?? 3,
    containerId: over.containerId ?? 7,
    authorityTurnId: over.authorityTurnId ?? "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    connectionChallenge: over.connectionChallenge ?? "chal-budget",
    canonicalModel: over.canonicalModel ?? MODEL,
    engine: "ccb",
    executionDescriptor: {
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: true, contextOwner: "box-native-v1" },
      },
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
      supportedEfforts: [],
      supportsVision: false,
    },
    executionRevision: "b".repeat(64),
    securityEpoch: over.securityEpoch ?? EPOCH,
    ...(over.auxModels ? { auxModels: over.auxModels } : {}),
    issuedAt: expiresAt - AUTHORITY_TTL_MS,
    expiresAt,
  };
  return encodeAuthorityEnvelope(payload, cryptoSign(null, authoritySigningInput(payload), privateKey));
}

function signLease(over: {
  uid?: number;
  containerId?: number;
  authorityTurnId?: string;
  canonicalModel?: string;
  securityEpoch?: number;
  connectionChallenge?: string;
  expiresAt?: number;
  auxModels?: string[];
} = {}): string {
  const now = Date.now();
  const lease: TurnLease = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: KEY_ID,
    uid: over.uid ?? 3,
    containerId: over.containerId ?? 7,
    authorityTurnId: over.authorityTurnId ?? "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    canonicalModel: over.canonicalModel ?? MODEL,
    securityEpoch: over.securityEpoch ?? EPOCH,
    connectionChallenge: over.connectionChallenge ?? "chal-budget",
    ...(over.auxModels ? { auxModels: over.auxModels } : {}),
    issuedAt: now - 60_000,
    expiresAt: over.expiresAt ?? now + 30 * 60_000,
  };
  return encodeTurnLeaseEnvelope(lease, cryptoSign(null, turnLeaseSigningInput(lease), privateKey));
}

function localToken(over: { securityEpoch?: string; projectionRevision?: string } = {}): string {
  return encodeLocalCatalogToken({
    v: 1,
    kind: "local_catalog",
    projectionRevision: over.projectionRevision ?? "d".repeat(64),
    securityEpoch: over.securityEpoch ?? String(EPOCH),
  });
}

function catalog(canUse = true) {
  const descriptor = {
    canonicalModel: MODEL,
    engine: "ccb",
    providerId: "box_cli",
    upstreamModelId: "claude-opus-5-5",
    contextWindow: 200_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: false, supportsThinking: true, contextOwner: "box-native-v1" },
    },
    capabilitySchemaVersion: 1,
    defaultEffort: null,
  };
  const pricing = {
    model_id: MODEL,
    display_name: "Box",
    input_per_mtok: 1_000_000n,
    output_per_mtok: 400n,
    cache_read_per_mtok: 1n,
    cache_write_per_mtok: 1n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(),
  };
  const snapshot = {
    securityEpoch: BigInt(EPOCH),
    executionRevision: "b".repeat(64),
    billingRevision: "c".repeat(64),
    aliasToCanonical: (model: string) => model,
    resolve: (model: string) => (model === MODEL ? descriptor : null),
    canUseModel: () => canUse,
    billingPricingFor: (model: string) => (model === MODEL ? pricing : null),
    projectionRevisionFor: () => "d".repeat(64),
  };
  return { async assertFresh() { return snapshot; } };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  chunks: Buffer[] = [];
  setHeader(): void {}
  getHeader(): undefined { return undefined; }
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk != null) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
  bodyText(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  json(): { error?: { code?: string } } {
    const text = this.bodyText();
    if (!text || text.startsWith("event:")) return {};
    return JSON.parse(text) as { error?: { code?: string } };
  }
}

function request(payload: Buffer | object, headers: Record<string, string>): IncomingMessage {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = "POST";
  req.url = "/v1/messages";
  req.headers = { host: "127.0.0.1", "x-request-id": headers["x-request-id"], ...headers };
  return req;
}

function sseResponse(): Response {
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_ocv5_296", type: "message", role: "assistant",
        usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta", delta: { type: "text_delta", text: "ok" },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runStep(step: BoxCcExecRequest, from: string, root: string): Promise<void> {
  if (step.command !== "/usr/bin/python3") throw new Error(`refusing non-python exec ${step.command}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(step.command, step.args.map((arg) => arg.replaceAll(from, root)), {
      cwd: step.cwd, env: step.environment,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error((stderr || `exit ${code}`).slice(0, 400))));
  });
}

type StageReceipt = {
  execs: number;
  claudeRunSpawned: boolean;
  publication: { files: number; bytes: number; sha256: string } | null;
};

async function execStage(plan: {
  cwd: string;
  snapshotHash: string | null;
  stageInputs: readonly BoxCcExecRequest[];
  run: BoxCcExecRequest;
  cleanup: BoxCcExecRequest;
}): Promise<StageReceipt> {
  const root = `/tmp/ocv5-296-pipe-${randomBytes(4).toString("hex")}`;
  const from = "/home/box/.claude/projects";
  mkdirSync(root, { mode: 0o700 });
  const runKey = JSON.stringify([plan.run.command, plan.run.args]);
  let claudeRunSpawned = false;
  let execs = 0;
  try {
    for (const step of plan.stageInputs) {
      if (JSON.stringify([step.command, step.args]) === runKey) claudeRunSpawned = true;
      await runStep(step, from, root);
      execs += 1;
    }
    let publication: { files: number; bytes: number; sha256: string } | null = null;
    if (plan.snapshotHash) {
      const projectDir = `${root}/${plan.cwd.replaceAll("/", "-")}`;
      const names = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
      assert.equal(names.length, 1);
      const published = readFileSync(`${projectDir}/${names[0]}`);
      publication = {
        files: names.length,
        bytes: published.length,
        sha256: createHash("sha256").update(published).digest("hex"),
      };
      assert.equal(publication.sha256, plan.snapshotHash);
    }
    await runStep(plan.cleanup, from, root);
    execs += 1;
    return { execs, claudeRunSpawned, publication };
  } finally {
    rmSync(plan.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

function history64(): Record<string, unknown> {
  const messages = rounds(64);
  messages.push({ role: "user", content: [{ type: "text", text: "continue" }] });
  return textBody(messages);
}

async function withPeak<T>(fn: () => Promise<T>): Promise<{
  value: T; elapsedMs: number; sampledPeakRss: number; endRss: number;
  maxRssKbBefore: number; maxRssKbAfter: number;
}> {
  const maxRssKbBefore = process.resourceUsage().maxRSS;
  let sampledPeakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > sampledPeakRss) sampledPeakRss = rss;
  }, 20);
  const started = process.hrtime.bigint();
  try {
    const value = await fn();
    return {
      value,
      elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      sampledPeakRss,
      endRss: process.memoryUsage().rss,
      maxRssKbBefore,
      maxRssKbAfter: process.resourceUsage().maxRSS,
    };
  } finally {
    clearInterval(timer);
  }
}

test("checkout candidate admits 64x128KiB; ready-off and lease-only stay legacy", { timeout: 900_000 }, async () => {
  assert.equal(/^[a-z0-9_]+$/.test(SCHEMA), true);
  const built = buildCandidate();
  const candidateRoot = built.root;
  const offRoot = built.offRoot;

  const candidateMod = await import(join(candidateRoot, "packages/commercial/src/http/proxy/index.ts"));
  const candidateOwnerMod = await import(join(candidateRoot, "packages/commercial/src/http/proxy/boxNativeContextOwner.ts"));
  const candidatePlan = await import(join(candidateRoot, "packages/commercial/src/http/proxy/boxTextPlan.ts"));
  const candidateDb = await import(join(candidateRoot, "packages/commercial/src/db/index.ts"));
  const candidatePre = await import(join(candidateRoot, "packages/commercial/src/billing/preCheck.ts"));
  const offMod = await import(join(offRoot, "packages/commercial/src/http/proxy/index.ts"));
  const offOwnerMod = await import(join(offRoot, "packages/commercial/src/http/proxy/boxNativeContextOwner.ts"));
  const offDb = await import(join(offRoot, "packages/commercial/src/db/index.ts"));
  assert.equal(offOwnerMod.BOX_NATIVE_CONTEXT_ROUTE_READY, false);
  assert.equal(candidateOwnerMod.BOX_NATIVE_CONTEXT_ROUTE_READY, true);
  assert.notEqual(offOwnerMod, candidateOwnerMod);

  const admin = new pg.Pool({ connectionString: TEST_DB, max: 1, application_name: "ocv5-296-c-admin" });
  const pool = new pg.Pool({
    connectionString: TEST_DB,
    max: 4,
    application_name: "ocv5-296-c-pipeline",
    options: `-c search_path=${SCHEMA}`,
  });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  const phases: unknown[] = [];
  const previousBox = process.env.OC_BOX_MODEL_API;
  process.env.OC_BOX_MODEL_API = "1";
  try {
    await assertConnectedTestDatabase(admin);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`
      CREATE TABLE ${SCHEMA}.users (id bigint PRIMARY KEY, credits bigint NOT NULL);
      CREATE TABLE ${SCHEMA}.user_subscriptions (
        id bigint PRIMARY KEY, user_id bigint NOT NULL, period_credits bigint NOT NULL,
        status text NOT NULL, period_end timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT NOW());
      CREATE TABLE ${SCHEMA}.credit_ledger (
        id bigserial PRIMARY KEY, user_id bigint NOT NULL, delta bigint NOT NULL, balance_after bigint NOT NULL,
        reason text NOT NULL, bucket text, ref_type text, ref_id text, memo text, org_id bigint,
        created_at timestamptz NOT NULL DEFAULT NOW());
      CREATE TABLE ${SCHEMA}.usage_records (
        id bigserial PRIMARY KEY, user_id bigint NOT NULL, mode text, account_id bigint, model text,
        input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
        price_snapshot jsonb, cost_credits bigint, session_id text, parent_session_id text,
        delegate_agent_id text, request_id text, status text, org_id bigint,
        execution_revision text, projection_revision text, security_epoch bigint, authority_kind text,
        turn_key text, parent_turn_key text, dispatch_id text, attempt_no integer,
        verification_run_id text, would_have_cost_credits bigint,
        board_project_id text, board_project_source text, board_project_captured_at timestamptz,
        api_key_id bigint, ledger_id bigint, UNIQUE (user_id, request_id));
      CREATE TABLE ${SCHEMA}.request_finalize_journal (
        request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint, state text NOT NULL,
        ctx jsonb, precheck_credits bigint, dispatch_id text, attempt_no integer,
        updated_at timestamptz NOT NULL DEFAULT NOW(), final_credits bigint, ledger_id bigint,
        usage_id bigint, failure_code text, error_msg text);
      CREATE TABLE ${SCHEMA}.authority_turn_dispatches (
        authority_turn_id text PRIMARY KEY, user_id bigint, dispatch_model text, canonical_model text,
        session_id text, dispatch_id text, attempt_no integer);
      CREATE TABLE ${SCHEMA}.turn_dispatches (
        dispatch_id text PRIMARY KEY, user_id bigint, session_id text, model text, attempt_no integer,
        status text, owner_id text, lease_epoch bigint, lease_until timestamptz);
      CREATE TABLE ${SCHEMA}.org_memberships (
        org_id bigint, user_id bigint, status text, billing_enabled boolean, monthly_org_budget bigint);
      CREATE TABLE ${SCHEMA}.orgs (id bigint PRIMARY KEY, credits bigint, status text, updated_at timestamptz);
      CREATE TABLE ${SCHEMA}.org_subscriptions (
        id bigint PRIMARY KEY, org_id bigint, period_credits bigint, status text, period_end timestamptz);
      CREATE TABLE ${SCHEMA}.client_sessions (id text PRIMARY KEY, user_id text, project_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.chat_projects (id text PRIMARY KEY, user_id text, board_project_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.turn_waivers (user_id bigint, turn_key text);
      CREATE TABLE ${SCHEMA}.pending_usage_patches (
        request_id text, user_id text, session_id text, parent_session_id text, delegate_agent_id text,
        turn_key text, parent_turn_key text, cost_credits bigint, PRIMARY KEY (request_id, user_id));
      CREATE TABLE ${SCHEMA}.turn_upstream_performance (
        request_id text PRIMARY KEY, user_id bigint, dispatch_id text, model text, ttft_ms integer,
        stream_ms integer, outcome text, control_plane_release text, control_plane_commit text,
        observed_at timestamptz);
    `);
    await pool.query("INSERT INTO users (id, credits) VALUES (3, 50000000)");
    const regs = await pool.query<{ name: string; schema: string | null }>(`
      SELECT name, (
        SELECT n.nspname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass(name)
      ) AS schema
      FROM unnest(ARRAY['users','user_subscriptions','credit_ledger','usage_records','request_finalize_journal','authority_turn_dispatches','orgs']) AS name
    `);
    for (const row of regs.rows) assert.equal(row.schema, SCHEMA, row.name);
    const publicUsers = await admin.query("SELECT to_regclass('public.users') AS reg");
    assert.equal(publicUsers.rows[0].reg, null);
    const search = await pool.query("SELECT current_setting('search_path') AS path, current_database() AS db");
    assert.equal(search.rows[0].db, "openclaude_test");
    assert.match(String(search.rows[0].path), new RegExp(`^${SCHEMA}(,|$)`));
    const redisPing = await redis.ping();
    assert.equal(redisPing, "PONG");
    const redisDb = await redis.call("CLIENT", "INFO") as string;
    assert.equal(typeof redisDb === "string" && redisDb.includes("db=14"), true, String(redisDb));
    await redis.del("precheck:u:{3}:locks", "precheck:u:{3}:amounts");

    candidateDb.setPoolOverride(pool);
    offDb.setPoolOverride(pool);
    const billingRedis = candidatePre.wrapIoredisForPreCheck(redis);
    const makeDeps = (fetchImpl: (args: Record<string, unknown>) => Promise<Response>, opts: { canUse?: boolean; apiKey?: boolean } = {}) => ({
      pgPool: pool,
      pricing: { get: () => null },
      preCheckRedis: billingRedis,
      scheduler: {},
      identity: {
        async resolve() {
          return {
            uid: 3n,
            containerId: 7n,
            ...(opts.apiKey ? { apiKey: { id: 1n, creditLimit: null, spentCredits: 0n } } : {}),
          };
        },
        async authorize() {},
      },
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set<string>() }),
      rateLimitRedis: { async incr() { return 1; }, async expire() { return 1; } },
      modelCatalog: catalog(opts.canUse !== false),
      modelAuthorityEnforce: true,
      authorityKeyring: () => keyring,
      boxModel: { fetch: fetchImpl },
    });

    async function call(handler: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void>, payload: Buffer | object, headers: Record<string, string>, fetchImpl: (args: Record<string, unknown>) => Promise<Response>) {
      const res = new MockRes();
      let thrown: unknown = null;
      try {
        await handler(request(payload, headers), res as unknown as ServerResponse, { hostUuid: "ocv5-296", boundIp: "127.0.0.1" });
      } catch (error) { thrown = error; }
      return { status: res.statusCode, code: res.json().error?.code ?? null, sse: res.bodyText().includes("event: message_stop"), thrown: thrown instanceof Error ? thrown.message : null };
    }

    const authority = signAuthority();
    const lease = signLease();
    let offFetches = 0;
    const offHandler = offMod.makeAnthropicProxyHandler(makeDeps(async () => {
      offFetches += 1;
      throw new Error("off-fetch");
    }) as never);
    const readyOff = await call(offHandler, history64(), { "x-request-id": "ocv5-296-ready-off", "x-oc-model-authority": authority }, async () => { throw new Error("unused"); });
    const readyOffJournal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = 'ocv5-296-ready-off'");
    phases.push({ phase: "ready-off-64", ...readyOff, fetches: offFetches, journal: readyOffJournal.rows[0].n });
    assert.equal(readyOff.status, 413);
    assert.equal(readyOff.code, "BODY_FIELD_TOO_LARGE");
    assert.equal(offFetches, 0);
    assert.equal(readyOffJournal.rows[0].n, 0);

    let leaseFetches = 0;
    const candidateHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(async (args) => {
      leaseFetches += 1;
      const plan = candidatePlan.makeBoxTextPlan({
        body: (args as { canonicalBody: unknown }).canonicalBody,
        upstreamModel: (args as { upstreamModel: string }).upstreamModel,
        maxOutputTokensLimit: 8192,
        supervisorAsset: supervisor,
        keeperAsset: keeper,
      });
      await execStage(plan);
      return sseResponse();
    }) as never);
    const leaseOnly = await call(candidateHandler, history64(), { "x-request-id": "ocv5-296-lease-only", "x-oc-turn-lease": lease }, async () => { throw new Error("unused"); });
    const leaseJournal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = 'ocv5-296-lease-only'");
    phases.push({ phase: "candidate-lease-only-64", ...leaseOnly, fetches: leaseFetches, journal: leaseJournal.rows[0].n });
    assert.equal(leaseOnly.status, 413);
    assert.equal(leaseOnly.code, "BODY_FIELD_TOO_LARGE");
    assert.equal(leaseFetches, 0);
    assert.equal(leaseJournal.rows[0].n, 0);

    async function positive(requestId: string, payload: Record<string, unknown> | Buffer) {
      let fetches = 0;
      const stageBox: { stage: StageReceipt | null; stageError: string | null } = { stage: null, stageError: null };
      const handler = candidateMod.makeAnthropicProxyHandler(makeDeps(async (args) => {
        fetches += 1;
        const plan = candidatePlan.makeBoxTextPlan({
          body: (args as { canonicalBody: unknown }).canonicalBody,
          upstreamModel: (args as { upstreamModel: string }).upstreamModel,
          maxOutputTokensLimit: 8192,
          supervisorAsset: supervisor,
          keeperAsset: keeper,
        });
        stageBox.stage = await execStage(plan);
        return sseResponse();
      }) as never);
      const measured = await withPeak(() => call(
        handler, payload,
        { "x-request-id": requestId, "x-oc-model-authority": signAuthority() },
        async () => { throw new Error("unused"); },
      ));
      const rows = await pool.query(`
        SELECT j.state, j.final_credits::text AS final_credits,
               ur.id::text AS usage_id, ur.cost_credits::text AS cost_credits, ur.status AS usage_status,
               ur.input_tokens::text AS input_tokens, ur.output_tokens::text AS output_tokens,
               cl.id::text AS ledger_id, cl.delta::text AS delta, cl.reason, cl.bucket
          FROM request_finalize_journal j
          LEFT JOIN usage_records ur ON ur.request_id = j.request_id AND ur.user_id = j.user_id
          LEFT JOIN credit_ledger cl ON cl.id = ur.ledger_id
         WHERE j.request_id = $1`, [requestId]);
      return { requestId, http: measured.value, fetches, stage: stageBox.stage, stageError: stageBox.stageError, measured: {
        elapsedMs: measured.elapsedMs, sampledPeakRss: measured.sampledPeakRss, endRss: measured.endRss,
        maxRssKbBefore: measured.maxRssKbBefore, maxRssKbAfter: measured.maxRssKbAfter,
      }, rows: rows.rows };
    }

    const control = await positive("ocv5-296-control-6k", textBody([{ role: "user", content: "c".repeat(6000) }]));
    phases.push({ phase: "control-6k", ...control, stageError: control.stage ? null : "no-stage" });
    assert.equal(control.http.status, 200, JSON.stringify(control.http));
    assert.equal(control.http.sse, true);
    assert.equal(control.fetches, 1);
    assert.ok(control.stage);
    assert.equal(control.stage.claudeRunSpawned, false);
    assert.ok(control.stage.execs > 0);
    assert.equal(control.rows.length, 1);
    assert.equal(control.rows[0].state, "committed");
    assert.equal(control.rows[0].usage_status, "success");
    assert.equal(control.rows.length === 1 && control.rows[0].ledger_id != null, true);
    assert.ok(BigInt(control.rows[0].delta) < 0n);

    const overMessages = textBody([{ role: "user", content: "m".repeat(16 * 1024 * 1024 + 64) }]);
    let overFetches = 0;
    const overHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(async () => {
      overFetches += 1;
      throw new Error("over-fetch");
    }) as never);
    const over = await withPeak(() => call(overHandler, overMessages, { "x-request-id": "ocv5-296-over-msg", "x-oc-model-authority": signAuthority() }, async () => { throw new Error("unused"); }));
    const overJournal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = 'ocv5-296-over-msg'");
    phases.push({ phase: "over-messages", http: over.value, fetches: overFetches, journal: overJournal.rows[0].n, measured: { elapsedMs: over.elapsedMs, sampledPeakRss: over.sampledPeakRss, endRss: over.endRss, maxRssKbBefore: over.maxRssKbBefore, maxRssKbAfter: over.maxRssKbAfter } });
    assert.equal(over.value.status, 413);
    assert.equal(overFetches, 0);
    assert.equal(overJournal.rows[0].n, 0);

    const raw = Buffer.concat([
      Buffer.from('{"model":"box-api-claude-opus-5-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"'),
      Buffer.alloc(24 * 1024 * 1024, 0x61),
      Buffer.from('"}]}'),
    ]);
    const tooRaw = await call(overHandler, raw, { "x-request-id": "ocv5-296-over-raw", "x-oc-model-authority": signAuthority() }, async () => { throw new Error("unused"); });
    const rawJournal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = 'ocv5-296-over-raw'");
    phases.push({ phase: "over-raw", ...tooRaw, journal: rawJournal.rows[0].n, fetches: overFetches });
    assert.equal(tooRaw.status, 413);
    assert.equal(tooRaw.code, "PAYLOAD_TOO_LARGE");
    assert.equal(rawJournal.rows[0].n, 0);

    const wide = await positive("ocv5-296-64", history64());
    phases.push({ phase: "candidate-64", ...wide });
    assert.equal(wide.http.status, 200, JSON.stringify(wide.http));
    assert.equal(wide.http.sse, true);
    assert.equal(wide.fetches, 1);
    assert.ok(wide.stage?.publication);
    assert.ok((wide.stage?.publication?.bytes ?? 0) > 8 * 1024 * 1024);
    assert.equal(wide.stage?.claudeRunSpawned, false);
    assert.equal(wide.rows[0]?.state, "committed");
    assert.equal(wide.rows.filter((row) => row.ledger_id).length, 1);

    if (!phaseOn("seam")) {
      for (const phase of ["expired-lease-64", "gate-rejects", "local-64", "local-negatives"]) {
        phases.push({ phase, status: "not-run", countsAsPass: false, reason: "OC_V5_296_PIPELINE_SUBSET omitted seam; not PASS" });
      }
    } else {
      const stageFetch = (counter: { n: number }) => async (args: Record<string, unknown>) => {
        counter.n += 1;
        const plan = candidatePlan.makeBoxTextPlan({
          body: (args as { canonicalBody: unknown }).canonicalBody,
          upstreamModel: (args as { upstreamModel: string }).upstreamModel,
          maxOutputTokensLimit: 8192,
          supervisorAsset: supervisor,
          keeperAsset: keeper,
        });
        await execStage(plan);
        return sseResponse();
      };
      const expiredCount = { n: 0 };
      const expiredHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(stageFetch(expiredCount)) as never);
      const expiredHit = await call(expiredHandler, history64(), {
        "x-request-id": "ocv5-296-expired-auth",
        "x-oc-model-authority": signAuthority({ expiresAt: Date.now() - 5_000 }),
        "x-oc-turn-lease": signLease(),
      }, async () => { throw new Error("unused"); });
      const expiredJournal = await pool.query("SELECT state FROM request_finalize_journal WHERE request_id = 'ocv5-296-expired-auth'");
      phases.push({ phase: "expired-lease-64", ...expiredHit, fetches: expiredCount.n, journal: expiredJournal.rows });
      assert.equal(expiredHit.status, 200, JSON.stringify(expiredHit));
      assert.equal(expiredHit.sse, true);
      assert.equal(expiredCount.n, 1);
      assert.equal(expiredJournal.rows[0]?.state, "committed");

      const small = textBody([{ role: "user", content: "hi" }]);
      const rejectHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(async () => { throw new Error("reject-fetch"); }) as never);
      const rejects: Array<{ id: string; headers: Record<string, string>; status: number }> = [
        { id: "bad-uid", status: 403, headers: { "x-oc-model-authority": signAuthority({ uid: 9 }), "x-oc-turn-lease": signLease({ uid: 9 }) } },
        { id: "bad-container", status: 403, headers: { "x-oc-model-authority": signAuthority({ containerId: 9 }), "x-oc-turn-lease": signLease({ containerId: 9 }) } },
        { id: "bad-model", status: 403, headers: { "x-oc-model-authority": signAuthority({ canonicalModel: "claude-sonnet-4-6" }), "x-oc-turn-lease": signLease({ canonicalModel: "claude-sonnet-4-6" }) } },
        { id: "bad-epoch", status: 409, headers: { "x-oc-model-authority": signAuthority({ securityEpoch: 99 }), "x-oc-turn-lease": signLease({ securityEpoch: 99 }) } },
        { id: "bad-challenge", status: 403, headers: { "x-oc-model-authority": signAuthority({ connectionChallenge: "chal-budget" }), "x-oc-turn-lease": signLease({ connectionChallenge: "chal-other" }) } },
        { id: "bad-aux", status: 403, headers: { "x-oc-model-authority": signAuthority({ auxModels: ["deepseek-v4-flash"] }), "x-oc-turn-lease": signLease() } },
        { id: "cross-turn", status: 403, headers: { "x-oc-model-authority": signAuthority(), "x-oc-turn-lease": signLease({ authorityTurnId: "b".repeat(32) }) } },
        { id: "expired-lease", status: 403, headers: { "x-oc-model-authority": signAuthority(), "x-oc-turn-lease": signLease({ expiresAt: Date.now() - 5_000 }) } },
      ];
      const rejectResults = [];
      for (const item of rejects) {
        const hit = await call(rejectHandler, small, { "x-request-id": `ocv5-296-${item.id}`, ...item.headers }, async () => { throw new Error("unused"); });
        const journal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = $1", [`ocv5-296-${item.id}`]);
        assert.equal(hit.status, item.status, `${item.id} ${JSON.stringify(hit)}`);
        assert.equal(journal.rows[0].n, 0, item.id);
        rejectResults.push({ id: item.id, status: hit.status, code: hit.code, journal: journal.rows[0].n });
      }
      phases.push({ phase: "gate-rejects", results: rejectResults });

      const localCount = { n: 0 };
      const localHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(stageFetch(localCount)) as never);
      const localHit = await call(localHandler, history64(), {
        "x-request-id": "ocv5-296-local-64",
        [LOCAL_CATALOG_HEADER]: localToken(),
      }, async () => { throw new Error("unused"); });
      const localJournal = await pool.query("SELECT state FROM request_finalize_journal WHERE request_id = 'ocv5-296-local-64'");
      phases.push({ phase: "local-64", ...localHit, fetches: localCount.n, journal: localJournal.rows });
      assert.equal(localHit.status, 200, JSON.stringify(localHit));
      assert.equal(localCount.n, 1);
      assert.equal(localJournal.rows[0]?.state, "committed");

      const localNegatives = [];
      const negativeCases: Array<{ id: string; status: number; run: () => Promise<{ status: number; code: string | null }> }> = [
        { id: "local-epoch", status: 409, run: () => call(localHandler, small, { "x-request-id": "ocv5-296-local-epoch", [LOCAL_CATALOG_HEADER]: localToken({ securityEpoch: "99" }) }, async () => { throw new Error("unused"); }) },
        { id: "local-projection", status: 409, run: () => call(localHandler, small, { "x-request-id": "ocv5-296-local-projection", [LOCAL_CATALOG_HEADER]: localToken({ projectionRevision: "e".repeat(64) }) }, async () => { throw new Error("unused"); }) },
        { id: "local-revoked", status: 403, run: () => call(candidateMod.makeAnthropicProxyHandler(makeDeps(async () => { throw new Error("revoked-fetch"); }, { canUse: false }) as never), small, { "x-request-id": "ocv5-296-local-revoked", [LOCAL_CATALOG_HEADER]: localToken() }, async () => { throw new Error("unused"); }) },
        { id: "local-apikey", status: 413, run: () => call(candidateMod.makeAnthropicProxyHandler(makeDeps(async () => { throw new Error("apikey-fetch"); }, { apiKey: true }) as never), history64(), { "x-request-id": "ocv5-296-local-apikey", [LOCAL_CATALOG_HEADER]: localToken() }, async () => { throw new Error("unused"); }) },
        { id: "local-ready-off", status: 413, run: () => call(offMod.makeAnthropicProxyHandler(makeDeps(async () => { throw new Error("ready-fetch"); }) as never), history64(), { "x-request-id": "ocv5-296-local-ready-off", [LOCAL_CATALOG_HEADER]: localToken() }, async () => { throw new Error("unused"); }) },
      ];
      for (const item of negativeCases) {
        const hit = await item.run();
        const journal = await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id = $1", [`ocv5-296-${item.id}`]);
        assert.equal(hit.status, item.status, `${item.id} ${JSON.stringify(hit)}`);
        assert.equal(journal.rows[0].n, 0, item.id);
        localNegatives.push({ id: item.id, status: hit.status, code: hit.code, journal: journal.rows[0].n });
      }
      phases.push({ phase: "local-negatives", results: localNegatives });
    }

    if (!phaseOn("matrix")) {
      for (const phase of ["upper-messages", "stdin-8MiB-cap", "concurrent-2x9MiB"]) {
        phases.push({ phase, status: "not-run", countsAsPass: false, reason: "OC_V5_296_PIPELINE_SUBSET omitted matrix; not PASS" });
      }
    } else {
    const historySized = (target: number): { body: Record<string, unknown>; messageBytes: number } => {
      const tail = { role: "user", content: [{ type: "text", text: "continue" }] };
      const messages: unknown[] = [{ role: "user", content: "start" }];
      for (let i = 0; i < 400; i += 1) {
        const id = `toolu_${String(i).padStart(6, "0")}`;
        const round = [
          { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { path: `f${i}` } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(CHUNK) }] },
        ];
        if (Buffer.byteLength(JSON.stringify([...messages, ...round, tail])) > target) break;
        messages.push(...round);
      }
      messages.push(tail);
      return { body: textBody(messages), messageBytes: Buffer.byteLength(JSON.stringify(messages)) };
    };
    const upperBuilt = historySized(16 * 1024 * 1024);
    assert.ok(upperBuilt.messageBytes > 15 * 1024 * 1024 && upperBuilt.messageBytes <= 16 * 1024 * 1024, String(upperBuilt.messageBytes));
    const upper = await positive("ocv5-296-upper", upperBuilt.body);
    phases.push({ phase: "upper-messages", messageBytes: upperBuilt.messageBytes, ...upper });
    assert.equal(upper.http.status, 200, JSON.stringify(upper.http));
    assert.equal(upper.fetches, 1);
    assert.ok((upper.stage?.publication?.bytes ?? 0) > 8 * 1024 * 1024);
    assert.equal(upper.rows[0]?.state, "committed");

    let stdinFetches = 0;
    const stdinHandler = candidateMod.makeAnthropicProxyHandler(makeDeps(async (args) => {
      stdinFetches += 1;
      const plan = candidatePlan.makeBoxTextPlan({
        body: (args as { canonicalBody: unknown }).canonicalBody,
        upstreamModel: (args as { upstreamModel: string }).upstreamModel,
        maxOutputTokensLimit: 8192,
        supervisorAsset: supervisor,
        keeperAsset: keeper,
      });
      await execStage(plan);
      return sseResponse();
    }) as never);
    const stdinOver = await call(stdinHandler, textBody([{ role: "user", content: "s".repeat(9 * 1024 * 1024) }]), {
      "x-request-id": "ocv5-296-stdin-cap", "x-oc-model-authority": signAuthority(),
    }, async () => { throw new Error("unused"); });
    const stdinJournal = await pool.query("SELECT state, (SELECT count(*)::int FROM usage_records ur WHERE ur.request_id = request_finalize_journal.request_id) AS usage_n FROM request_finalize_journal WHERE request_id = 'ocv5-296-stdin-cap'");
    phases.push({ phase: "stdin-8MiB-cap", ...stdinOver, fetches: stdinFetches, journal: stdinJournal.rows });
    assert.notEqual(stdinOver.status, 200);
    assert.notEqual(stdinOver.status, 413);
    assert.equal(stdinFetches, 1);
    assert.equal(stdinJournal.rows[0]?.state, "aborted");
    assert.equal(Number(stdinJournal.rows[0]?.usage_n ?? 0), 0);

    const nine = historySized(9 * 1024 * 1024);
    const concurrent = await withPeak(() => Promise.all([
      positive("ocv5-296-conc-a", structuredClone(nine.body)),
      positive("ocv5-296-conc-b", structuredClone(nine.body)),
    ]));
    phases.push({
      phase: "concurrent-2x9MiB",
      elapsedMs: concurrent.elapsedMs,
      sampledPeakRss: concurrent.sampledPeakRss,
      endRss: concurrent.endRss,
      maxRssKbBefore: concurrent.maxRssKbBefore,
      maxRssKbAfter: concurrent.maxRssKbAfter,
      a: { status: concurrent.value[0].http.status, state: concurrent.value[0].rows[0]?.state, execs: concurrent.value[0].stage?.execs, bytes: concurrent.value[0].stage?.publication?.bytes },
      b: { status: concurrent.value[1].http.status, state: concurrent.value[1].rows[0]?.state, execs: concurrent.value[1].stage?.execs, bytes: concurrent.value[1].stage?.publication?.bytes },
    });
    assert.equal(concurrent.value[0].http.status, 200, JSON.stringify(concurrent.value[0].http));
    assert.equal(concurrent.value[1].http.status, 200, JSON.stringify(concurrent.value[1].http));
    assert.equal(concurrent.value[0].rows[0]?.state, "committed");
    assert.equal(concurrent.value[1].rows[0]?.state, "committed");
    }

    const redisLeft = await redis.exists("precheck:u:{3}:locks", "precheck:u:{3}:amounts");
    const report = {
      source: "git-archive-HEAD",
      groups: { core: "ran", matrix: phaseOn("matrix") ? "ran" : "not-run", seam: phaseOn("seam") ? "ran" : "not-run" },
      schema: SCHEMA,
      database: "openclaude_test",
      port: 55432,
      redis: "127.0.0.1:56379 db 14",
      subset: [...SUBSET],
      archiveOwnerHash: built.archiveOwnerHash,
      onOwnerHash: built.onOwnerHash,
      offOwnerHash: built.offOwnerHash,
      offModuleReady: offOwnerMod.BOX_NATIVE_CONTEXT_ROUTE_READY,
      candidateDiff: "ready literal only",
      autoCompactChanged: built.autoCompactChanged,
      autoCompactSourceUnchanged: built.autoCompactSourceUnchanged,
      redisClientInfoHasDb: typeof redisDb === "string" ? redisDb.includes("db=15") : null,
      redisKeysRemaining: redisLeft,
      resolution: built.resolution,
      phases,
    };
    const explicit = process.env.OC_V5_296_PIPELINE_REPORT;
    if (explicit && explicit.endsWith("ocv5-296-c-pipeline-raw.json")) {
      throw new Error("refusing to overwrite the historical raw receipt");
    }
    const reportFile = explicit && explicit.length > 0
      ? explicit
      : join(tmpdir(), `ocv5-296-pipeline-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(reportFile, JSON.stringify(report, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    console.log(JSON.stringify({ event: "ocv5-296-pipeline-report", reportFile }));
    console.log(JSON.stringify({ event: "ocv5-296-pipeline-summary", phases: phases.map((phase) => {
      const row = phase as { phase?: string; http?: { status?: number; code?: string }; status?: number; fetches?: number; journal?: number };
      return { phase: row.phase, status: row.http?.status ?? row.status, code: row.http?.code, fetches: row.fetches, journal: row.journal };
    }) }));
  } finally {
    const cleanupErrors: string[] = [];
    const fail = async (label: string, fn: () => unknown) => {
      try { await fn(); } catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    if (previousBox === undefined) delete process.env.OC_BOX_MODEL_API;
    else process.env.OC_BOX_MODEL_API = previousBox;
    await fail("redis-del", () => redis.del("precheck:u:{3}:locks", "precheck:u:{3}:amounts"));
    await fail("redis-quit", () => redis.quit());
    await fail("reset-pool", () => candidateDb.resetPool());
    await fail("drop-schema", () => admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
    await fail("admin-end", () => admin.end());
    await fail("candidate-rm", () => { rmSync(candidateRoot, { recursive: true, force: true }); });
    await fail("off-rm", () => { rmSync(offRoot, { recursive: true, force: true }); });
    if (existsSync(candidateRoot)) cleanupErrors.push("candidate-rm: directory still exists");
    if (existsSync(offRoot)) cleanupErrors.push("off-rm: directory still exists");
    if (!existsSync(join(CHECKOUT_ROOT, "node_modules/pg"))) cleanupErrors.push("checkout pg missing after cleanup");
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  }
});

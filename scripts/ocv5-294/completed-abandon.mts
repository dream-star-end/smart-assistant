/** OCV5-294 one-shot operator.
 * Releases capacity for two already-proven worker_complete runs.
 * Does not settle, refund, exempt, or invent usage. Default mode is dry-run.
 * Production apply is a separate, explicitly approved invocation.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { PoolClient } from "pg";

export const PINNED_SOURCE_COMMIT = "817c694099a8f8e8d07a06d2670fc1148d1c9373";
export const DEFAULT_RELEASE_DIR =
  "/opt/openclaude/openclaude-v5-selfhost-releases/rel-817c69409-20260928-163445";
export const ABANDON_STATE = "operator_completed_abandoned";
export const REQUIRED_AUTHORIZATION = "旧运行该停就停";
export const MOVED_POINTER_KEYS = [
  "boxToolHandoff",
  "boxReplayMessage",
  "boxNativePointer",
  "boxNativeSessionId",
  "boxNativeCliCwd",
  "boxNativeClaimRequestId",
  "boxNativeOwnerRequestId",
  "boxResumeRequestId",
  "boxResumeRevision",
  "boxResumeResultHashes",
  "boxParentResumeRevision",
  "boxOwnerRequestId",
  "boxHandoffRevision",
] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^ocv5-294-[0-9a-f]{16,64}$/;

export class AbandonError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AbandonError"; }
}

export type SchemaName = "public" | "pg_temp";
type QueryClient = Pick<PoolClient, "query">;
type Ctx = Record<string, unknown>;

export interface SettledLeg {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCredits: string;
  ledgerId: string;
  ledgerDelta: string;
}
export interface RunManifest {
  nonce: string;
  epoch: string;
  rootRequestId: string;
  leafRequestId: string;
  uid: "3";
  accountId: "20";
  containerId: string;
  sessionId: string;
  turnKey: string;
  model: "box-api-claude-opus-5-5";
  catalogHash: string;
  runnerHash: string;
  reuseCancelIntent: boolean;
  settled: [SettledLeg, SettledLeg];
  unsettledStopReasons: ["tool_use", "end_turn"];
}
export interface ProofShape {
  cliPid: number;
  keeperPid: number;
  leaseEpoch: string;
  reason: "worker_complete";
  revision: 1;
  runNonce: string;
}
export interface AbandonManifest {
  sourceCommit: string;
  authorization: { v: 1; statement: typeof REQUIRED_AUTHORIZATION; ticket: "OCV5-294" };
  runs: RunManifest[];
  proofs: Record<string, ProofShape>;
}
export interface ApplyApproval {
  approvedSha: string;
  operationId: string;
  nonces: readonly string[];
}

type ReleaseModule = {
  parseBoxTerminalProof: (raw: string, expected: { runNonce: string; leaseEpoch: string }) => ProofShape;
  readBoxTerminalProof: (input: {
    target: { accountId: bigint; exec: { run: (request: unknown, opts: unknown) => Promise<{ stdout: string }> }; dispose?: () => Promise<void> };
    expectedAccountId: bigint;
    runNonce: string;
    leaseEpoch: string;
    signal?: AbortSignal;
  }) => Promise<ProofShape>;
  BoxDurableJournal: new (pool: { connect: () => Promise<{ query: QueryClient["query"]; release: () => void }>; query?: QueryClient["query"] }) => {
    recordUserCancelIntent: (input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string }) => Promise<void>;
  };
};

let releaseCache: { dir: string; href: { proof: string; journal: string }; mod: ReleaseModule } | null = null;

export function releasePaths(releaseDir = process.env.OC_OCV5_294_RELEASE ?? DEFAULT_RELEASE_DIR) {
  const proof = join(releaseDir, "packages/commercial/src/http/proxy/boxTerminalProof.ts");
  const journal = join(releaseDir, "packages/commercial/src/http/proxy/boxDurableJournal.ts");
  return {
    releaseDir,
    proofHref: pathToFileURL(proof).href,
    journalHref: pathToFileURL(journal).href,
  };
}

export async function loadRelease(releaseDir = process.env.OC_OCV5_294_RELEASE ?? DEFAULT_RELEASE_DIR) {
  if (releaseCache && releaseCache.dir === releaseDir) return releaseCache;
  const paths = releasePaths(releaseDir);
  if (!paths.proofHref.includes("rel-817c69409-20260928-163445")
    || !paths.journalHref.includes("rel-817c69409-20260928-163445")) {
    throw new AbandonError("RELEASE_MISMATCH");
  }
  const proof = await import(paths.proofHref);
  const journal = await import(paths.journalHref);
  const mod: ReleaseModule = {
    parseBoxTerminalProof: proof.parseBoxTerminalProof,
    readBoxTerminalProof: proof.readBoxTerminalProof,
    BoxDurableJournal: journal.BoxDurableJournal,
  };
  releaseCache = { dir: releaseDir, href: { proof: paths.proofHref, journal: paths.journalHref }, mod };
  return releaseCache;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function table(schema: SchemaName, name: "request_finalize_journal" | "usage_records" | "credit_ledger"): string {
  if (schema !== "public" && schema !== "pg_temp") throw new AbandonError("SCHEMA_FORBIDDEN");
  if (name !== "request_finalize_journal" && name !== "usage_records" && name !== "credit_ledger") {
    throw new AbandonError("SCHEMA_FORBIDDEN");
  }
  return `${schema}.${name}`;
}

export function advisoryKeys(input: { accountId: string; fingerprints: string[]; uid: string; sessionId: string }): string[] {
  return [
    `box:account:${input.accountId}`,
    ...[...input.fingerprints].sort().map((fingerprint) => `box:fingerprint:${fingerprint}`),
    `box:session:${input.uid}:${input.sessionId}`,
  ];
}

export function assertApproved(manifest: AbandonManifest, approval: ApplyApproval | null): void {
  if (manifest.sourceCommit !== PINNED_SOURCE_COMMIT) throw new AbandonError("RELEASE_MISMATCH");
  if (manifest.authorization.statement !== REQUIRED_AUTHORIZATION
    || manifest.authorization.ticket !== "OCV5-294" || manifest.authorization.v !== 1) {
    throw new AbandonError("AUTHORIZATION_MISSING");
  }
  if (!approval) throw new AbandonError("APPROVAL_REQUIRED");
  if (approval.approvedSha !== PINNED_SOURCE_COMMIT) throw new AbandonError("APPROVAL_REQUIRED");
  if (!OPERATION_ID.test(approval.operationId)) throw new AbandonError("APPROVAL_REQUIRED");
  const expected = manifest.runs.map((run) => run.nonce).sort();
  const given = [...approval.nonces].sort();
  if (expected.length !== given.length || expected.some((nonce, index) => nonce !== given[index])
    || new Set(given).size !== given.length) {
    throw new AbandonError("APPROVAL_REQUIRED");
  }
}

export function productionResolveArgs(run: { uid: bigint; accountId: bigint; nonce: string }, signal: AbortSignal) {
  if (run.uid !== 3n || run.accountId !== 20n || !/^[0-9a-f]{24}$/.test(run.nonce)) {
    throw new AbandonError("IDENTITY_MISMATCH");
  }
  return {
    uid: 3n,
    sessionId: null as null,
    requestId: `ocv5-294-proof-${run.nonce}`,
    upstreamModel: "claude-opus-5-5" as const,
    requiredAccountId: 20n,
    allowWakeIfHibernated: false as const,
    signal,
  };
}

export async function readPinnedProductionProof(run: { nonce: string; epoch: string },
  deps: { resolve: (args: ReturnType<typeof productionResolveArgs>) => Promise<{
    accountId: bigint;
    exec: { run: (request: unknown, opts: unknown) => Promise<{ stdout: string }> };
    dispose?: () => Promise<void>;
  }> }) {
  const loaded = await loadRelease();
  const abort = new AbortController();
  const args = productionResolveArgs({ uid: 3n, accountId: 20n, nonce: run.nonce }, abort.signal);
  if (args.allowWakeIfHibernated !== false || args.requiredAccountId !== 20n
    || args.upstreamModel !== "claude-opus-5-5" || "containerId" in args) {
    throw new AbandonError("RESOLVER_FENCE");
  }
  const target = await deps.resolve(args);
  try {
    if (target.accountId !== 20n) throw new AbandonError("IDENTITY_MISMATCH");
    return await loaded.mod.readBoxTerminalProof({
      target, expectedAccountId: 20n, runNonce: run.nonce, leaseEpoch: run.epoch, signal: abort.signal,
    });
  } finally {
    await target.dispose?.();
  }
}

function parseProof(mod: ReleaseModule, proof: ProofShape, run: RunManifest): ProofShape {
  let parsed: ProofShape;
  try {
    parsed = mod.parseBoxTerminalProof(`${JSON.stringify(proof)}\n`, {
      runNonce: run.nonce, leaseEpoch: run.epoch,
    });
  } catch { throw new AbandonError("PROOF_MISMATCH"); }
  if (parsed.reason !== "worker_complete" || parsed.revision !== 1
    || parsed.runNonce !== run.nonce || parsed.leaseEpoch !== run.epoch) {
    throw new AbandonError("PROOF_MISMATCH");
  }
  return parsed;
}

function validIntent(value: unknown, leafRequestId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return Object.keys(intent).sort().join(",") === "atMs,reason,requestId,v"
    && intent.v === 1 && intent.reason === "user_cancel"
    && intent.requestId === leafRequestId
    && Number.isSafeInteger(intent.atMs) && Number(intent.atMs) > 0;
}

interface JournalRow {
  request_id: string;
  user_id: string;
  container_id: string | null;
  state: string;
  precheck_credits: string | null;
  final_credits: string | null;
  ledger_id: string | null;
  usage_id: string | null;
  ctx: Ctx;
}

async function selectPair(client: QueryClient, schema: SchemaName, run: RunManifest): Promise<JournalRow[]> {
  const found = await client.query<JournalRow>(
    `SELECT request_id, user_id::text, container_id::text, state,
        precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx
      FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxAccountId' = $2 AND ctx->>'boxRunNonce' = $3
      ORDER BY request_id`,
    [run.uid, run.accountId, run.nonce]);
  return found.rows;
}

function sharedIdentity(ctx: Ctx, run: RunManifest): boolean {
  return ctx.boxAccountId === run.accountId
    && ctx.boxRunNonce === run.nonce
    && ctx.boxLeaseEpoch === run.epoch
    && ctx.boxSessionId === run.sessionId
    && ctx.boxTurnKey === run.turnKey
    && ctx.model === run.model
    && ctx.boxCatalogHash === run.catalogHash
    && ctx.boxDetachedRunnerHash === run.runnerHash
    && ctx.boxInvocationRecovery === "v1"
    && ctx.boxInvocationMode === "detached_tool"
    && HEX_64.test(String(ctx.boxReplayFingerprint ?? ""))
    && HEX_64.test(String(ctx.boxFallbackAlias ?? ""))
    && HEX_64.test(String(ctx.boxRequestHash ?? ""))
    && HEX_64.test(String(ctx.boxContextHash ?? ""));
}

function chainHolds(root: JournalRow, leaf: JournalRow, run: RunManifest): boolean {
  const revision = root.ctx.boxResumeRevision;
  return root.request_id === run.rootRequestId
    && leaf.request_id === run.leafRequestId
    && root.ctx.boxState === "resuming"
    && leaf.ctx.boxState === "handoff"
    && root.ctx.boxResumeRequestId === leaf.request_id
    && leaf.ctx.boxOwnerRequestId === root.request_id
    && root.ctx.boxOwnerRequestId === undefined
    && leaf.ctx.boxResumeRequestId === undefined
    && typeof revision === "string" && UUID_V4.test(revision)
    && revision === leaf.ctx.boxParentResumeRevision
    && typeof root.ctx.boxHandoffRevision === "string" && UUID_V4.test(root.ctx.boxHandoffRevision)
    && typeof leaf.ctx.boxHandoffRevision === "string" && UUID_V4.test(leaf.ctx.boxHandoffRevision)
    && root.ctx.boxToolHandoff !== undefined && leaf.ctx.boxToolHandoff !== undefined
    && root.ctx.boxReplayMessage !== undefined && leaf.ctx.boxReplayMessage !== undefined
    && root.ctx.boxTerminalProof === undefined && leaf.ctx.boxTerminalProof === undefined
    && root.ctx.boxUsage === undefined && leaf.ctx.boxUsage === undefined;
}

function financialSnapshot(row: JournalRow) {
  return {
    precheckCredits: row.precheck_credits,
    finalCredits: row.final_credits,
    ledgerId: row.ledger_id,
    usageId: row.usage_id,
  };
}

function usageOf(handoff: unknown): Record<string, unknown> | null {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const usage = (handoff as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return usage as Record<string, unknown>;
}

async function assertUsageTables(client: QueryClient, schema: SchemaName, run: RunManifest) {
  const usage = await client.query<{ request_id: string; input_tokens: string; output_tokens: string;
    cache_read_tokens: string; cache_write_tokens: string; cost_credits: string; ledger_id: string }>(
    `SELECT request_id, input_tokens::text, output_tokens::text, cache_read_tokens::text,
        cache_write_tokens::text, cost_credits::text, ledger_id::text
      FROM ${table(schema, "usage_records")}
      WHERE user_id = $1 AND request_id = ANY($2::text[])
      ORDER BY request_id`,
    [run.uid, [run.rootRequestId, run.leafRequestId]]);
  if (usage.rows.length !== 2) throw new AbandonError("ACCOUNTING_MISMATCH");
  const ledger = await client.query<{ id: string; delta: string }>(
    `SELECT id::text, delta::text FROM ${table(schema, "credit_ledger")}
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [usage.rows.map((row) => row.ledger_id)]);
  if (ledger.rows.length !== 2) throw new AbandonError("ACCOUNTING_MISMATCH");
  for (const expected of run.settled) {
    const recorded = usage.rows.find((item) => item.request_id === expected.requestId);
    const entry = ledger.rows.find((item) => item.id === expected.ledgerId);
    if (!recorded || !entry
      || recorded.input_tokens !== String(expected.inputTokens)
      || recorded.output_tokens !== String(expected.outputTokens)
      || recorded.cache_read_tokens !== String(expected.cacheReadTokens)
      || recorded.cache_write_tokens !== String(expected.cacheWriteTokens)
      || recorded.cost_credits !== expected.costCredits
      || recorded.ledger_id !== expected.ledgerId
      || entry.delta !== expected.ledgerDelta) {
      throw new AbandonError("ACCOUNTING_MISMATCH");
    }
  }
}

function assertHandoffUsage(rows: JournalRow[], run: RunManifest) {
  for (const expected of run.settled) {
    const handoffUsage = usageOf(rows.find((row) => row.request_id === expected.requestId)?.ctx.boxToolHandoff);
    if (!handoffUsage
      || Number(handoffUsage.inputTokens) !== expected.inputTokens
      || Number(handoffUsage.outputTokens) !== expected.outputTokens
      || Number(handoffUsage.cacheReadTokens) !== expected.cacheReadTokens
      || Number(handoffUsage.cacheWriteTokens) !== expected.cacheWriteTokens) {
      throw new AbandonError("ACCOUNTING_MISMATCH");
    }
  }
}

function postcondition(row: JournalRow, before: JournalRow, run: RunManifest, operationId: string, proof: ProofShape): boolean {
  const audit = row.ctx.boxOperatorAudit as Record<string, unknown> | undefined;
  if (!audit || audit.v !== 1 || audit.operationId !== operationId || audit.proof === undefined) return false;
  const moved = audit.movedPointers as Record<string, unknown> | undefined;
  if (!moved) return false;
  const liveMoved = MOVED_POINTER_KEYS.some((key) => row.ctx[key] !== undefined);
  const financial = audit.financial as Record<string, unknown> | undefined;
  const snapshot = financialSnapshot(row);
  return row.state === "committed"
    && row.ctx.boxState === ABANDON_STATE
    && !liveMoved
    && row.ctx.boxReplayFingerprint === before.ctx.boxReplayFingerprint
    && row.ctx.boxFallbackAlias === before.ctx.boxFallbackAlias
    && sharedIdentity(row.ctx, run)
    && validIntent(row.ctx.boxCancelIntent, run.leafRequestId)
    && audit.originalCtxSha256 === sha256(canonicalJson(before.ctx))
    && canonicalJson(audit.proof) === canonicalJson(proof)
    && (audit.unsettled as { preserved?: boolean; backfill?: boolean } | undefined)?.preserved === true
    && (audit.unsettled as { backfill?: boolean }).backfill === false
    && String(financial?.precheckCredits) === String(snapshot.precheckCredits)
    && String(financial?.finalCredits) === String(snapshot.finalCredits)
    && String(financial?.ledgerId) === String(snapshot.ledgerId)
    && String(financial?.usageId) === String(snapshot.usageId);
}

function alreadyApplied(rows: JournalRow[], run: RunManifest, operationId: string, proof: ProofShape): boolean {
  if (rows.length !== 2) return false;
  return rows.every((row) => {
    const audit = row.ctx.boxOperatorAudit as { originalCtxSha256?: string; movedPointers?: Ctx } | undefined;
    if (row.state !== "committed" || row.ctx.boxState !== ABANDON_STATE || !audit?.movedPointers) return false;
    const restored: Ctx = { ...row.ctx, ...audit.movedPointers, boxState: row.request_id === run.rootRequestId ? "resuming" : "handoff" };
    delete restored.boxOperatorAudit;
    if (sha256(canonicalJson(restored)) !== audit.originalCtxSha256) return false;
    const synthetic = { ...row, ctx: restored };
    return postcondition(row, synthetic, run, operationId, proof);
  });
}

async function lockPair(client: QueryClient, schema: SchemaName, run: RunManifest): Promise<JournalRow[]> {
  const preview = await selectPair(client, schema, run);
  if (preview.length !== 2) throw new AbandonError(preview.length > 2 ? "SUCCESSOR_PRESENT" : "IDENTITY_MISMATCH");
  const fingerprints = preview.map((row) => String(row.ctx.boxReplayFingerprint));
  const keys = advisoryKeys({
    accountId: run.accountId, fingerprints, uid: run.uid, sessionId: run.sessionId,
  });
  const expectedOrder = [...keys].sort();
  if (keys.some((key, index) => key !== expectedOrder[index])) throw new AbandonError("LOCK_ORDER");
  for (const key of expectedOrder) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
  }
  const locked = await client.query<JournalRow>(
    `SELECT request_id, user_id::text, container_id::text, state,
        precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx
      FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxAccountId' = $2 AND ctx->>'boxRunNonce' = $3
      ORDER BY request_id
      FOR UPDATE`,
    [run.uid, run.accountId, run.nonce]);
  return locked.rows;
}

function buildCtx(row: JournalRow, run: RunManifest, operationId: string, proof: ProofShape): Ctx {
  const moved: Ctx = {};
  const next: Ctx = { ...row.ctx };
  for (const key of MOVED_POINTER_KEYS) {
    if (Object.hasOwn(next, key)) {
      moved[key] = next[key];
      delete next[key];
    }
  }
  next.boxState = ABANDON_STATE;
  next.boxOperatorAudit = {
    v: 1,
    kind: "completed_abandoned",
    operationId,
    authorization: { v: 1, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-294" },
    proof,
    unsettled: {
      preserved: true,
      backfill: false,
      exempt: false,
      inventZeroUsage: false,
      settledMessageCount: 2,
      unsettledMessageCount: 2,
      unsettledStopReasons: run.unsettledStopReasons,
      settledCredits: run.settled.map((leg) => ({
        requestId: leg.requestId, costCredits: leg.costCredits, ledgerDelta: leg.ledgerDelta,
      })),
    },
    movedPointers: moved,
    originalCtxSha256: sha256(canonicalJson(row.ctx)),
    financial: financialSnapshot(row),
    capacityReleased: true,
    cleanupEligible: false,
    deliverySucceeded: false,
  };
  return next;
}

export interface RunResult {
  nonce: string;
  status: "review" | "applied" | "already_applied";
  requestIds: string[];
  cancelIntent: "reuse" | "record";
}

export async function reviewRun(client: QueryClient, schema: SchemaName, manifest: AbandonManifest,
  run: RunManifest): Promise<RunResult> {
  const loaded = await loadRelease();
  const proof = parseProof(loaded.mod, manifest.proofs[run.nonce]!, run);
  const rows = await selectPair(client, schema, run);
  assertReady(rows, run, proof, { requireIntent: run.reuseCancelIntent });
  assertHandoffUsage(rows, run);
  await assertUsageTables(client, schema, run);
  return {
    nonce: run.nonce, status: "review", requestIds: rows.map((row) => row.request_id),
    cancelIntent: run.reuseCancelIntent ? "reuse" : "record",
  };
}

function assertReady(rows: JournalRow[], run: RunManifest, _proof: ProofShape, opts: { requireIntent: boolean }) {
  if (rows.length !== 2) throw new AbandonError(rows.length > 2 ? "SUCCESSOR_PRESENT" : "IDENTITY_MISMATCH");
  const root = rows.find((row) => row.request_id === run.rootRequestId);
  const leaf = rows.find((row) => row.request_id === run.leafRequestId);
  if (!root || !leaf || rows.some((row) => row.request_id !== root.request_id && row.request_id !== leaf.request_id)) {
    throw new AbandonError("SUCCESSOR_PRESENT");
  }
  if (root.user_id !== run.uid || leaf.user_id !== run.uid
    || root.container_id !== run.containerId || leaf.container_id !== run.containerId
    || root.state !== "committed" || leaf.state !== "committed"
    || !sharedIdentity(root.ctx, run) || !sharedIdentity(leaf.ctx, run)
    || root.ctx.boxContextHash === leaf.ctx.boxContextHash
    || root.ctx.boxReplayFingerprint === leaf.ctx.boxReplayFingerprint) {
    throw new AbandonError("IDENTITY_MISMATCH");
  }
  if (!chainHolds(root, leaf, run)) throw new AbandonError("CHAIN_MISMATCH");
  const rootIntent = validIntent(root.ctx.boxCancelIntent, run.leafRequestId);
  const leafIntent = validIntent(leaf.ctx.boxCancelIntent, run.leafRequestId);
  if (opts.requireIntent) {
    if (!rootIntent || !leafIntent
      || canonicalJson(root.ctx.boxCancelIntent) !== canonicalJson(leaf.ctx.boxCancelIntent)) {
      throw new AbandonError("CANCEL_INTENT_CONFLICT");
    }
  } else if (root.ctx.boxCancelIntent !== undefined || leaf.ctx.boxCancelIntent !== undefined) {
    throw new AbandonError("CANCEL_INTENT_CONFLICT");
  }
}

export async function applyRun(client: QueryClient, schema: SchemaName, manifest: AbandonManifest,
  run: RunManifest, approval: ApplyApproval, opts: {
    freshProof: ProofShape;
    journal?: { recordUserCancelIntent: (input: { requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string }) => Promise<void> };
    afterFirstUpdate?: (client: QueryClient) => Promise<void>;
    writeReceipt?: (receipt: Record<string, unknown>) => Promise<void> | void;
  }): Promise<RunResult> {
  assertApproved(manifest, approval);
  if (!approval.nonces.includes(run.nonce)) throw new AbandonError("APPROVAL_REQUIRED");
  const loaded = await loadRelease();
  const manifestProof = parseProof(loaded.mod, manifest.proofs[run.nonce]!, run);
  const fresh = parseProof(loaded.mod, opts.freshProof, run);
  if (canonicalJson(manifestProof) !== canonicalJson(fresh)) throw new AbandonError("PROOF_MISMATCH");
  if (!run.reuseCancelIntent) {
    const journal = opts.journal ?? new loaded.mod.BoxDurableJournal({
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    });
    await journal.recordUserCancelIntent({
      requestId: run.leafRequestId, uid: 3n, accountId: 20n,
      runNonce: run.nonce, leaseEpoch: run.epoch,
    });
  }
  await client.query("BEGIN");
  let committed = false;
  try {
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const locked = await lockPair(client, schema, run);
    await assertUsageTables(client, schema, run);
    if (alreadyApplied(locked, run, approval.operationId, fresh)) {
      await client.query("COMMIT");
      committed = true;
      return { nonce: run.nonce, status: "already_applied",
        requestIds: locked.map((row) => row.request_id),
        cancelIntent: run.reuseCancelIntent ? "reuse" : "record" };
    }
    if (locked.some((row) => row.ctx.boxState === ABANDON_STATE)) throw new AbandonError("PARTIAL_ABANDON");
    assertReady(locked, run, fresh, { requireIntent: true });
    assertHandoffUsage(locked, run);
    const before = locked.map((row) => ({ ...row, ctx: row.ctx }));
    for (let index = 0; index < locked.length; index += 1) {
      if (index === 1 && opts.afterFirstUpdate) await opts.afterFirstUpdate(client);
      const row = locked[index]!;
      const next = buildCtx(row, run, approval.operationId, fresh);
      const changed = await client.query(
        `UPDATE ${table(schema, "request_finalize_journal")}
            SET ctx = $4::jsonb, updated_at = NOW()
          WHERE request_id = $1 AND user_id = $2 AND state = 'committed'
            AND container_id::text = $3 AND ctx = $5::jsonb`,
        [row.request_id, run.uid, run.containerId, JSON.stringify(next), JSON.stringify(row.ctx)]);
      if (changed.rowCount !== 1) throw new AbandonError("CAS_LOST");
    }
    const after = await selectPair(client, schema, run);
    if (after.length !== 2 || after.some((row) => {
      const prior = before.find((item) => item.request_id === row.request_id);
      return !prior || !postcondition(row, prior, run, approval.operationId, fresh);
    })) throw new AbandonError("CAS_LOST");
    await opts.writeReceipt?.({
      operationId: approval.operationId,
      nonce: run.nonce,
      sourceCommit: PINNED_SOURCE_COMMIT,
      proof: fresh,
      financial: before.map(financialSnapshot),
      originalCtxSha256: before.map((row) => sha256(canonicalJson(row.ctx))),
      originalCtx: before.map((row) => row.ctx),
      unsettledPreserved: true,
      productionWrite: "journal-capacity-only",
    });
    await client.query("COMMIT");
    committed = true;
    return { nonce: run.nonce, status: "applied", requestIds: after.map((row) => row.request_id),
      cancelIntent: run.reuseCancelIntent ? "reuse" : "record" };
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
  }
}

export function manifestFromEvidence(proofDocument: {
  sourceCommit?: string;
  rows: Array<Record<string, unknown>>;
  remote: Array<{ nonce: string; proof: ProofShape }>;
}, accounting: {
  runs: Array<{ nonce: string; sha256: string; bytes: number; eof: boolean;
    messages: Array<{ stopReason: string | null; complete: boolean }> }>;
  rows: Array<{ request_id: string; nonce: string; epoch: string; session: string;
    runner_hash: string; handoff: { catalogHash: string; roundNo: number; usage: SettledLeg } }>;
  usage: Array<Record<string, string | null>>;
  ledger: Array<{ id: string; delta: string }>;
}): AbandonManifest {
  if (proofDocument.sourceCommit !== PINNED_SOURCE_COMMIT) throw new AbandonError("RELEASE_MISMATCH");
  const runs: RunManifest[] = [];
  const proofs: Record<string, ProofShape> = {};
  for (const remote of proofDocument.remote) {
    const group = proofDocument.rows.filter((row) => row.nonce === remote.nonce);
    const root = group.find((row) => row.box_state === "resuming");
    const leaf = group.find((row) => row.box_state === "handoff");
    const spool = accounting.runs.find((run) => run.nonce === remote.nonce);
    if (!root || !leaf || group.length !== 2 || !spool || spool.eof !== true || spool.messages.length !== 4) {
      throw new AbandonError("IDENTITY_MISMATCH");
    }
    if (spool.messages[2]?.stopReason !== "tool_use" || spool.messages[3]?.stopReason !== "end_turn"
      || spool.messages.some((message) => message.complete !== true)) {
      throw new AbandonError("ACCOUNTING_MISMATCH");
    }
    const settled = [root, leaf].map((row) => {
      const detail = accounting.rows.find((item) => item.request_id === row.request_id);
      const usage = accounting.usage.find((item) => item.request_id === row.request_id);
      const ledger = accounting.ledger.find((item) => String(item.id) === String(usage?.ledger_id));
      if (!detail || !usage || !ledger || detail.nonce !== remote.nonce) throw new AbandonError("ACCOUNTING_MISMATCH");
      return {
        requestId: String(row.request_id),
        inputTokens: detail.handoff.usage.inputTokens,
        outputTokens: detail.handoff.usage.outputTokens,
        cacheReadTokens: detail.handoff.usage.cacheReadTokens,
        cacheWriteTokens: detail.handoff.usage.cacheWriteTokens,
        costCredits: String(usage.cost_credits),
        ledgerId: String(usage.ledger_id),
        ledgerDelta: ledger.delta,
      };
    });
    const catalog = new Set(accounting.rows.filter((row) => row.nonce === remote.nonce).map((row) => row.handoff.catalogHash));
    const runner = new Set(accounting.rows.filter((row) => row.nonce === remote.nonce).map((row) => row.runner_hash));
    if (catalog.size !== 1 || runner.size !== 1) throw new AbandonError("IDENTITY_MISMATCH");
    proofs[remote.nonce] = remote.proof;
    runs.push({
      nonce: remote.nonce,
      epoch: String(root.epoch),
      rootRequestId: String(root.request_id),
      leafRequestId: String(leaf.request_id),
      uid: "3",
      accountId: "20",
      containerId: String(root.container_id),
      sessionId: String(root.session),
      turnKey: String(root.turn_key),
      model: "box-api-claude-opus-5-5",
      catalogHash: [...catalog][0]!,
      runnerHash: [...runner][0]!,
      reuseCancelIntent: root.cancel_intent != null,
      settled: [settled[0]!, settled[1]!],
      unsettledStopReasons: ["tool_use", "end_turn"],
    });
  }
  return {
    sourceCommit: PINNED_SOURCE_COMMIT,
    authorization: { v: 1, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-294" },
    runs, proofs,
  };
}

function generatedDir(): string {
  if (process.env.OC_OCV5_294_GENERATED) return process.env.OC_OCV5_294_GENERATED;
  return "/var/lib/docker/volumes/oc-v5-data-u3/_data/generated";
}

async function loadPg(): Promise<{ Pool: new (config: { connectionString: string; max: number }) => {
  connect: () => Promise<PoolClient>;
  end: () => Promise<void>;
} }> {
  const href = pathToFileURL(join(process.env.OC_OCV5_294_RELEASE ?? DEFAULT_RELEASE_DIR, "node_modules/pg/lib/index.js")).href;
  const loaded = await import(href) as { Pool?: new (config: { connectionString: string; max: number }) => {
    connect: () => Promise<PoolClient>; end: () => Promise<void>;
  }; default?: { Pool: new (config: { connectionString: string; max: number }) => {
    connect: () => Promise<PoolClient>; end: () => Promise<void>;
  } } };
  const Pool = loaded.Pool ?? loaded.default?.Pool;
  if (!Pool) throw new AbandonError("PG_DRIVER_MISSING");
  return { Pool };
}

function databaseUrlFromMasterEnv(): string {
  const path = process.env.OC_OCV5_294_ENV_FILE ?? "/etc/openclaude/commercial-v5-selfhost.env";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("DATABASE_URL=")) continue;
    return trimmed.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new AbandonError("DATABASE_URL_MISSING");
}

/** Live apply. Callers must already hold main's SHA, operation id, and nonce whitelist.
 * This process does not invoke it unless `--confirm-production-write` is present. */
export async function applyApprovedLive(manifest: AbandonManifest, approval: ApplyApproval,
  connectionString: string, writeReceipt: (receipt: Record<string, unknown>) => void) {
  assertApproved(manifest, approval);
  const { Pool } = await loadPg();
  const resolverModule = await import(pathToFileURL(join(
    process.env.OC_OCV5_294_RELEASE ?? DEFAULT_RELEASE_DIR,
    "packages/commercial/src/http/proxy/boxAccountResolver.ts")).href);
  const resolver = resolverModule.createProductionBoxAccountResolver();
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SET search_path TO public");
    const results = [];
    for (const nonce of [...approval.nonces].sort()) {
      const run = manifest.runs.find((item) => item.nonce === nonce);
      if (!run) throw new AbandonError("APPROVAL_REQUIRED");
      const freshProof = await readPinnedProductionProof(run, { resolve: (args) => resolver.resolve(args) });
      results.push(await applyRun(client, "public", manifest, run, approval, {
        freshProof, writeReceipt,
      }));
    }
    return results;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function reviewLive(manifest: AbandonManifest, connectionString: string) {
  assertApproved(manifest, {
    approvedSha: PINNED_SOURCE_COMMIT,
    operationId: "ocv5-294-0000000000000000",
    nonces: manifest.runs.map((run) => run.nonce),
  });
  const { Pool } = await loadPg();
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL search_path TO public");
    await client.query("SET LOCAL default_transaction_read_only TO on");
    const results = [];
    for (const run of manifest.runs) results.push(await reviewRun(client, "public", manifest, run));
    await client.query("ROLLBACK");
    return results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "dry-run";
  if (args.includes("--emit-manifest")) {
    const proofPath = args[args.indexOf("--proof") + 1]!;
    const accountingPath = args[args.indexOf("--accounting") + 1]!;
    const out = args[args.indexOf("--out") + 1] ?? join(generatedDir(), "ocv5-294-prod-identity.json");
    const manifest = manifestFromEvidence(JSON.parse(readFileSync(proofPath, "utf8")),
      JSON.parse(readFileSync(accountingPath, "utf8")));
    mkdirSync(generatedDir(), { recursive: true });
    writeFileSync(out, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    process.stdout.write(`manifest ${out}\n`);
    return;
  }
  const manifestPath = args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : "";
  if (!manifestPath || (mode !== "dry-run" && mode !== "apply")) throw new AbandonError("APPROVAL_REQUIRED");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AbandonManifest;
  const loaded = await loadRelease();
  process.stdout.write(`release ${loaded.href.journal}\n`);
  if (mode === "dry-run") {
    if (args.includes("--review-live")) {
      const results = await reviewLive(manifest, databaseUrlFromMasterEnv());
      process.stdout.write(`REVIEW_REQUIRED read-only live review; production apply was not executed\n${canonicalJson(results)}\n`);
      return;
    }
    process.stdout.write("REVIEW_REQUIRED dry-run only; production apply was not executed\n");
    process.stdout.write(`${canonicalJson({
      sourceCommit: PINNED_SOURCE_COMMIT,
      runs: manifest.runs.map((run) => ({
        nonce: run.nonce, root: run.rootRequestId, leaf: run.leafRequestId,
        cancelIntent: run.reuseCancelIntent ? "reuse" : "record",
        unsettled: run.unsettledStopReasons,
      })),
    })}\n`);
    return;
  }
  const approval = {
    approvedSha: args[args.indexOf("--approved-sha") + 1] ?? "",
    operationId: args[args.indexOf("--operation-id") + 1] ?? "",
    nonces: args.flatMap((arg, index) => arg === "--run" ? [args[index + 1]!] : []),
  };
  assertApproved(manifest, approval);
  if (!args.includes("--confirm-production-write")) {
    process.stdout.write("REVIEW_REQUIRED approval flags parsed; production write not confirmed\n");
    throw new AbandonError("APPROVAL_REQUIRED");
  }
  const url = databaseUrlFromMasterEnv();
  const results = await applyApprovedLive(manifest, approval, url, (receipt) => {
    const file = join(generatedDir(), `ocv5-294-receipt-${approval.operationId}-${receipt.nonce}.json`);
    writeFileSync(file, `${canonicalJson(receipt)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  });
  process.stdout.write(`${canonicalJson({ applied: results.map((item) => ({ nonce: item.nonce, status: item.status })) })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const code = error instanceof AbandonError ? error.code : "FAILED";
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(`${code} ${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted")}\n`);
    process.exitCode = code === "APPROVAL_REQUIRED" ? 2 : 1;
  });
}

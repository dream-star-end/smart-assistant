/** OCV5-295 one-shot operator for the single e682 committed/handoff row.
 * Releases that row's active capacity. Does not settle, refund, exempt,
 * clean up, or stop the remote worker. Default mode is dry-run.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { PoolClient } from "pg";

export const PINNED_SOURCE_COMMIT = "ae5e6cfaace3eaa11c8289dbfac9c5c46ec2f6ed";
export const PINNED_RELEASE_REALPATH =
  "/opt/openclaude/openclaude-v5-selfhost-releases/rel-ae5e6cfaa-20260929-071146";
export const PINNED_JOURNAL_SHA256 =
  "072584c7aedb7e64df7a07c3985c846c5ef589dc97ea8528668fa3e06cfaae61";
export const EXPECTED_MANIFEST_SHA256 =
  "2cd4d42290c331d6fd72c6a82d1ea17d373b27a757aa4707ff123f4e15347e5c";
export const EXPECTED_SCRIPT_SHA256 =
  "0ff1c272e165258bf4166a3d8e4fd2dfabc4908c42a980682832bc81e287b9a1";
export const ABANDON_STATE = "operator_completed_abandoned";
export const REQUIRED_AUTHORIZATION = "旧运行该停就停";
export const TARGET_NONCE = "e682271820b159b147bbf767";
export const MOVED_POINTER_KEYS = [
  "boxToolHandoff", "boxReplayMessage", "boxNativePointer", "boxNativeSessionId",
  "boxNativeCliCwd", "boxNativeClaimRequestId", "boxNativeOwnerRequestId",
  "boxResumeRequestId", "boxResumeRevision", "boxResumeResultHashes",
  "boxParentResumeRevision", "boxOwnerRequestId", "boxHandoffRevision",
] as const;

const HEX_64 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^ocv5-295-[0-9a-f]{16,64}$/;
const PRIVATE_SCHEMA = /^ocv5_295_[a-f0-9]{8}$/;
const SCRIPT_HASH_LINE =
  'export const EXPECTED_SCRIPT_SHA256 =\n  "0000000000000000000000000000000000000000000000000000000000000000";';

export class ReleaseError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ReleaseError"; }
}

type QueryClient = Pick<PoolClient, "query">;
type Ctx = Record<string, unknown>;
type SchemaName = "pg_temp" | "public" | `ocv5_295_${string}`;

export interface ProofShape {
  cliPid: number;
  keeperPid: number;
  leaseEpoch: string;
  reason: "worker_complete";
  revision: 1;
  runNonce: string;
}
export interface FinancialSnapshot {
  precheckCredits: string | null;
  finalCredits: string | null;
  ledgerId: string | null;
  usageId: string | null;
}
export interface SettledUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCredits: string;
  ledgerId: string;
  ledgerDelta: string;
}
export interface RunManifest {
  uid: "3";
  accountId: "20";
  nonce: string;
  epoch: string;
  requestId: string;
  containerId: string;
  sessionId: string;
  turnKey: string;
  model: "box-api-claude-opus-5-5";
  catalogHash: string;
  runnerHash: string;
  replayFingerprint: string;
  fallbackAlias: string;
  handoffRevision: string;
  handoffRound: number;
  originalCtxSha256: string;
  originalCtx?: Ctx;
  financial: FinancialSnapshot;
  settled: SettledUsage;
  unsettled: { stopReason: "end_turn"; preserved: true; backfill: false };
  spool: { bytes: number; sha256: string };
  reuseCancelIntent: false;
}
export const CONTRAST_CLOCK_KEYS = ["boxStopProbeAfterMs", "boxStopProbeLastAttemptMs"] as const;
export const CONTRAST_CLOCK_GAP_MS = 120_000;
export const CONTRAST_LEAF_REQUEST_ID = "a50c01dcc2307bb7698278d41029f345";
export interface ContrastRowPin {
  requestId: string;
  userId: string;
  containerId: string | null;
  state: string;
  pre: string | null;
  fin: string | null;
  led: string | null;
  use: string | null;
  epoch: string;
  sessionId: string;
  turnKey: string | null;
  owner: string | null;
  resume: string | null;
  boxState: string;
  businessCtxSha256: string;
}
export interface ContrastPin {
  nonce: string;
  rowCount: number;
  /** Legacy full-ctx aggregate. Synthetic tests only; not a live gate once rows exist. */
  sha256?: string;
  leafRequestId?: string;
  clockKeys?: readonly [typeof CONTRAST_CLOCK_KEYS[0], typeof CONTRAST_CLOCK_KEYS[1]];
  clockGapMs?: number;
  historicalAggregateSha256?: string;
  clockFloor?: { boxStopProbeAfterMs: number; boxStopProbeLastAttemptMs: number };
  rows?: ContrastRowPin[];
}
export interface ReleaseManifest {
  v: 1;
  sourceCommit: typeof PINNED_SOURCE_COMMIT;
  releaseRealpath: typeof PINNED_RELEASE_REALPATH;
  journalSha256: typeof PINNED_JOURNAL_SHA256;
  authorization: { v: 1; statement: typeof REQUIRED_AUTHORIZATION; ticket: "OCV5-295" };
  run: RunManifest;
  contrast: ContrastPin;
  proof: ProofShape;
}
export interface ApplyApproval {
  approvedSha: string;
  operationId: string;
  nonce: string;
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

type ReleaseModule = {
  parseBoxTerminalProof: (raw: string, expected: { runNonce: string; leaseEpoch: string }) => ProofShape;
  readBoxTerminalProof: (input: {
    target: { accountId: bigint; exec: { run: (request: unknown, opts: unknown) => Promise<{ stdout: string }> }; dispose?: () => Promise<void> };
    expectedAccountId: bigint;
    runNonce: string;
    leaseEpoch: string;
    signal?: AbortSignal;
  }) => Promise<ProofShape>;
  BoxDurableJournal: new (pool: {
    connect: () => Promise<{ query: QueryClient["query"]; release: () => void }>;
    query?: QueryClient["query"];
  }) => {
    recordUserCancelIntent: (input: {
      requestId: string; uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string;
    }) => Promise<void>;
  };
};

let releaseCache: { href: { proof: string; journal: string }; mod: ReleaseModule } | null = null;

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

export function hashScriptSource(source: string): string {
  const normalized = source.replace(
    /export const EXPECTED_SCRIPT_SHA256 =\n  "[0-9a-f]{64}";/,
    SCRIPT_HASH_LINE,
  );
  if (!normalized.includes(SCRIPT_HASH_LINE)) throw new ReleaseError("RELEASE_MISMATCH");
  return sha256(normalized);
}

export function verifyPins(scriptSource = readFileSync(new URL(import.meta.url), "utf8")): void {
  if (hashScriptSource(scriptSource) !== EXPECTED_SCRIPT_SHA256) throw new ReleaseError("RELEASE_MISMATCH");
  const release = realpathSync(PINNED_RELEASE_REALPATH);
  if (release !== PINNED_RELEASE_REALPATH) throw new ReleaseError("RELEASE_MISMATCH");
  const journal = join(release, "packages/commercial/src/http/proxy/boxDurableJournal.ts");
  const journalHash = createHash("sha256").update(readFileSync(journal)).digest("hex");
  if (journalHash !== PINNED_JOURNAL_SHA256) throw new ReleaseError("RELEASE_MISMATCH");
}

export function quoteIdent(schema: string): string {
  if (schema === "pg_temp" || schema === "public" || PRIVATE_SCHEMA.test(schema)) return schema;
  throw new ReleaseError("SCHEMA_FORBIDDEN");
}

export function table(schema: SchemaName, name: "request_finalize_journal" | "usage_records" | "credit_ledger"): string {
  if (name !== "request_finalize_journal" && name !== "usage_records" && name !== "credit_ledger") {
    throw new ReleaseError("SCHEMA_FORBIDDEN");
  }
  return `${quoteIdent(schema)}.${name}`;
}

export function advisoryKeys(input: {
  accountId: string; fingerprints: string[]; uid: string; sessionId?: string; sessionIds?: string[];
}): string[] {
  const sessions = [...new Set(input.sessionIds ?? (input.sessionId ? [input.sessionId] : []))];
  return [
    `box:account:${input.accountId}`,
    ...[...input.fingerprints].sort().map((fingerprint) => `box:fingerprint:${fingerprint}`),
    ...sessions.sort().map((session) => `box:session:${input.uid}:${session}`),
  ];
}

/** Inner BEGIN/COMMIT/ROLLBACK become savepoints on the open outer transaction.
 * Any other transaction-control statement is rejected and not sent. */
export function nestTransaction(outer: QueryClient): QueryClient {
  const stack: string[] = [];
  let seq = 0;
  return {
    async query(sql: string, params?: unknown[]) {
      const text = String(sql).trim().replace(/;\s*$/, "");
      if (/^(BEGIN|COMMIT|ROLLBACK|START|END|ABORT|SAVEPOINT|RELEASE|PREPARE)\b/i.test(text)
        && text !== "BEGIN" && text !== "COMMIT" && text !== "ROLLBACK") {
        throw new ReleaseError("TX_ADAPTER_FAIL_CLOSED");
      }
      if (text === "BEGIN") {
        seq += 1;
        const name = `ocv5_295_hold_${seq}`;
        stack.push(name);
        return outer.query(`SAVEPOINT ${name}`);
      }
      if (text === "COMMIT") {
        const name = stack.pop();
        if (!name) throw new ReleaseError("TX_ADAPTER_FAIL_CLOSED");
        return outer.query(`RELEASE SAVEPOINT ${name}`);
      }
      if (text === "ROLLBACK") {
        const name = stack.pop();
        if (!name) throw new ReleaseError("TX_ADAPTER_FAIL_CLOSED");
        return outer.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
      return outer.query(sql, params);
    },
  };
}

export function releasePaths() {
  return {
    proofHref: pathToFileURL(join(PINNED_RELEASE_REALPATH, "packages/commercial/src/http/proxy/boxTerminalProof.ts")).href,
    journalHref: pathToFileURL(join(PINNED_RELEASE_REALPATH, "packages/commercial/src/http/proxy/boxDurableJournal.ts")).href,
  };
}

export async function loadRelease() {
  if (releaseCache) return releaseCache;
  verifyPins();
  const paths = releasePaths();
  if (!paths.journalHref.includes("rel-ae5e6cfaa-20260929-071146/packages/commercial/src/http/proxy/boxDurableJournal.ts")) {
    throw new ReleaseError("RELEASE_MISMATCH");
  }
  const proof = await import(paths.proofHref);
  const journal = await import(paths.journalHref);
  releaseCache = {
    href: paths,
    mod: {
      parseBoxTerminalProof: proof.parseBoxTerminalProof,
      readBoxTerminalProof: proof.readBoxTerminalProof,
      BoxDurableJournal: journal.BoxDurableJournal,
    },
  };
  return releaseCache;
}

export function productionResolveArgs(signal: AbortSignal) {
  return {
    uid: 3n,
    sessionId: null as null,
    requestId: `ocv5-295-proof-${TARGET_NONCE}`,
    upstreamModel: "claude-opus-5-5" as const,
    requiredAccountId: 20n,
    allowWakeIfHibernated: false as const,
    signal,
  };
}

export async function readPinnedProductionProof(epoch: string, deps: {
  resolve: (args: ReturnType<typeof productionResolveArgs>) => Promise<{
    accountId: bigint;
    exec: { run: (request: unknown, opts: unknown) => Promise<{ stdout: string }> };
    dispose?: () => Promise<void>;
  }>;
}) {
  const loaded = await loadRelease();
  const abort = new AbortController();
  const args = productionResolveArgs(abort.signal);
  if (args.allowWakeIfHibernated !== false || args.requiredAccountId !== 20n
    || args.upstreamModel !== "claude-opus-5-5" || "containerId" in args) {
    throw new ReleaseError("RESOLVER_FENCE");
  }
  const target = await deps.resolve(args);
  try {
    if (target.accountId !== 20n) throw new ReleaseError("IDENTITY_MISMATCH");
    return await loaded.mod.readBoxTerminalProof({
      target, expectedAccountId: 20n, runNonce: TARGET_NONCE, leaseEpoch: epoch, signal: abort.signal,
    });
  } finally { await target.dispose?.(); }
}

function parseProof(mod: ReleaseModule, proof: ProofShape, run: RunManifest): ProofShape {
  let parsed: ProofShape;
  try {
    parsed = mod.parseBoxTerminalProof(`${JSON.stringify(proof)}\n`, {
      runNonce: run.nonce, leaseEpoch: run.epoch,
    });
  } catch { throw new ReleaseError("PROOF_MISMATCH"); }
  const fields = ["cliPid", "keeperPid", "leaseEpoch", "reason", "revision", "runNonce"] as const;
  if (fields.some((field) => canonicalJson(parsed[field]) !== canonicalJson(proof[field]))
    || parsed.reason !== "worker_complete" || parsed.revision !== 1
    || parsed.runNonce !== run.nonce || parsed.leaseEpoch !== run.epoch) {
    throw new ReleaseError("PROOF_MISMATCH");
  }
  return parsed;
}

function validIntent(value: unknown, requestId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return Object.keys(intent).sort().join(",") === "atMs,reason,requestId,v"
    && intent.v === 1 && intent.reason === "user_cancel" && intent.requestId === requestId
    && Number.isSafeInteger(intent.atMs) && Number(intent.atMs) > 0;
}

function financialSnapshot(row: JournalRow): FinancialSnapshot {
  return {
    precheckCredits: row.precheck_credits, finalCredits: row.final_credits,
    ledgerId: row.ledger_id, usageId: row.usage_id,
  };
}

function sameMoney(left: string | null | undefined, right: string | null | undefined): boolean {
  return String(left ?? "") === String(right ?? "");
}

const ROW_SQL = `SELECT request_id, user_id::text, container_id::text, state,
  precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx`;

async function selectRun(client: QueryClient, schema: SchemaName, run: RunManifest, lock: boolean): Promise<JournalRow[]> {
  const found = await client.query<JournalRow>(
    `${ROW_SQL} FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxAccountId' = $2 AND ctx->>'boxRunNonce' = $3
      ORDER BY request_id${lock ? " FOR UPDATE" : ""}`,
    [run.uid, run.accountId, run.nonce]);
  return found.rows;
}

export async function contrastDigest(client: QueryClient, schema: SchemaName, uid: string, nonce: string): Promise<string> {
  const found = await client.query(
    `SELECT request_id, state, precheck_credits::text AS pre, final_credits::text AS fin,
        ledger_id::text AS led, usage_id::text AS use, md5(ctx::text) AS ctx_md5,
        ctx->>'boxState' AS box
      FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxRunNonce' = $2
      ORDER BY request_id`,
    [uid, nonce]);
  return sha256(canonicalJson(found.rows));
}

function sharedIdentity(ctx: Ctx, run: RunManifest): boolean {
  return ctx.boxAccountId === run.accountId
    && ctx.boxRunNonce === run.nonce && ctx.boxLeaseEpoch === run.epoch
    && ctx.boxSessionId === run.sessionId && ctx.boxTurnKey === run.turnKey
    && ctx.model === run.model && ctx.boxCatalogHash === run.catalogHash
    && ctx.boxDetachedRunnerHash === run.runnerHash
    && ctx.boxReplayFingerprint === run.replayFingerprint
    && ctx.boxFallbackAlias === run.fallbackAlias
    && ctx.boxInvocationRecovery === "v1" && ctx.boxInvocationMode === "detached_tool"
    && !Object.hasOwn(ctx, "durableBillingRecovery")
    && HEX_64.test(String(ctx.boxRequestHash ?? ""))
    && HEX_64.test(String(ctx.boxContextHash ?? ""));
}

function moneyMatches(row: JournalRow, run: RunManifest): boolean {
  const snap = financialSnapshot(row);
  return sameMoney(snap.precheckCredits, run.financial.precheckCredits)
    && sameMoney(snap.finalCredits, run.financial.finalCredits)
    && sameMoney(snap.ledgerId, run.financial.ledgerId)
    && sameMoney(snap.usageId, run.financial.usageId);
}

export function isPinnedE682Target(run: Pick<RunManifest, "uid" | "accountId" | "nonce" | "epoch" | "requestId" | "containerId" | "sessionId" | "turnKey">): boolean {
  return run.uid === "3" && run.accountId === "20"
    && run.nonce === TARGET_NONCE
    && run.epoch === "576099aacf2ed8fc91080de887ef5769"
    && run.requestId === "ed263edbf8dd0f8ff393adc20935d95f"
    && run.containerId === "534"
    && run.sessionId === "c1bc63cb-09bb-44ea-a48a-575a533c3940"
    && run.turnKey === "c25fbc11ede9e1667ccbf9af1481342c24a33207a2eed783d2d87f9f731ac5eb";
}

function stripTargetClocks(ctx: Ctx): Ctx {
  const copy = { ...ctx };
  delete copy.boxStopProbeAfterMs;
  delete copy.boxStopProbeLastAttemptMs;
  return copy;
}

function targetClockPair(ctx: Ctx): { boxStopProbeAfterMs: number; boxStopProbeLastAttemptMs: number } | null {
  const after = ctx.boxStopProbeAfterMs;
  const last = ctx.boxStopProbeLastAttemptMs;
  if (typeof after !== "number" || typeof last !== "number"
    || !Number.isSafeInteger(after) || !Number.isSafeInteger(last)
    || !/^[0-9]{13}$/.test(String(after)) || !/^[0-9]{13}$/.test(String(last))
    || after - last !== CONTRAST_CLOCK_GAP_MS) return null;
  return { boxStopProbeAfterMs: after, boxStopProbeLastAttemptMs: last };
}

/** Exact hash, or the pinned e682 row with only a legal probe-clock advance. */
function approvedCtxMatches(actual: Ctx, run: RunManifest): boolean {
  if (sha256(canonicalJson(actual)) === run.originalCtxSha256) return true;
  if (!isPinnedE682Target(run) || !run.originalCtx) return false;
  if (sha256(canonicalJson(run.originalCtx)) !== run.originalCtxSha256) return false;
  const approved = targetClockPair(run.originalCtx);
  const live = targetClockPair(actual);
  if (!approved || !live) return false;
  if (live.boxStopProbeAfterMs < approved.boxStopProbeAfterMs
    || live.boxStopProbeLastAttemptMs < approved.boxStopProbeLastAttemptMs) return false;
  const advanced = live.boxStopProbeAfterMs !== approved.boxStopProbeAfterMs
    || live.boxStopProbeLastAttemptMs !== approved.boxStopProbeLastAttemptMs;
  if (advanced && live.boxStopProbeLastAttemptMs < approved.boxStopProbeAfterMs) return false;
  return canonicalJson(stripTargetClocks(actual)) === canonicalJson(stripTargetClocks(run.originalCtx));
}

function readyHandoff(row: JournalRow, run: RunManifest): boolean {
  const handoff = row.ctx.boxToolHandoff as { roundNo?: unknown } | undefined;
  return row.request_id === run.requestId && row.user_id === run.uid
    && row.container_id === run.containerId && row.state === "committed"
    && row.ctx.boxState === "handoff" && sharedIdentity(row.ctx, run) && moneyMatches(row, run)
    && approvedCtxMatches(row.ctx, run)
    && row.ctx.boxOwnerRequestId === undefined && row.ctx.boxResumeRequestId === undefined
    && row.ctx.boxHandoffRevision === run.handoffRevision
    && !!handoff && !Array.isArray(handoff) && handoff.roundNo === run.handoffRound
    && row.ctx.boxReplayMessage !== undefined && row.ctx.boxCancelIntent === undefined
    && row.ctx.boxTerminalProof === undefined;
}

async function assertNoReverse(client: QueryClient, schema: SchemaName, run: RunManifest) {
  const found = await client.query(
    `SELECT request_id FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND request_id <> $2
        AND (ctx->>'boxOwnerRequestId' = $2 OR ctx->>'boxResumeRequestId' = $2)
      FOR UPDATE`,
    [run.uid, run.requestId]);
  if ((found.rowCount ?? found.rows.length) !== 0) throw new ReleaseError("SUCCESSOR_PRESENT");
}

async function assertUsage(client: QueryClient, schema: SchemaName, run: RunManifest) {
  const usage = await client.query<{ input_tokens: string; output_tokens: string;
    cache_read_tokens: string; cache_write_tokens: string; cost_credits: string; ledger_id: string }>(
    `SELECT input_tokens::text, output_tokens::text, cache_read_tokens::text,
        cache_write_tokens::text, cost_credits::text, ledger_id::text
      FROM ${table(schema, "usage_records")} WHERE user_id = $1 AND request_id = $2`,
    [run.uid, run.requestId]);
  if (usage.rows.length !== 1) throw new ReleaseError("ACCOUNTING_MISMATCH");
  const recorded = usage.rows[0]!;
  const ledger = await client.query<{ delta: string }>(
    `SELECT delta::text FROM ${table(schema, "credit_ledger")} WHERE id = $1::bigint`,
    [recorded.ledger_id]);
  if (ledger.rows.length !== 1
    || recorded.input_tokens !== String(run.settled.inputTokens)
    || recorded.output_tokens !== String(run.settled.outputTokens)
    || recorded.cache_read_tokens !== String(run.settled.cacheReadTokens)
    || recorded.cache_write_tokens !== String(run.settled.cacheWriteTokens)
    || recorded.cost_credits !== run.settled.costCredits
    || recorded.ledger_id !== run.settled.ledgerId
    || ledger.rows[0]!.delta !== run.settled.ledgerDelta) {
    throw new ReleaseError("ACCOUNTING_MISMATCH");
  }
}

function businessCtx(ctx: Ctx, leaf: boolean): Ctx {
  if (!leaf) return ctx;
  const copy = { ...ctx };
  delete copy.boxStopProbeAfterMs;
  delete copy.boxStopProbeLastAttemptMs;
  return copy;
}

function clockPair(ctx: Ctx, floor: { boxStopProbeAfterMs: number; boxStopProbeLastAttemptMs: number }) {
  const after = ctx.boxStopProbeAfterMs;
  const last = ctx.boxStopProbeLastAttemptMs;
  if (typeof after !== "number" || typeof last !== "number"
    || !Number.isSafeInteger(after) || !Number.isSafeInteger(last)
    || !/^[0-9]{13}$/.test(String(after)) || !/^[0-9]{13}$/.test(String(last))
    || after - last !== CONTRAST_CLOCK_GAP_MS
    || after < floor.boxStopProbeAfterMs || last < floor.boxStopProbeLastAttemptMs) {
    throw new ReleaseError("CONTRAST_CHANGED");
  }
}

function contrastRowMatches(row: JournalRow, pin: ContrastRowPin, leaf: boolean): boolean {
  return row.request_id === pin.requestId
    && row.user_id === pin.userId
    && (row.container_id ?? null) === (pin.containerId ?? null)
    && row.state === pin.state
    && sameMoney(row.precheck_credits, pin.pre)
    && sameMoney(row.final_credits, pin.fin)
    && sameMoney(row.ledger_id, pin.led)
    && sameMoney(row.usage_id, pin.use)
    && row.ctx.boxLeaseEpoch === pin.epoch
    && row.ctx.boxSessionId === pin.sessionId
    && (row.ctx.boxTurnKey ?? null) === pin.turnKey
    && (row.ctx.boxOwnerRequestId ?? null) === pin.owner
    && (row.ctx.boxResumeRequestId ?? null) === pin.resume
    && row.ctx.boxState === pin.boxState
    && sha256(canonicalJson(businessCtx(row.ctx, leaf))) === pin.businessCtxSha256;
}

function spectatorView(row: JournalRow) {
  return {
    requestId: row.request_id, userId: row.user_id, containerId: row.container_id,
    state: row.state, pre: row.precheck_credits, fin: row.final_credits,
    led: row.ledger_id, use: row.usage_id, ctx: row.ctx,
  };
}

async function selectNonces(client: QueryClient, schema: SchemaName, uid: string, accountId: string,
  nonces: string[], lock: boolean): Promise<JournalRow[]> {
  const found = await client.query<JournalRow>(
    `${ROW_SQL} FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxAccountId' = $2 AND ctx->>'boxRunNonce' = ANY($3::text[])
      ORDER BY request_id${lock ? " FOR UPDATE" : ""}`,
    [uid, accountId, nonces]);
  return found.rows;
}

function assertContrastBaseline(rows: JournalRow[], manifest: ReleaseManifest) {
  const pin = manifest.contrast;
  const expected = pin.rows;
  const floor = pin.clockFloor;
  if (!expected || expected.length !== pin.rowCount || !floor || pin.leafRequestId !== CONTRAST_LEAF_REQUEST_ID
    || pin.clockGapMs !== CONTRAST_CLOCK_GAP_MS
    || pin.historicalAggregateSha256 !== "729cfefb106000bd79a92994697b750583a4b9f4ad4e8fa4d21322584f64b599") {
    throw new ReleaseError("CONTRAST_CHANGED");
  }
  if (rows.length !== expected.length) throw new ReleaseError("CONTRAST_CHANGED");
  const byId = new Map(rows.map((row) => [row.request_id, row]));
  if (byId.size !== rows.length) throw new ReleaseError("CONTRAST_CHANGED");
  for (const item of expected) {
    const row = byId.get(item.requestId);
    const leaf = item.requestId === pin.leafRequestId;
    if (!row || !contrastRowMatches(row, item, leaf)) throw new ReleaseError("CONTRAST_CHANGED");
    if (leaf) clockPair(row.ctx, floor);
  }
}

async function assertNoReverseSet(client: QueryClient, schema: SchemaName, uid: string, ids: string[]) {
  const found = await client.query(
    `SELECT request_id FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND NOT (request_id = ANY($2::text[]))
        AND (ctx->>'boxOwnerRequestId' = ANY($2::text[]) OR ctx->>'boxResumeRequestId' = ANY($2::text[]))
      FOR UPDATE`,
    [uid, ids]);
  if ((found.rowCount ?? found.rows.length) !== 0) throw new ReleaseError("SUCCESSOR_PRESENT");
}

async function assertContrast(client: QueryClient, schema: SchemaName, manifest: ReleaseManifest) {
  if (manifest.contrast.rows) return;
  const digest = await contrastDigest(client, schema, manifest.run.uid, manifest.contrast.nonce);
  const count = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table(schema, "request_finalize_journal")}
      WHERE user_id = $1 AND ctx->>'boxRunNonce' = $2`,
    [manifest.run.uid, manifest.contrast.nonce]);
  if (count.rows[0]?.n !== manifest.contrast.rowCount || digest !== manifest.contrast.sha256) {
    throw new ReleaseError("CONTRAST_CHANGED");
  }
}

function withoutIntent(ctx: Ctx): Ctx {
  if (ctx.boxCancelIntent === undefined) return ctx;
  const copy = { ...ctx };
  delete copy.boxCancelIntent;
  return copy;
}

function rebuildOriginal(row: JournalRow): Ctx {
  const audit = row.ctx.boxOperatorAudit as { movedPointers?: Ctx } | undefined;
  const restored: Ctx = { ...row.ctx, ...(audit?.movedPointers ?? {}) };
  delete restored.boxOperatorAudit;
  delete restored.boxCancelIntent;
  restored.boxState = "handoff";
  return restored;
}

function postcondition(row: JournalRow, before: JournalRow, run: RunManifest, operationId: string, proof: ProofShape): boolean {
  const audit = row.ctx.boxOperatorAudit as Record<string, unknown> | undefined;
  if (!audit || audit.v !== 1 || audit.operationId !== operationId || audit.intentAdded !== true) return false;
  if (!audit.movedPointers) return false;
  const liveMoved = MOVED_POINTER_KEYS.some((key) => row.ctx[key] !== undefined);
  const unsettled = audit.unsettled as { preserved?: boolean; backfill?: boolean; exempt?: boolean } | undefined;
  const financial = audit.financial as FinancialSnapshot | undefined;
  const snapshot = financialSnapshot(row);
  return row.state === "committed" && row.ctx.boxState === ABANDON_STATE && !liveMoved
    && row.ctx.boxReplayFingerprint === before.ctx.boxReplayFingerprint
    && row.ctx.boxFallbackAlias === before.ctx.boxFallbackAlias
    && row.ctx.boxInvocationRecovery === "v1"
    && !Object.hasOwn(row.ctx, "durableBillingRecovery")
    && validIntent(row.ctx.boxCancelIntent, run.requestId)
    && audit.originalCtxSha256 === sha256(canonicalJson(before.ctx))
    && audit.actualBeforeCtxSha256 === audit.originalCtxSha256
    && audit.approvedOriginalCtxSha256 === run.originalCtxSha256
    && canonicalJson(audit.proof) === canonicalJson(proof)
    && unsettled?.preserved === true && unsettled.backfill === false && unsettled.exempt === false
    && sameMoney(financial?.precheckCredits, snapshot.precheckCredits)
    && sameMoney(financial?.finalCredits, snapshot.finalCredits)
    && sameMoney(financial?.ledgerId, snapshot.ledgerId)
    && sameMoney(financial?.usageId, snapshot.usageId)
    && moneyMatches(row, run)
    && sha256(canonicalJson(rebuildOriginal(row))) === sha256(canonicalJson(before.ctx))
    && targetReleaseStillMatches(row, before.ctx, run);
}

function targetReleaseStillMatches(row: JournalRow, before: Ctx, run: RunManifest): boolean {
  if (!isPinnedE682Target(run) || !run.originalCtx) return true;
  const restored = rebuildOriginal(row);
  const approved = targetClockPair(run.originalCtx);
  const actual = targetClockPair(before);
  const recorded = auditClocks(row.ctx.boxOperatorAudit);
  if (!approved || !actual || !recorded) return false;
  if (canonicalJson(stripTargetClocks(restored)) !== canonicalJson(stripTargetClocks(run.originalCtx))) return false;
  return recorded.boxStopProbeAfterMs === actual.boxStopProbeAfterMs
    && recorded.boxStopProbeLastAttemptMs === actual.boxStopProbeLastAttemptMs
    && targetClockPair(restored)?.boxStopProbeAfterMs === actual.boxStopProbeAfterMs
    && targetClockPair(restored)?.boxStopProbeLastAttemptMs === actual.boxStopProbeLastAttemptMs;
}

function auditClocks(audit: unknown): { boxStopProbeAfterMs: number; boxStopProbeLastAttemptMs: number } | null {
  if (!audit || typeof audit !== "object") return null;
  return targetClockPair({ ...(audit as { actualBeforeClocks?: Ctx }).actualBeforeClocks });
}

function alreadyApplied(row: JournalRow, run: RunManifest, operationId: string, proof: ProofShape): boolean {
  if (row.state !== "committed" || row.ctx.boxState !== ABANDON_STATE) return false;
  const restored = rebuildOriginal(row);
  const audit = row.ctx.boxOperatorAudit as {
    originalCtxSha256?: string; actualBeforeCtxSha256?: string; approvedOriginalCtxSha256?: string;
  } | undefined;
  const actual = audit?.actualBeforeCtxSha256 ?? audit?.originalCtxSha256;
  if (!actual || sha256(canonicalJson(restored)) !== actual) return false;
  if (audit?.approvedOriginalCtxSha256 !== run.originalCtxSha256) return false;
  return postcondition(row, { ...row, ctx: restored }, run, operationId, proof);
}

function buildCtx(row: JournalRow, before: Ctx, run: RunManifest, operationId: string, proof: ProofShape): Ctx {
  const moved: Ctx = {};
  const next: Ctx = { ...row.ctx };
  for (const key of MOVED_POINTER_KEYS) {
    if (Object.hasOwn(next, key)) { moved[key] = next[key]; delete next[key]; }
  }
  next.boxState = ABANDON_STATE;
  next.boxOperatorAudit = {
    v: 1, kind: "completed_abandoned", operationId, intentAdded: true, previousBoxState: "handoff",
    authorization: { v: 1, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-295" },
    proof,
    unsettled: {
      preserved: true, backfill: false, exempt: false, inventZeroUsage: false,
      settledMessageCount: 1, unsettledMessageCount: 1,
      unsettledStopReason: run.unsettled.stopReason,
      settledCredits: run.settled.costCredits, settledLedgerDelta: run.settled.ledgerDelta,
    },
    movedPointers: moved,
    originalCtxSha256: sha256(canonicalJson(before)),
    actualBeforeCtxSha256: sha256(canonicalJson(before)),
    approvedOriginalCtxSha256: run.originalCtxSha256,
    ...(targetClockPair(before) ? { actualBeforeClocks: targetClockPair(before) } : {}),
    financial: financialSnapshot(row),
    spool: run.spool,
    capacityReleased: true, cleanupEligible: false, deliverySucceeded: false,
  };
  return next;
}

export function assertApproved(manifest: ReleaseManifest, approval: ApplyApproval | null): void {
  if (manifest.v !== 1 || manifest.sourceCommit !== PINNED_SOURCE_COMMIT
    || manifest.releaseRealpath !== PINNED_RELEASE_REALPATH
    || manifest.journalSha256 !== PINNED_JOURNAL_SHA256) throw new ReleaseError("RELEASE_MISMATCH");
  if (manifest.authorization.statement !== REQUIRED_AUTHORIZATION
    || manifest.authorization.ticket !== "OCV5-295" || manifest.authorization.v !== 1) {
    throw new ReleaseError("AUTHORIZATION_MISSING");
  }
  if (manifest.run.uid !== "3" || manifest.run.accountId !== "20" || manifest.run.reuseCancelIntent !== false) {
    throw new ReleaseError("IDENTITY_MISMATCH");
  }
  if (!approval || approval.approvedSha !== PINNED_SOURCE_COMMIT || approval.nonce !== manifest.run.nonce
    || !OPERATION_ID.test(approval.operationId)) throw new ReleaseError("APPROVAL_REQUIRED");
}

export interface RunResult {
  nonce: string;
  status: "applied" | "already_applied";
  requestId: string;
  verifiedAfterCommitError?: boolean;
}
export interface ApplyOptions {
  freshProof: ProofShape;
  livePublic?: boolean;
  afterIntent?: (client: QueryClient) => Promise<void>;
  beforeCas?: (client: QueryClient) => Promise<void>;
  writeReceipt?: (receipt: Record<string, unknown>) => Promise<void> | void;
  readIndependently?: () => Promise<JournalRow[]>;
}

export async function applyRun(client: QueryClient, schema: SchemaName, manifest: ReleaseManifest,
  approval: ApplyApproval, opts: ApplyOptions): Promise<RunResult> {
  if (schema === "public" && opts.livePublic !== true) throw new ReleaseError("SCHEMA_FORBIDDEN");
  assertApproved(manifest, approval);
  const run = manifest.run;
  const loaded = await loadRelease();
  const manifestProof = parseProof(loaded.mod, manifest.proof, run);
  const fresh = parseProof(loaded.mod, opts.freshProof, run);
  if (canonicalJson(manifestProof) !== canonicalJson(fresh)) throw new ReleaseError("PROOF_MISMATCH");
  await client.query("BEGIN");
  let committed = false;
  const finish = async (): Promise<RunResult> => {
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const baseline = manifest.contrast.rows;
    const sessionIds = baseline
      ? [...new Set([run.sessionId, ...baseline.map((item) => item.sessionId)])]
      : [run.sessionId];
    const keys = advisoryKeys({
      accountId: run.accountId, fingerprints: [run.replayFingerprint],
      uid: run.uid, sessionIds,
    });
    const expectedOrder = [...keys].sort();
    if (keys.some((key, index) => key !== expectedOrder[index])) throw new ReleaseError("LOCK_ORDER");
    for (const key of expectedOrder) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
    }
    const lockedAll = baseline
      ? await selectNonces(client, schema, run.uid, run.accountId, [run.nonce, manifest.contrast.nonce], true)
      : await selectRun(client, schema, run, true);
    const locked = baseline ? lockedAll.filter((item) => item.ctx.boxRunNonce === run.nonce) : lockedAll;
    const contrastRows = baseline ? lockedAll.filter((item) => item.ctx.boxRunNonce === manifest.contrast.nonce) : [];
    if (locked.length !== 1) throw new ReleaseError(locked.length > 1 ? "SUCCESSOR_PRESENT" : "IDENTITY_MISMATCH");
    const row = locked[0]!;
    if (baseline) {
      assertContrastBaseline(contrastRows, manifest);
      await assertNoReverseSet(client, schema, run.uid, [run.requestId, ...baseline.map((item) => item.requestId)]);
    } else {
      await assertNoReverse(client, schema, run);
      await assertContrast(client, schema, manifest);
    }
    const spectators = baseline ? canonicalJson(contrastRows.map(spectatorView)) : "";
    const sameSpectators = async () => {
      if (!baseline) {
        await assertContrast(client, schema, manifest);
        return;
      }
      const again = await selectNonces(client, schema, run.uid, run.accountId, [manifest.contrast.nonce], true);
      if (canonicalJson(again.map(spectatorView)) !== spectators) throw new ReleaseError("CONTRAST_CHANGED");
    };
    await assertUsage(client, schema, run);
    if (Object.hasOwn(row.ctx, "durableBillingRecovery")) throw new ReleaseError("DURABLE_MARKER");
    if (alreadyApplied(row, run, approval.operationId, fresh)) {
      await sameSpectators();
      await client.query("COMMIT");
      committed = true;
      return { nonce: run.nonce, status: "already_applied", requestId: row.request_id };
    }
    if (row.ctx.boxState === ABANDON_STATE) throw new ReleaseError("OPID_MISMATCH");
    if (!readyHandoff(row, run)) {
      const handoff = row.ctx.boxToolHandoff as { roundNo?: unknown } | undefined;
      if (row.ctx.boxHandoffRevision !== run.handoffRevision || handoff?.roundNo !== run.handoffRound
        || row.ctx.boxResumeRequestId !== undefined || row.ctx.boxOwnerRequestId !== undefined) {
        throw new ReleaseError("CHAIN_MISMATCH");
      }
      throw new ReleaseError("IDENTITY_MISMATCH");
    }
    const adapter = nestTransaction(client);
    const journal = new loaded.mod.BoxDurableJournal({
      connect: async () => ({ query: adapter.query.bind(adapter), release() {} }),
      query: adapter.query.bind(adapter),
    });
    await journal.recordUserCancelIntent({
      requestId: run.requestId, uid: 3n, accountId: 20n, runNonce: run.nonce, leaseEpoch: run.epoch,
    });
    if (opts.afterIntent) await opts.afterIntent(client);
    const intendedRows = await selectRun(client, schema, run, true);
    if (intendedRows.length !== 1) throw new ReleaseError("SUCCESSOR_PRESENT");
    await assertNoReverse(client, schema, run);
    const intended = intendedRows[0]!;
    if (!validIntent(intended.ctx.boxCancelIntent, run.requestId)) throw new ReleaseError("CANCEL_INTENT_CONFLICT");
    if (canonicalJson(withoutIntent(intended.ctx)) !== canonicalJson(row.ctx) || !moneyMatches(intended, run)) {
      throw new ReleaseError("CTX_DRIFT");
    }
    if (opts.beforeCas) await opts.beforeCas(client);
    const current = (await selectRun(client, schema, run, true))[0]!;
    if (canonicalJson(current.ctx) !== canonicalJson(intended.ctx)) throw new ReleaseError("CAS_LOST");
    const next = buildCtx(current, row.ctx, run, approval.operationId, fresh);
    const changed = await client.query(
      `UPDATE ${table(schema, "request_finalize_journal")}
          SET ctx = $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'committed'
          AND container_id::text = $3 AND ctx = $5::jsonb
          AND precheck_credits IS NOT DISTINCT FROM $6::bigint
          AND final_credits IS NOT DISTINCT FROM $7::bigint
          AND ledger_id IS NOT DISTINCT FROM $8::bigint
          AND usage_id IS NOT DISTINCT FROM $9::bigint`,
      [current.request_id, run.uid, run.containerId, JSON.stringify(next), JSON.stringify(current.ctx),
        current.precheck_credits, current.final_credits, current.ledger_id, current.usage_id]);
    if (changed.rowCount !== 1) throw new ReleaseError("CAS_LOST");
    const after = (await selectRun(client, schema, run, true))[0];
    if (!after || !postcondition(after, row, run, approval.operationId, fresh)) throw new ReleaseError("CAS_LOST");
    await sameSpectators();
    await assertUsage(client, schema, run);
    await opts.writeReceipt?.({
      operationId: approval.operationId, nonce: run.nonce, sourceCommit: PINNED_SOURCE_COMMIT,
      proof: fresh, financial: financialSnapshot(after),
      originalCtxSha256: sha256(canonicalJson(row.ctx)),
      actualBeforeCtxSha256: sha256(canonicalJson(row.ctx)),
      approvedOriginalCtxSha256: run.originalCtxSha256,
      originalCtx: row.ctx, unsettledPreserved: true, receiptIsNotCommit: true,
      productionWrite: "journal-capacity-only",
    });
    try {
      await client.query("COMMIT");
      committed = true;
    } catch {
      if (!opts.readIndependently) throw new ReleaseError("COMMIT_UNCONFIRMED");
      let seen: JournalRow[] = [];
      try { seen = await opts.readIndependently(); }
      catch { throw new ReleaseError("COMMIT_UNCONFIRMED"); }
      if (!(seen.length === 1 && alreadyApplied(seen[0]!, run, approval.operationId, fresh))) {
        throw new ReleaseError("COMMIT_UNCONFIRMED");
      }
      committed = true;
      return { nonce: run.nonce, status: "already_applied", requestId: run.requestId, verifiedAfterCommitError: true };
    }
    return { nonce: run.nonce, status: "applied", requestId: after.request_id };
  };
  try {
    return await finish();
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
  }
}

export function loadPrivateManifest(path: string): ReleaseManifest {
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EXPECTED_MANIFEST_SHA256) throw new ReleaseError("RELEASE_MISMATCH");
  const parsed = JSON.parse(bytes.toString("utf8")) as ReleaseManifest;
  if (parsed.run?.nonce !== TARGET_NONCE || parsed.contrast?.rowCount !== 46 || !parsed.run.originalCtx
    || parsed.contrast.rows?.length !== 46 || parsed.contrast.leafRequestId !== CONTRAST_LEAF_REQUEST_ID
    || parsed.contrast.historicalAggregateSha256 !== "729cfefb106000bd79a92994697b750583a4b9f4ad4e8fa4d21322584f64b599") {
    throw new ReleaseError("IDENTITY_MISMATCH");
  }
  if (sha256(canonicalJson(parsed.run.originalCtx)) !== parsed.run.originalCtxSha256) {
    throw new ReleaseError("IDENTITY_MISMATCH");
  }
  if (Object.hasOwn(parsed.run.originalCtx, "durableBillingRecovery")) throw new ReleaseError("DURABLE_MARKER");
  return parsed;
}

function databaseUrlFromMasterEnv(): string {
  const path = process.env.OC_OCV5_295_ENV_FILE ?? "/etc/openclaude/commercial-v5-selfhost.env";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("DATABASE_URL=")) continue;
    return trimmed.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new ReleaseError("DATABASE_URL_MISSING");
}

async function loadPg() {
  const href = pathToFileURL(join(PINNED_RELEASE_REALPATH, "node_modules/pg/lib/index.js")).href;
  const loaded = await import(href) as { Pool?: new (config: { connectionString: string; max: number }) => {
    connect: () => Promise<PoolClient>; end: () => Promise<void>;
  }; default?: { Pool: new (config: { connectionString: string; max: number }) => {
    connect: () => Promise<PoolClient>; end: () => Promise<void>;
  } } };
  const Pool = loaded.Pool ?? loaded.default?.Pool;
  if (!Pool) throw new ReleaseError("PG_DRIVER_MISSING");
  return { Pool };
}

export async function applyApprovedLive(manifest: ReleaseManifest, approval: ApplyApproval, connectionString: string,
  writeReceipt: (receipt: Record<string, unknown>) => void) {
  assertApproved(manifest, approval);
  if (manifest.run.nonce !== TARGET_NONCE) throw new ReleaseError("IDENTITY_MISMATCH");
  const { Pool } = await loadPg();
  const resolverModule = await import(pathToFileURL(join(
    PINNED_RELEASE_REALPATH, "packages/commercial/src/http/proxy/boxAccountResolver.ts")).href);
  const resolver = resolverModule.createProductionBoxAccountResolver();
  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    const freshProof = await readPinnedProductionProof(manifest.run.epoch, {
      resolve: (args) => resolver.resolve(args),
    });
    return await applyRun(client, "public", manifest, approval, {
      freshProof, livePublic: true, writeReceipt,
      readIndependently: async () => {
        const reader = await pool.connect();
        try {
          await reader.query("BEGIN READ ONLY");
          await reader.query("SET LOCAL default_transaction_read_only TO on");
          const rows = await selectRun(reader, "public", manifest.run, false);
          await reader.query("ROLLBACK");
          return rows;
        } finally { reader.release(); }
      },
    });
  } finally {
    client.release();
    await pool.end();
  }
}

function generatedDir(): string {
  return process.env.OC_OCV5_295_GENERATED ?? "/var/lib/docker/volumes/oc-v5-data-u3/_data/generated";
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "dry-run";
  verifyPins();
  const loaded = await loadRelease();
  process.stdout.write(`node ${process.version}\n`);
  process.stdout.write(`journal ${loaded.href.journalHref}\n`);
  if (mode !== "apply") {
    process.stdout.write("REVIEW_REQUIRED dry-run only; production apply was not executed\n");
    process.stdout.write(`${canonicalJson({
      sourceCommit: PINNED_SOURCE_COMMIT, release: PINNED_RELEASE_REALPATH, nonce: TARGET_NONCE,
      manifestSha256: EXPECTED_MANIFEST_SHA256, scriptSha256: EXPECTED_SCRIPT_SHA256,
    })}\n`);
    return;
  }
  const manifest = loadPrivateManifest(args[args.indexOf("--manifest") + 1] ?? "");
  const approval: ApplyApproval = {
    approvedSha: args[args.indexOf("--approved-sha") + 1] ?? "",
    operationId: args[args.indexOf("--operation-id") + 1] ?? "",
    nonce: TARGET_NONCE,
  };
  assertApproved(manifest, approval);
  if (!args.includes("--confirm-production-write")) {
    process.stdout.write("REVIEW_REQUIRED approval flags parsed; production write not confirmed\n");
    throw new ReleaseError("APPROVAL_REQUIRED");
  }
  const result = await applyApprovedLive(manifest, approval, databaseUrlFromMasterEnv(), (receipt) => {
    const file = join(generatedDir(), `ocv5-295-receipt-${approval.operationId}.json`);
    mkdirSync(generatedDir(), { recursive: true });
    writeFileSync(file, `${canonicalJson(receipt)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  });
  process.stdout.write(`${canonicalJson({ nonce: result.nonce, status: result.status })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const code = error instanceof ReleaseError ? error.code : "FAILED";
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(`${code} ${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted")}\n`);
    process.exitCode = code === "APPROVAL_REQUIRED" ? 2 : 1;
  });
}

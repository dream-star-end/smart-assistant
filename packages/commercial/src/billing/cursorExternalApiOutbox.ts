/**
 * Durable FS outbox for the master-side Cursor external API-key path.
 *
 * Unique pending authority is the filesystem: intent (pre-model) → ready
 * (sealed plan) → original usage_records/credit_ledger transaction → unlink
 * only after a confirmed COMMIT. No second journal, flock, quarantine, or
 * commercial default directory.
 *
 * The selfhost composition must inject
 * `/var/lib/openclaude-v5-selfhost/cursor-external-api-outbox/` explicitly.
 * Tests pass an isolated directory. Unconfigured commercial never falls back
 * to the selfhost path.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { Logger } from "../logging/logger.js";
import type { PricingCache } from "./pricing.js";
import {
  settleCursorExternalUsage,
  type CursorEngineStatus,
  type CursorPricingBasis,
  type PreparedCursorSettlePlan,
} from "./cursorExternalSettle.js";
import {
  SettlementCommitOutcomeUnknownError,
  type SettleResult,
} from "./proxyBilling.js";

export const SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR =
  "/var/lib/openclaude-v5-selfhost/cursor-external-api-outbox";

export const CURSOR_EXTERNAL_OUTBOX_SCHEMA = 1 as const;
export const MAX_OUTBOX_FILES_PER_BATCH = 32;
export const MAX_OUTBOX_FILE_BYTES = 64 * 1024;
export const MAX_OUTBOX_BATCH_MS = 5_000;
export const MAX_OUTBOX_SCAN_DIR_MS = 2_000;

const BILLING_ID_RE = /^[0-9a-f]{32}$/;
const DECIMAL_RE = /^-?\d+$/;

export type CursorExternalOutboxPhase = "intent" | "ready";

export type ReportedUsageJson = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export interface CursorExternalIntentRecord {
  schema: typeof CURSOR_EXTERNAL_OUTBOX_SCHEMA;
  phase: "intent";
  billingId: string;
  userId: string;
  modelId: string;
  accountId: string;
  apiKeyId: string | null;
  sessionId: string | null;
  turnKey: string | null;
  parentTurnKey: string | null;
  parentSessionId: string | null;
  delegateAgentId: string | null;
  basis: CursorPricingBasis;
  createdAt: string;
}

export interface CursorExternalReadyRecord extends Omit<CursorExternalIntentRecord, "phase"> {
  phase: "ready";
  engineStatus: CursorEngineStatus;
  terminalCode: string | null;
  usage: ReportedUsageJson;
  plan: PreparedCursorSettlePlan;
  sealedAt: string;
}

export type CursorExternalOutboxRecord = CursorExternalIntentRecord | CursorExternalReadyRecord;

export type OutboxScanObservation =
  | { kind: "ready"; file: string; record: CursorExternalReadyRecord }
  | { kind: "intent"; file: string; billingId: string }
  | { kind: "corrupt"; file: string; reason: string }
  | { kind: "unknown"; file: string; reason: string };

export interface ConsumeReadyResult {
  billingId: string;
  disposition: "new_commit" | "existing" | "commit_proven" | "left" | "invalid";
  settled: SettleResult | null;
  unlinked: boolean;
  reason?: string;
}

export interface CursorExternalApiOutbox {
  readonly directory: string;
  writeIntent(record: CursorExternalIntentRecord): Promise<void>;
  writeReady(record: CursorExternalReadyRecord): Promise<CursorExternalReadyRecord>;
  read(billingId: string): Promise<CursorExternalOutboxRecord | null>;
  unlink(billingId: string): Promise<boolean>;
  listBatch(opts?: { limit?: number; maxBytes?: number; deadlineMs?: number }): Promise<{
    observations: OutboxScanObservation[];
    scanned: number;
    truncated: boolean;
  }>;
  scanOnce(deps: OutboxScannerDeps): Promise<{
    consumed: ConsumeReadyResult[];
    observations: OutboxScanObservation[];
    scanned: number;
  }>;
  startScanner(deps: OutboxScannerDeps & { intervalMs?: number }): { stop: () => Promise<void> };
}

export interface OutboxScannerDeps {
  pool: Pool;
  pricing: PricingCache;
  logger?: Logger;
  now?: () => number;
  settle?: typeof settleCursorExternalUsage;
}

export class CursorExternalOutboxDirectoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorExternalOutboxDirectoryError";
  }
}

export function newCursorExternalBillingId(random: () => Buffer = () => randomBytes(16)): string {
  return random().toString("hex");
}

export function cursorExternalApiOutboxDirForFlavor(
  flavor: "commercial" | "selfhost" | null | undefined,
): string | null {
  if (flavor === "selfhost") return SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR;
  return null;
}

function summarizeScan(
  observations: OutboxScanObservation[],
  consumed: ConsumeReadyResult[],
  scanned: number,
  truncated: boolean,
): Record<string, number | boolean> {
  let intent = 0;
  let unknown = 0;
  let corrupt = 0;
  let ready = 0;
  for (const obs of observations) {
    if (obs.kind === "intent") intent += 1;
    else if (obs.kind === "unknown") unknown += 1;
    else if (obs.kind === "corrupt") corrupt += 1;
    else ready += 1;
  }
  let newCommit = 0;
  let existing = 0;
  let left = 0;
  for (const row of consumed) {
    if (row.disposition === "new_commit") newCommit += 1;
    else if (row.disposition === "existing" || row.disposition === "commit_proven") existing += 1;
    else left += 1;
  }
  return {
    scanned,
    ready,
    intent,
    unknown,
    corrupt,
    consumed: consumed.length,
    newCommit,
    existing,
    left,
    truncated,
  };
}

export async function openCursorExternalApiOutbox(args: {
  directory: string;
  logger?: Logger;
}): Promise<CursorExternalApiOutbox> {
  const directory = path.resolve(args.directory);
  if (!directory) {
    throw new CursorExternalOutboxDirectoryError("outbox directory is empty");
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new CursorExternalOutboxDirectoryError(`cannot create outbox directory ${directory}`, {
      cause: err,
    });
  }
  const probe = path.join(directory, `.probe.${process.pid}.${Date.now()}.tmp`);
  try {
    atomicWriteFile(probe, Buffer.from("ok\n"));
    unlinkSync(probe);
  } catch (err) {
    try {
      unlinkSync(probe);
    } catch {
      /* ignore */
    }
    throw new CursorExternalOutboxDirectoryError(`outbox directory is not writable: ${directory}`, {
      cause: err,
    });
  }

  let scanCursor = "";
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const fileFor = (billingId: string): string => path.join(directory, `${billingId}.json`);

  const writeRecord = async (record: CursorExternalOutboxRecord): Promise<void> => {
    const json = serializeRecord(record);
    if (Buffer.byteLength(json, "utf8") > MAX_OUTBOX_FILE_BYTES) {
      throw new Error(`outbox record exceeds ${MAX_OUTBOX_FILE_BYTES} bytes`);
    }
    const target = fileFor(record.billingId);
    const tmp = path.join(
      directory,
      `.${record.billingId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    atomicWriteFile(tmp, Buffer.from(json, "utf8"));
    try {
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
    fsyncDir(directory);
  };

  const api: CursorExternalApiOutbox = {
    directory,
    async writeIntent(record) {
      assertIntent(record);
      const existing = await readRecordFile(fileFor(record.billingId));
      if (existing && existing.record && existing.record.phase === "ready") {
        throw new Error(`intent writer cannot replace ready ${record.billingId}`);
      }
      await writeRecord(record);
    },
    async writeReady(record) {
      assertReady(record);
      const existing = await readRecordFile(fileFor(record.billingId));
      if (existing?.record?.phase === "ready") {
        return existing.record as CursorExternalReadyRecord;
      }
      await writeRecord(record);
      return record;
    },
    async read(billingId) {
      if (!BILLING_ID_RE.test(billingId)) return null;
      const loaded = await readRecordFile(fileFor(billingId));
      return loaded?.record ?? null;
    },
    async unlink(billingId) {
      if (!BILLING_ID_RE.test(billingId)) return false;
      try {
        unlinkSync(fileFor(billingId));
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return false;
        throw err;
      }
    },
    async listBatch(opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? MAX_OUTBOX_FILES_PER_BATCH, MAX_OUTBOX_FILES_PER_BATCH));
      const maxBytes = opts.maxBytes ?? MAX_OUTBOX_FILE_BYTES;
      const deadline = (opts.deadlineMs ?? MAX_OUTBOX_SCAN_DIR_MS) + Date.now();
      const observations: OutboxScanObservation[] = [];
      let scanned = 0;
      let truncated = false;
      let lastFile = scanCursor;

      const inspect = async (name: string): Promise<boolean> => {
        if (Date.now() >= deadline || observations.length >= limit) {
          truncated = true;
          return false;
        }
        scanned += 1;
        const full = path.join(directory, name);
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          observations.push({ kind: "corrupt", file: name, reason: "stat_failed" });
          lastFile = name;
          return true;
        }
        if (size > maxBytes) {
          observations.push({ kind: "corrupt", file: name, reason: `too_large:${size}` });
          lastFile = name;
          return true;
        }
        const loaded = await readRecordFile(full);
        if (!loaded) {
          observations.push({ kind: "corrupt", file: name, reason: "unreadable" });
          lastFile = name;
          return true;
        }
        if (loaded.kind === "corrupt") {
          observations.push({ kind: "corrupt", file: name, reason: loaded.reason ?? "corrupt" });
          lastFile = name;
          return true;
        }
        const rec = loaded.record;
        if (!rec) {
          observations.push({ kind: "unknown", file: name, reason: loaded.reason ?? "unparsed" });
          lastFile = name;
          return true;
        }
        if (rec.phase === "intent") {
          observations.push({ kind: "intent", file: name, billingId: rec.billingId });
        } else {
          observations.push({ kind: "ready", file: name, record: rec });
        }
        lastFile = name;
        return true;
      };

      const walk = async (accept: (name: string) => boolean): Promise<void> => {
        let dh: Awaited<ReturnType<typeof opendir>> | undefined;
        try {
          dh = await opendir(directory);
        } catch (err) {
          args.logger?.warn("cursor_external_outbox_readdir_failed", { err: String(err) });
          truncated = true;
          return;
        }
        try {
          for await (const ent of dh) {
            if (Date.now() >= deadline || observations.length >= limit) {
              truncated = true;
              break;
            }
            const name = ent.name;
            if (!name.endsWith(".json") || name.startsWith(".")) continue;
            if (!accept(name)) continue;
            const keepGoing = await inspect(name);
            if (!keepGoing) break;
          }
        } finally {
          await dh.close().catch(() => undefined);
        }
      };

      // Fair cursor without materialising the whole directory: first names
      // lexicographically after the last cursor, then wrap to the start.
      await walk((name) => name > scanCursor);
      if (!truncated && observations.length < limit) {
        await walk((name) => name <= scanCursor);
      }
      if (lastFile) scanCursor = lastFile;
      return { observations, scanned, truncated };
    },
    async scanOnce(deps) {
      const batchStarted = Date.now();
      const batch = await api.listBatch({
        limit: MAX_OUTBOX_FILES_PER_BATCH,
        deadlineMs: MAX_OUTBOX_SCAN_DIR_MS,
      });
      const consumed: ConsumeReadyResult[] = [];
      const batchDeadline = batchStarted + MAX_OUTBOX_BATCH_MS;
      for (const obs of batch.observations) {
        if (stopped) break;
        if (Date.now() >= batchDeadline) break;
        if (obs.kind !== "ready") continue;
        // One consume is bounded by the shared master Pool
        // (connectionTimeoutMillis=5s, statement_timeout=30s). This loop
        // does not Promise.race those awaits; a started settle runs to the
        // pool timeout. stop() drains the in-flight batch only.
        const result = await consumeReadyRecord({
          pool: deps.pool,
          pricing: deps.pricing,
          record: obs.record,
          unlink: (id) => api.unlink(id),
          settle: deps.settle,
          logger: deps.logger,
        });
        consumed.push(result);
      }
      const summary = summarizeScan(batch.observations, consumed, batch.scanned, batch.truncated);
      deps.logger?.info("cursor_external_outbox_scan", summary);
      return { consumed, observations: batch.observations, scanned: batch.scanned };
    },
    startScanner(deps) {
      stopped = false;
      const intervalMs = Math.max(500, deps.intervalMs ?? 5_000);
      const tick = (): void => {
        if (stopped || inFlight) return;
        const run = api.scanOnce(deps).then(
          () => undefined,
          (err) => {
            deps.logger?.warn("cursor_external_outbox_scan_failed", { err: String(err) });
          },
        );
        const tracked = run.finally(() => {
          if (inFlight === tracked) inFlight = null;
        });
        inFlight = tracked;
      };
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return {
        stop: async () => {
          stopped = true;
          clearInterval(timer);
          if (inFlight) await inFlight;
        },
      };
    },
  };
  return api;
}

export async function consumeReadyRecord(args: {
  pool: Pool;
  pricing: PricingCache;
  record: CursorExternalReadyRecord;
  unlink: (billingId: string) => Promise<boolean>;
  settle?: typeof settleCursorExternalUsage;
  logger?: Logger;
}): Promise<ConsumeReadyResult> {
  const settle = args.settle ?? settleCursorExternalUsage;
  try {
    const settled = await settle({
      pool: args.pool,
      pricing: args.pricing,
      userId: BigInt(args.record.userId),
      requestId: args.record.billingId,
      modelId: args.record.modelId,
      sessionId: args.record.sessionId,
      engineStatus: args.record.engineStatus,
      terminalCode: args.record.terminalCode,
      usage: args.record.usage,
      accountId: BigInt(args.record.accountId),
      turnKey: args.record.turnKey,
      parentTurnKey: args.record.parentTurnKey,
      parentSessionId: args.record.parentSessionId,
      delegateAgentId: args.record.delegateAgentId,
      apiKeyId: args.record.apiKeyId === null ? null : BigInt(args.record.apiKeyId),
      preparedPlan: args.record.plan,
    });
    if (settled === null) {
      return {
        billingId: args.record.billingId,
        disposition: "left",
        settled: null,
        unlinked: false,
        reason: "settle_null",
      };
    }
    const disposition = settled.commitDisposition ?? "new_commit";
    let unlinked = false;
    try {
      unlinked = await args.unlink(args.record.billingId);
    } catch (err) {
      args.logger?.warn("cursor_external_outbox_unlink_failed", {
        billingId: args.record.billingId,
        err: String(err),
      });
    }
    return { billingId: args.record.billingId, disposition, settled, unlinked };
  } catch (err) {
    if (err instanceof SettlementCommitOutcomeUnknownError) {
      return {
        billingId: args.record.billingId,
        disposition: "left",
        settled: null,
        unlinked: false,
        reason: "commit_unknown",
      };
    }
    args.logger?.warn("cursor_external_outbox_consume_failed", {
      billingId: args.record.billingId,
      err: String(err),
    });
    return {
      billingId: args.record.billingId,
      disposition: "left",
      settled: null,
      unlinked: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function serializeRecord(record: CursorExternalOutboxRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function atomicWriteFile(filePath: string, bytes: Buffer): void {
  const fd = openSync(filePath, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function readRecordFile(
  filePath: string,
): Promise<{ kind: "ok" | "corrupt" | "unknown"; record?: CursorExternalOutboxRecord; reason?: string } | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return { kind: "corrupt", reason: code ?? "read_failed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "invalid_json" };
  }
  const checked = parseRecord(parsed);
  if (checked.ok) return { kind: "ok", record: checked.record };
  if (checked.corrupt) return { kind: "corrupt", reason: checked.reason };
  return { kind: "unknown", reason: checked.reason };
}

function parseRecord(
  raw: unknown,
): { ok: true; record: CursorExternalOutboxRecord } | { ok: false; corrupt: boolean; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, corrupt: true, reason: "not_object" };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== CURSOR_EXTERNAL_OUTBOX_SCHEMA) {
    return { ok: false, corrupt: false, reason: `schema:${String(rec.schema)}` };
  }
  if (typeof rec.billingId !== "string" || !BILLING_ID_RE.test(rec.billingId)) {
    return { ok: false, corrupt: true, reason: "billingId" };
  }
  if (rec.phase === "intent") {
    try {
      const intent = rec as unknown as CursorExternalIntentRecord;
      assertIntent(intent);
      return { ok: true, record: intent };
    } catch (err) {
      return { ok: false, corrupt: true, reason: err instanceof Error ? err.message : "intent" };
    }
  }
  if (rec.phase === "ready") {
    try {
      const ready = rec as unknown as CursorExternalReadyRecord;
      assertReady(ready);
      return { ok: true, record: ready };
    } catch (err) {
      return { ok: false, corrupt: true, reason: err instanceof Error ? err.message : "ready" };
    }
  }
  return { ok: false, corrupt: false, reason: `phase:${String(rec.phase)}` };
}

function assertIntent(record: CursorExternalIntentRecord): void {
  if (record.schema !== CURSOR_EXTERNAL_OUTBOX_SCHEMA) throw new Error("schema");
  if (record.phase !== "intent") throw new Error("phase");
  if (!BILLING_ID_RE.test(record.billingId)) throw new Error("billingId");
  if (!DECIMAL_RE.test(record.userId) || !DECIMAL_RE.test(record.accountId)) throw new Error("ids");
  if (typeof record.modelId !== "string" || !record.modelId) throw new Error("modelId");
  assertBasis(record.basis);
}

function assertReady(record: CursorExternalReadyRecord): void {
  assertIntent({ ...record, phase: "intent" });
  if (record.phase !== "ready") throw new Error("phase");
  if (record.engineStatus !== "success" && record.engineStatus !== "error" && record.engineStatus !== "unavailable") {
    throw new Error("engineStatus");
  }
  assertUsage(record.usage);
  assertPlan(record.plan);
}

function assertBasis(basis: CursorPricingBasis): void {
  if (!basis || typeof basis !== "object") throw new Error("basis");
  for (const key of [
    "modelId",
    "displayName",
    "inputPerMtok",
    "outputPerMtok",
    "cacheReadPerMtok",
    "cacheWritePerMtok",
    "catalogMultiplier",
    "capturedAt",
  ] as const) {
    if (typeof basis[key] !== "string" || basis[key].length === 0) throw new Error(`basis.${key}`);
  }
  if (!DECIMAL_RE.test(basis.inputPerMtok) || !DECIMAL_RE.test(basis.outputPerMtok)) throw new Error("basis.rates");
  if (basis.settleSurcharge !== null && typeof basis.settleSurcharge !== "string") throw new Error("basis.surcharge");
}

function assertUsage(usage: ReportedUsageJson): void {
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const v = usage[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      throw new Error(`usage.${key}`);
    }
  }
}

function assertPlan(plan: PreparedCursorSettlePlan): void {
  if (plan.settleStatus !== "success" && plan.settleStatus !== "error") throw new Error("plan.status");
  if (typeof plan.costCredits !== "string" || !DECIMAL_RE.test(plan.costCredits)) throw new Error("plan.costCredits");
  if (typeof plan.snapshotJson !== "string") throw new Error("plan.snapshotJson");
  const parsed = JSON.parse(plan.snapshotJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("plan.snapshot");
}

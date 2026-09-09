/**
 * Materialize Cursor account-pool rows onto the root-only host auth directory
 * that oc-cursor already consumes (`api-key`, `api-key.<N>`).
 *
 * The database is the source of truth (same store as CCB / Codex). The file
 * pool stays the injection path so CURSOR_API_KEY never enters Docker Env.
 * Values are never logged — only sha256[:16] fingerprints.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { rootLogger } from "../logging/logger.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { cursorSandLifecycleEnabled, readSandLifecycleState, readySandBinding, renderManagedSandPolicy, writeSandJsonAtomic, SAND_POLICY_FILE, type SandLifecycleState, type SandReadyBinding } from "./cursorSandState.js";
import {
  createAccount,
  getCursorTokenSnapshot,
  listAccounts,
  updateAccount,
  type AccountRow,
} from "./store.js";
import {
  CURSOR_CREDENTIAL_KIND_FILE,
  CURSOR_MACHINE_ID_RE,
  CURSOR_QUOTA_CLASS_FILE,
  CURSOR_SAND_MODE_FILE,
  CURSOR_SLOT_WEIGHT_FILE,
  asCursorSlotResults,
  computeCursorSlotWeight,
  cursorModelFamily,
  planCursorQuotaUpdates,
  planStableCursorQuotaUpdate,
  renderCredentialKindSidecar,
  renderQuotaClassSidecar,
  renderSandModeSidecar,
  renderSlotWeightSidecar,
  uniqueCursorAccountIdFromSlotResults,
  type CursorQuotaClass,
  type CursorSlotCredentialKind,
} from "./cursorQuota.js";

export { uniqueCursorAccountIdFromSlotResults };

const log = rootLogger.child({ subsys: "cursor-auth-sync" });

export const CURSOR_API_KEY_RE = /^crsr_[A-Za-z0-9]{20,128}$/;

export function normalizeCursorApiKey(raw: string): string {
  const key = raw.trim();
  if (!CURSOR_API_KEY_RE.test(key)) {
    throw new RangeError("invalid_cursor_api_key");
  }
  return key;
}

export function fingerprintCursorKey(key: string): string {
  return createHash("sha256").update(`${key}\n`, "utf8").digest("hex").slice(0, 16);
}

/**
 * 0257 — Cursor account session accessToken (JWT from loginDeepControl PKCE).
 * Validated by shape only: three base64url segments, no whitespace. Never
 * logged. The same fingerprint function as api keys applies (raw slot
 * content + "\n"), so stable-identity checks stay uniform across kinds.
 */
export const CURSOR_SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

export function normalizeCursorSessionToken(raw: string): string {
  const token = raw.trim();
  if (!CURSOR_SESSION_TOKEN_RE.test(token)) {
    throw new RangeError("invalid_cursor_session_token");
  }
  return token;
}

/** JWT `exp` (seconds) → Date, or null when the payload cannot be decoded. */
export function cursorSessionTokenExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export function cursorAuthDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.OC_V5_CURSOR_AUTH_DIR?.trim() ?? "";
  if (!dir || !dir.startsWith("/")) return null;
  return dir.replace(/(?<!^)\/+$/, "");
}

export function slotFileName(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError("invalid_cursor_slot_index");
  }
  return index === 0 ? "api-key" : `api-key.${index + 1}`;
}

/** Written once the account pool owns this auth dir. Distinguishes first-time
 *  import from "admin deleted the last cursor row" (empty pool + leftover files). */
export const CURSOR_POOL_OWNED_MARKER = ".account-pool-owned";
export const CURSOR_POOL_GENERATIONS_DIR = ".pool-generations";
export const CURSOR_POOL_ACTIVE_FILE = ".pool-active";
export const CURSOR_POOL_IDENTITIES_FILE = ".slot-identities";
export { CURSOR_CREDENTIAL_KIND_FILE, CURSOR_QUOTA_CLASS_FILE, CURSOR_SAND_MODE_FILE, CURSOR_SLOT_WEIGHT_FILE };

interface MaterializedCursorSlot {
  key: string;
  accountId: string;
  quotaClass: CursorQuotaClass;
  sandEnabled: boolean;
  credentialKind: CursorSlotCredentialKind;
  machineId: string | null;
  /** 0262 — first-touch selection weight from Sand usage columns (1..10000). */
  weight: number;
  boxBinding?: SandReadyBinding;
}

export function isCanonicalCursorKeyFile(name: string): boolean {
  if (name === "api-key") return true;
  const matched = /^api-key\.([1-9][0-9]*)$/.exec(name);
  return matched !== null && Number(matched[1]) >= 2;
}

export interface CursorAuthSyncResult {
  imported: number;
  written: number;
  skipped: "no-auth-dir" | "empty-pool-keep-files" | null;
  fingerprints: string[];
}

export interface CursorAuthSyncDeps {
  listAccounts: typeof listAccounts;
  getCursorTokenSnapshot: typeof getCursorTokenSnapshot;
  createAccount: typeof createAccount;
  authDir: string | null;
  now?: () => Date;
  runtimeChannel?: "v3" | "v5";
  /** Production actor's start-instance fence; checked after awaits and before publication. */
  canPublish?: () => boolean;
  lifecycleManaged?: boolean;
  lifecycleState?: SandLifecycleState;
}

function requireSyncOwner(canPublish: (() => boolean) | undefined): void {
  if (canPublish && !canPublish()) throw new Error("CURSOR_AUTH_SYNC_OWNER_STOPPED");
}

export async function listAllCursorAccounts(
  list: typeof listAccounts,
  canPublish?: () => boolean,
): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  for (let offset = 0; ; offset += 500) {
    requireSyncOwner(canPublish);
    const page = await list({ provider: "cursor", limit: 500, offset });
    requireSyncOwner(canPublish);
    rows.push(...page);
    if (rows.length > 4096) throw new Error("CURSOR_AUTH_POOL_CAPACITY_EXCEEDED");
    if (page.length < 500) return rows;
  }
}

export function eligibleCursorRows(rows: AccountRow[], now: Date): AccountRow[] {
  return rows
    .filter((row) => row.provider === "cursor")
    .filter((row) => row.status === "active")
    .filter((row) => row.cooldown_until == null || row.cooldown_until.getTime() <= now.getTime())
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function readHostKeyFiles(authDir: string): Array<{ name: string; key: string }> {
  if (!existsSync(authDir)) return [];
  const names = readdirSync(authDir).filter(isCanonicalCursorKeyFile).sort((a, b) => {
    if (a === "api-key") return -1;
    if (b === "api-key") return 1;
    return a.localeCompare(b, "en", { numeric: true });
  });
  const out: Array<{ name: string; key: string }> = [];
  for (const name of names) {
    const path = join(authDir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      const raw = readFileSync(path, "utf8").replace(/\r?\n$/, "");
      out.push({ name, key: normalizeCursorApiKey(raw) });
    } catch {
      // Skip unreadable / malformed leftovers; never log the value.
    }
  }
  return out;
}

function hasPoolOwnershipMarker(authDir: string): boolean {
  return existsSync(join(authDir, CURSOR_POOL_OWNED_MARKER));
}

function writePoolOwnershipMarker(authDir: string): void {
  writeFileSync(join(authDir, CURSOR_POOL_OWNED_MARKER), "1\n", { mode: 0o600 });
  try {
    chmodSync(join(authDir, CURSOR_POOL_OWNED_MARKER), 0o600);
  } catch {
    // Best-effort; the file is non-secret and ignored by oc-cursor.
  }
}

async function importHostKeysIfEmpty(deps: Required<Pick<CursorAuthSyncDeps, "listAccounts" | "createAccount" | "authDir" | "runtimeChannel">>, canPublish?: () => boolean): Promise<number> {
  const existing = await deps.listAccounts({ provider: "cursor" });
  requireSyncOwner(canPublish);
  if (existing.length > 0 || !deps.authDir) return 0;
  if (hasPoolOwnershipMarker(deps.authDir)) return 0;
  const files = readHostKeyFiles(deps.authDir);
  let imported = 0;
  for (const file of files) {
    requireSyncOwner(canPublish);
    const fp = fingerprintCursorKey(file.key);
    await deps.createAccount({
      provider: "cursor",
      label: `Cursor ${file.name} (${fp})`,
      plan: "max",
      token: file.key,
      runtime_channel: deps.runtimeChannel,
      egress_proxy_id: null,
    });
    requireSyncOwner(canPublish);
    imported += 1;
    log.info("imported host Cursor key into account pool", { slot: file.name, fingerprint: fp });
  }
  return imported;
}

function credentialKindSlots(
  slots: MaterializedCursorSlot[],
): Array<{ name: string; credentialKind: CursorSlotCredentialKind; machineId: string | null }> {
  return slots.map((slot, i) => ({
    name: slotFileName(i),
    credentialKind: slot.credentialKind,
    machineId: slot.machineId,
  }));
}

function writeAtomicSlots(authDir: string, slots: MaterializedCursorSlot[], managed = false, canPublish: () => boolean = () => true): string[] {
  const policy = managed ? renderManagedSandPolicy(slots.flatMap((s) => s.boxBinding ? [s.boxBinding] : [])) : null;
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const fingerprints = slots.map((slot) => fingerprintCursorKey(slot.key));
  const generationDigest = createHash("sha256");
  for (let i = 0; i < slots.length; i += 1) {
    generationDigest.update([
      slotFileName(i),
      slots[i].accountId,
      fingerprints[i],
      slots[i].quotaClass,
      slots[i].sandEnabled ? "1" : "0",
      // 0257: kind/machine id participate so a kind flip (or machine id
      // change) always yields a fresh immutable generation.
      ...(slots[i].credentialKind === "session" ? ["session", slots[i].machineId ?? ""] : []),
      // 0262: weight participates so a usage refresh yields a new generation
      // (weights are bucketed upstream so hourly drift does not churn).
      String(slots[i].weight),
      ...(slots[i].boxBinding ? [JSON.stringify(slots[i].boxBinding)] : []),
    ].join("\0"));
    generationDigest.update("\n");
  }
  const generation = `gen-${generationDigest.digest("hex").slice(0, 24)}`;
  const generationsDir = join(authDir, CURSOR_POOL_GENERATIONS_DIR);
  mkdirSync(generationsDir, { recursive: true, mode: 0o700 });
  const generationDir = join(generationsDir, generation);
  if (!existsSync(generationDir)) {
    const generationStaging = join(generationsDir, `.staging-${process.pid}-${Date.now()}`);
    mkdirSync(generationStaging, { mode: 0o700 });
    try {
      const quotaSlots: Array<{ name: string; quotaClass: CursorQuotaClass }> = [];
      const sandSlots: Array<{ name: string; sandEnabled: boolean }> = [];
      const weightSlots: Array<{ name: string; weight: number }> = [];
      const identities = [`# cursor-pool-identity v1 ${generation}`];
      for (let i = 0; i < slots.length; i += 1) {
        const name = slotFileName(i);
        writeFileSync(join(generationStaging, name), `${slots[i].key}\n`, { mode: 0o600 });
        chmodSync(join(generationStaging, name), 0o600);
        quotaSlots.push({ name, quotaClass: slots[i].quotaClass });
        sandSlots.push({ name, sandEnabled: slots[i].sandEnabled });
        weightSlots.push({ name, weight: slots[i].weight });
        identities.push(`${name} ${slots[i].accountId} ${fingerprints[i]} ${slots[i].sandEnabled ? "1" : "0"}`);
      }
      writeFileSync(join(generationStaging, CURSOR_QUOTA_CLASS_FILE), renderQuotaClassSidecar(quotaSlots), { mode: 0o600 });
      writeFileSync(join(generationStaging, CURSOR_SAND_MODE_FILE), renderSandModeSidecar(sandSlots), { mode: 0o600 });
      writeFileSync(join(generationStaging, CURSOR_CREDENTIAL_KIND_FILE), renderCredentialKindSidecar(credentialKindSlots(slots)), { mode: 0o600 });
      writeFileSync(join(generationStaging, CURSOR_POOL_IDENTITIES_FILE), `${identities.join("\n")}\n`, { mode: 0o600 });
      writeFileSync(join(generationStaging, CURSOR_SLOT_WEIGHT_FILE), renderSlotWeightSidecar(weightSlots), { mode: 0o600 });
      chmodSync(join(generationStaging, CURSOR_SLOT_WEIGHT_FILE), 0o600);
      chmodSync(join(generationStaging, CURSOR_QUOTA_CLASS_FILE), 0o600);
      chmodSync(join(generationStaging, CURSOR_SAND_MODE_FILE), 0o600);
      chmodSync(join(generationStaging, CURSOR_CREDENTIAL_KIND_FILE), 0o600);
      chmodSync(join(generationStaging, CURSOR_POOL_IDENTITIES_FILE), 0o600);
      renameSync(generationStaging, generationDir);
    } finally {
      rmSync(generationStaging, { recursive: true, force: true });
    }
  }
  requireSyncOwner(canPublish);
  if (policy) writeSandJsonAtomic(authDir, SAND_POLICY_FILE, policy, canPublish);
  const activeTemp = join(authDir, `${CURSOR_POOL_ACTIVE_FILE}.tmp-${process.pid}`);
  writeFileSync(activeTemp, `${generation}\n`, { mode: 0o600 });
  chmodSync(activeTemp, 0o600);
  renameSync(activeTemp, join(authDir, CURSOR_POOL_ACTIVE_FILE));

  // Legacy root projection remains for already-running pre-generation
  // containers. New wrappers resolve the immutable active generation above.
  const staging = join(authDir, ".materializing");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });
  try {
    const sidecarSlots: Array<{ name: string; quotaClass: CursorQuotaClass }> = [];
    const sandSlots: Array<{ name: string; sandEnabled: boolean }> = [];
    const weightSlots: Array<{ name: string; weight: number }> = [];
    for (let i = 0; i < slots.length; i += 1) {
      const name = slotFileName(i);
      const dest = join(staging, name);
      writeFileSync(dest, `${slots[i].key}\n`, { mode: 0o600, encoding: "utf8" });
      chmodSync(dest, 0o600);
      sidecarSlots.push({ name, quotaClass: slots[i].quotaClass });
      sandSlots.push({ name, sandEnabled: slots[i].sandEnabled });
      weightSlots.push({ name, weight: slots[i].weight });
    }
    writeFileSync(join(staging, CURSOR_QUOTA_CLASS_FILE), renderQuotaClassSidecar(sidecarSlots), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(join(staging, CURSOR_QUOTA_CLASS_FILE), 0o600);
    writeFileSync(join(staging, CURSOR_SAND_MODE_FILE), renderSandModeSidecar(sandSlots), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(join(staging, CURSOR_SAND_MODE_FILE), 0o600);
    writeFileSync(join(staging, CURSOR_CREDENTIAL_KIND_FILE), renderCredentialKindSidecar(credentialKindSlots(slots)), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(join(staging, CURSOR_CREDENTIAL_KIND_FILE), 0o600);
    writeFileSync(join(staging, CURSOR_SLOT_WEIGHT_FILE), renderSlotWeightSidecar(weightSlots), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(join(staging, CURSOR_SLOT_WEIGHT_FILE), 0o600);
    for (let i = 0; i < slots.length; i += 1) {
      const name = slotFileName(i);
      renameSync(join(staging, name), join(authDir, name));
    }
    renameSync(join(staging, CURSOR_QUOTA_CLASS_FILE), join(authDir, CURSOR_QUOTA_CLASS_FILE));
    renameSync(join(staging, CURSOR_SAND_MODE_FILE), join(authDir, CURSOR_SAND_MODE_FILE));
    renameSync(join(staging, CURSOR_CREDENTIAL_KIND_FILE), join(authDir, CURSOR_CREDENTIAL_KIND_FILE));
    renameSync(join(staging, CURSOR_SLOT_WEIGHT_FILE), join(authDir, CURSOR_SLOT_WEIGHT_FILE));
    const expected = new Set(slots.map((_, i) => slotFileName(i)));
    for (const name of readdirSync(authDir)) {
      if (!isCanonicalCursorKeyFile(name)) continue;
      if (!expected.has(name)) unlinkSync(join(authDir, name));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return fingerprints;
}

export async function syncCursorAuthDir(deps?: Partial<CursorAuthSyncDeps>): Promise<CursorAuthSyncResult> {
  const resolved: CursorAuthSyncDeps = {
    listAccounts,
    getCursorTokenSnapshot,
    createAccount,
    authDir: cursorAuthDirFromEnv(),
    now: () => new Date(),
    runtimeChannel: getRuntimeChannel(),
    ...deps,
  };
  if (!resolved.authDir) {
    return { imported: 0, written: 0, skipped: "no-auth-dir", fingerprints: [] };
  }
  const managed = resolved.lifecycleManaged ?? cursorSandLifecycleEnabled();
  const lifecycle = managed ? resolved.lifecycleState ?? readSandLifecycleState(resolved.authDir) : null;

  requireSyncOwner(resolved.canPublish);
  const before = await listAllCursorAccounts(resolved.listAccounts, resolved.canPublish);
  const imported = await importHostKeysIfEmpty({
    listAccounts: resolved.listAccounts,
    createAccount: resolved.createAccount,
    authDir: resolved.authDir,
    runtimeChannel: resolved.runtimeChannel ?? getRuntimeChannel(),
  }, resolved.canPublish);
  requireSyncOwner(resolved.canPublish);
  if (imported > 0 || before.length > 0) {
    writePoolOwnershipMarker(resolved.authDir);
  }

  const rows = eligibleCursorRows(await listAllCursorAccounts(resolved.listAccounts, resolved.canPublish), (resolved.now ?? (() => new Date()))());
  if (rows.length === 0) {
    requireSyncOwner(resolved.canPublish);
    if (!hasPoolOwnershipMarker(resolved.authDir)) {
      return { imported, written: 0, skipped: "empty-pool-keep-files", fingerprints: [] };
    }
    writeAtomicSlots(resolved.authDir, [], managed, resolved.canPublish);
    log.info("materialized empty owned Cursor pool; removed selectable root slots");
    return { imported, written: 0, skipped: null, fingerprints: [] };
  }

  const slots: MaterializedCursorSlot[] = [];
  try {
    for (const row of rows) {
      requireSyncOwner(resolved.canPublish);
      const snap = await resolved.getCursorTokenSnapshot(row.id);
      if (!snap?.token) { requireSyncOwner(resolved.canPublish); continue; }
      try {
        requireSyncOwner(resolved.canPublish);
        const credentialKind: CursorSlotCredentialKind = snap.credential_kind === "session" ? "session" : "api_key";
        const boxBinding = managed && row.cursor_sand_enabled === true
          ? readySandBinding(lifecycle!, row.id.toString(), snap.token.toString("utf8").trim(), credentialKind === "session" ? snap.machine_id : null, (resolved.now ?? (() => new Date()))().getTime())
          : null;
        if (managed && row.cursor_sand_enabled === true && !boxBinding) continue;
        const quotaClass: CursorQuotaClass = row.cursor_quota_class === "other_ok" || row.cursor_quota_class === "cursor_only"
          ? row.cursor_quota_class
          : "unknown";
        const weight = computeCursorSlotWeight({
          sandUsagePct: row.cursor_sand_usage_pct ?? null,
          sandNextResetAt: row.cursor_sand_next_reset_at ?? null,
          billingCycleEnd: row.cursor_billing_cycle_end ?? null,
          sandAccessState: row.cursor_sand_access_state ?? null,
        }, (resolved.now ?? (() => new Date()))());
        if (credentialKind === "session") {
          // Session rows are Sand-only and need their persisted machine id;
          // a malformed row is skipped (never silently downgraded to api_key).
          const machineId = snap.machine_id ?? null;
          if (row.cursor_sand_enabled !== true || !machineId || !CURSOR_MACHINE_ID_RE.test(machineId)) {
            log.warn("cursor session row skipped: not Sand-enabled or missing machine id", { accountId: row.id.toString() });
            continue;
          }
          if (snap.expires_at && snap.expires_at.getTime() <= Date.now()) {
            log.warn("cursor session row skipped: session token expired", { accountId: row.id.toString() });
            continue;
          }
          slots.push({
            key: normalizeCursorSessionToken(snap.token.toString("utf8")),
            accountId: row.id.toString(),
            quotaClass,
            sandEnabled: true,
            credentialKind: "session",
            machineId,
            weight,
            ...(boxBinding ? { boxBinding } : {}),
          });
        } else {
          slots.push({
            key: normalizeCursorApiKey(snap.token.toString("utf8")),
            accountId: row.id.toString(),
            quotaClass,
            sandEnabled: row.cursor_sand_enabled === true,
            credentialKind: "api_key",
            machineId: null,
            weight,
            ...(boxBinding ? { boxBinding } : {}),
          });
        }
      } finally {
        snap.token.fill(0);
        snap.refresh?.fill(0);
      }
    }
    requireSyncOwner(resolved.canPublish);
    // Preparation can change while credentials are awaited. Recheck the latest
    // non-secret state synchronously before publishing its admission policy.
    const currentLifecycle = managed ? resolved.lifecycleState ?? readSandLifecycleState(resolved.authDir) : null;
    const publishSlots = managed ? slots.flatMap((s) => {
      if (!s.sandEnabled) return [s];
      const boxBinding = readySandBinding(currentLifecycle!, s.accountId, s.key, s.machineId, (resolved.now ?? (() => new Date()))().getTime());
      return boxBinding ? [{ ...s, boxBinding }] : [];
    }) : slots;
    const writtenFp = writeAtomicSlots(resolved.authDir, publishSlots, managed, resolved.canPublish);
    log.info("materialized cursor account pool onto host auth dir", {
      written: publishSlots.length,
      imported,
      fingerprints: writtenFp,
    });
    return { imported, written: publishSlots.length, skipped: null, fingerprints: writtenFp };
  } finally {
    for (const slot of slots) slot.key = "";
    slots.length = 0;
  }
}

/** Each instance is its own epoch. A stopped instance can drain but never publish again. */
export function createCursorAuthSyncScheduler(opts: {
  run: (canPublish: () => boolean) => Promise<unknown>;
  onError?: (error: unknown, reason: string) => void;
  delayMs?: number;
}): { schedule: (reason: string) => void; stop: () => Promise<void> } {
  let live = true;
  let dirty: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const schedule = (reason: string): void => {
    if (!live) return;
    dirty = reason;
    if (inFlight) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!live || dirty === null) return;
      const currentReason = dirty;
      dirty = null;
      inFlight = Promise.resolve().then(() => {
        requireSyncOwner(() => live);
        return opts.run(() => live);
      }).then(() => undefined).catch((error) => {
        if (live) opts.onError?.(error, currentReason);
      }).finally(() => {
        inFlight = null;
        if (live && dirty !== null) schedule(dirty);
      });
    }, opts.delayMs ?? 250);
    timer.unref?.();
  };
  return {
    schedule,
    stop: () => {
      live = false;
      dirty = null;
      if (timer) clearTimeout(timer);
      timer = null;
      return inFlight ?? Promise.resolve();
    },
  };
}

let activeSyncActor: ReturnType<typeof createCursorAuthSyncScheduler> | null = null;
let pendingSyncReason: string | null = null;

export function scheduleCursorAuthSync(reason: string): void {
  if (!cursorAuthDirFromEnv()) return;
  pendingSyncReason = reason;
  activeSyncActor?.schedule(reason);
}

export function startCursorAuthSyncActor(opts: { intervalMs?: number } = {}): { stop: () => Promise<void> } {
  void activeSyncActor?.stop();
  const actor = createCursorAuthSyncScheduler({
    run: (canPublish) => syncCursorAuthDir({ canPublish }),
    onError: (err, reason) => log.warn("cursor auth sync failed", {
      reason,
      errorClass: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    }),
  });
  activeSyncActor = actor;
  const intervalMs = opts.intervalMs && opts.intervalMs >= 1000 ? opts.intervalMs : 60_000;
  actor.schedule(pendingSyncReason ?? "boot");
  pendingSyncReason = null;
  const timer = setInterval(() => actor.schedule("tick"), intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      if (activeSyncActor === actor) activeSyncActor = null;
      return actor.stop();
    },
  };
}

export async function resolveUsedCursorAccountId(
  slotResults: unknown,
  now: Date = new Date(),
): Promise<bigint | null> {
  const results = asCursorSlotResults(slotResults);
  if (results.length === 0) return null;
  const rows = eligibleCursorRows(await listAccounts({ provider: "cursor", limit: 500 }), now);
  return uniqueCursorAccountIdFromSlotResults(rows, results);
}

export async function applyLearnedCursorQuota(opts: {
  modelId: string | null;
  terminalCode: string | null;
  slotResults: unknown;
  stableAccountId?: bigint | null;
}): Promise<number> {
  const results = asCursorSlotResults(opts.slotResults);
  if (!opts.modelId || results.length === 0) return 0;
  const family = cursorModelFamily(opts.modelId);
  if (family === "cursor_models") return 0;
  const rows = eligibleCursorRows(await listAccounts({ provider: "cursor", limit: 500 }), new Date());
  const projectedRows = rows.map((row) => ({ id: row.id, cursor_quota_class: row.cursor_quota_class }));
  const updates = opts.stableAccountId !== undefined
    ? opts.stableAccountId === null
      ? []
      : planStableCursorQuotaUpdate(
          projectedRows,
          opts.stableAccountId,
          results,
          family,
          opts.terminalCode,
        )
    : planCursorQuotaUpdates(projectedRows, results, family, opts.terminalCode);
  for (const update of updates) {
    await updateAccount(update.id, { cursor_quota_class: update.to });
  }
  if (updates.length > 0) scheduleCursorAuthSync("cursor.quota-learn");
  return updates.length;
}

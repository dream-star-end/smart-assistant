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
import {
  createAccount,
  getCursorTokenSnapshot,
  listAccounts,
  updateAccount,
  type AccountRow,
} from "./store.js";
import {
  CURSOR_QUOTA_CLASS_FILE,
  asCursorSlotResults,
  cursorModelFamily,
  planCursorQuotaUpdates,
  renderQuotaClassSidecar,
  type CursorQuotaClass,
} from "./cursorQuota.js";

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
export { CURSOR_QUOTA_CLASS_FILE };

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

async function importHostKeysIfEmpty(deps: Required<Pick<CursorAuthSyncDeps, "listAccounts" | "createAccount" | "authDir" | "runtimeChannel">>): Promise<number> {
  const existing = await deps.listAccounts({ provider: "cursor" });
  if (existing.length > 0 || !deps.authDir) return 0;
  if (hasPoolOwnershipMarker(deps.authDir)) return 0;
  const files = readHostKeyFiles(deps.authDir);
  let imported = 0;
  for (const file of files) {
    const fp = fingerprintCursorKey(file.key);
    await deps.createAccount({
      provider: "cursor",
      label: `Cursor ${file.name} (${fp})`,
      plan: "max",
      token: file.key,
      runtime_channel: deps.runtimeChannel,
      egress_proxy_id: null,
    });
    imported += 1;
    log.info("imported host Cursor key into account pool", { slot: file.name, fingerprint: fp });
  }
  return imported;
}

function writeAtomicSlots(
  authDir: string,
  slots: Array<{ key: string; quotaClass: CursorQuotaClass }>,
): string[] {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const staging = join(authDir, ".materializing");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });
  const fingerprints: string[] = [];
  try {
    const sidecarSlots: Array<{ name: string; quotaClass: CursorQuotaClass }> = [];
    for (let i = 0; i < slots.length; i += 1) {
      const name = slotFileName(i);
      const dest = join(staging, name);
      writeFileSync(dest, `${slots[i].key}\n`, { mode: 0o600, encoding: "utf8" });
      chmodSync(dest, 0o600);
      fingerprints.push(fingerprintCursorKey(slots[i].key));
      sidecarSlots.push({ name, quotaClass: slots[i].quotaClass });
    }
    writeFileSync(join(staging, CURSOR_QUOTA_CLASS_FILE), renderQuotaClassSidecar(sidecarSlots), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(join(staging, CURSOR_QUOTA_CLASS_FILE), 0o600);
    for (let i = 0; i < slots.length; i += 1) {
      const name = slotFileName(i);
      renameSync(join(staging, name), join(authDir, name));
    }
    renameSync(join(staging, CURSOR_QUOTA_CLASS_FILE), join(authDir, CURSOR_QUOTA_CLASS_FILE));
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

  const before = await resolved.listAccounts({ provider: "cursor" });
  const imported = await importHostKeysIfEmpty({
    listAccounts: resolved.listAccounts,
    createAccount: resolved.createAccount,
    authDir: resolved.authDir,
    runtimeChannel: resolved.runtimeChannel ?? getRuntimeChannel(),
  });
  if (imported > 0 || before.length > 0) {
    writePoolOwnershipMarker(resolved.authDir);
  }

  const rows = eligibleCursorRows(await resolved.listAccounts({ provider: "cursor" }), (resolved.now ?? (() => new Date()))());
  if (rows.length === 0) {
    log.warn("cursor account pool has no active keys; leaving host files unchanged");
    return { imported, written: 0, skipped: "empty-pool-keep-files", fingerprints: [] };
  }

  const slots: Array<{ key: string; quotaClass: CursorQuotaClass }> = [];
  try {
    for (const row of rows) {
      const snap = await resolved.getCursorTokenSnapshot(row.id);
      if (!snap?.token) continue;
      const key = normalizeCursorApiKey(snap.token.toString("utf8"));
      slots.push({
        key,
        quotaClass: row.cursor_quota_class === "other_ok" || row.cursor_quota_class === "cursor_only"
          ? row.cursor_quota_class
          : "unknown",
      });
      snap.token.fill(0);
    }
    if (slots.length === 0) {
      log.warn("cursor account pool rows had no decryptable keys; leaving host files unchanged");
      return { imported, written: 0, skipped: "empty-pool-keep-files", fingerprints: [] };
    }
    const writtenFp = writeAtomicSlots(resolved.authDir, slots);
    log.info("materialized cursor account pool onto host auth dir", {
      written: slots.length,
      imported,
      fingerprints: writtenFp,
    });
    return { imported, written: slots.length, skipped: null, fingerprints: writtenFp };
  } finally {
    for (const slot of slots) slot.key = "";
    slots.length = 0;
  }
}

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight: Promise<void> | null = null;

export function scheduleCursorAuthSync(reason: string): void {
  if (!cursorAuthDirFromEnv()) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (syncInFlight) return;
    syncInFlight = syncCursorAuthDir()
      .then(() => undefined)
      .catch((err) => {
        log.warn("cursor auth sync failed", {
          reason,
          errorClass: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        syncInFlight = null;
      });
  }, 250);
}

export function startCursorAuthSyncActor(opts: { intervalMs?: number } = {}): { stop: () => void } {
  const intervalMs = opts.intervalMs && opts.intervalMs >= 1000 ? opts.intervalMs : 60_000;
  scheduleCursorAuthSync("boot");
  const timer = setInterval(() => scheduleCursorAuthSync("tick"), intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
    },
  };
}

export async function applyLearnedCursorQuota(opts: {
  modelId: string | null;
  terminalCode: string | null;
  slotResults: unknown;
}): Promise<number> {
  const results = asCursorSlotResults(opts.slotResults);
  if (!opts.modelId || results.length === 0) return 0;
  const family = cursorModelFamily(opts.modelId);
  if (family === "cursor_models") return 0;
  const rows = eligibleCursorRows(await listAccounts({ provider: "cursor", limit: 500 }), new Date());
  const updates = planCursorQuotaUpdates(
    rows.map((row) => ({ id: row.id, cursor_quota_class: row.cursor_quota_class })),
    results,
    family,
    opts.terminalCode,
  );
  for (const update of updates) {
    await updateAccount(update.id, { cursor_quota_class: update.to });
  }
  if (updates.length > 0) scheduleCursorAuthSync("cursor.quota-learn");
  return updates.length;
}

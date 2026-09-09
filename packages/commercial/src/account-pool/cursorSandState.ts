/** Root-owned, non-secret preparation journal. Account credentials stay in the account store. */
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

export const SAND_STATE_FILE = ".sand-lifecycle.json";
export const SAND_POLICY_FILE = ".sand-box-policy.json";
export const SAND_POLICY_MAX_BYTES = 2 * 1024 * 1024;
export const SAND_MAX_ACCOUNTS = 4096;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
export const sandHash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface SandAccountPreparation {
  credentialHash: string;
  phase: "preparing" | "ready" | "error";
  subjectHash?: string;
  machineId?: string;
  machineHash?: string;
  errorCode?: string;
  updatedAt: number;
  readyUntil?: number;
}
export interface SandPreparationOperation {
  nonce: string;
  moduleHash: string;
  phase: "idle" | "create-intent" | "created" | "install-intent" | "submitted" | "ready" | "error";
  startedAt: number;
  nextAttemptAt: number;
  agentId?: string;
  errorCode?: string;
  hostPid?: number;
  machineId?: string;
  agentMarker?: string;
}
export interface SandLifecycleState {
  version: 1;
  accounts: Record<string, SandAccountPreparation>;
  operations: Record<string, SandPreparationOperation>;
}
export interface SandReadyBinding { accountId: string; subjectHash: string; machineHash: string; machineId?: string }
const accountFields = ["credentialHash", "phase", "subjectHash", "machineId", "machineHash", "errorCode", "updatedAt", "readyUntil"];
const operationFields = ["nonce", "moduleHash", "phase", "startedAt", "nextAttemptAt", "agentId", "errorCode", "hostPid", "machineId", "agentMarker"];

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SAND_STATE_INVALID");
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("SAND_STATE_INVALID_FIELD");
}
function timestamp(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function optionalString(value: unknown, pattern: RegExp): boolean { return value === undefined || (typeof value === "string" && pattern.test(value)); }

export function parseSandLifecycleState(value: unknown): SandLifecycleState {
  record(value); fields(value, ["version", "accounts", "operations"]);
  if (value.version !== 1) throw new Error("SAND_STATE_INVALID");
  record(value.accounts); record(value.operations);
  if (Object.keys(value.accounts).length > SAND_MAX_ACCOUNTS || Object.keys(value.operations).length > SAND_MAX_ACCOUNTS) throw new Error("SAND_STATE_CAPACITY");
  for (const [id, a] of Object.entries(value.accounts)) {
    record(a); fields(a, accountFields);
    if (!/^[1-9][0-9]{0,19}$/.test(id) || typeof a.credentialHash !== "string" || !HEX.test(a.credentialHash)
      || !["preparing", "ready", "error"].includes(String(a.phase)) || !timestamp(a.updatedAt)
      || !optionalString(a.subjectHash, HEX) || !optionalString(a.machineHash, HEX)
      || !optionalString(a.machineId, /^[a-z0-9]{16,64}$/) || !optionalString(a.errorCode, /^[A-Z][A-Z0-9_]{0,79}$/)
      || (a.readyUntil !== undefined && !timestamp(a.readyUntil))) throw new Error("SAND_STATE_INVALID");
    if (a.phase === "ready" && (!a.subjectHash || !a.machineHash || !a.machineId || !a.readyUntil)) throw new Error("SAND_STATE_INVALID_READY");
    if (a.machineId && a.machineHash !== sandHash(String(a.machineId))) throw new Error("SAND_STATE_IDENTITY_MISMATCH");
  }
  for (const [subject, o] of Object.entries(value.operations)) {
    record(o); fields(o, operationFields);
    if (!HEX.test(subject) || typeof o.moduleHash !== "string" || !HEX.test(o.moduleHash)
      || typeof o.nonce !== "string" || !/^oc-sand-[a-f0-9]{32}$/.test(o.nonce)
      || !["idle", "create-intent", "created", "install-intent", "submitted", "ready", "error"].includes(String(o.phase))
      || !timestamp(o.startedAt) || !timestamp(o.nextAttemptAt)
      || !optionalString(o.agentId, /^[a-zA-Z0-9_-]{1,128}$/) || !optionalString(o.errorCode, /^[A-Z][A-Z0-9_]{0,79}$/)
      || !optionalString(o.machineId, /^[a-z0-9]{16,64}$/) || !optionalString(o.agentMarker, /^oc-sand-[a-f0-9]{32}$/)
      || (o.hostPid !== undefined && (!timestamp(o.hostPid) || o.hostPid === 0))) throw new Error("SAND_STATE_INVALID");
  }
  return value as unknown as SandLifecycleState;
}

/** authDir already exists: only a file entry is created, then its existing parent is synced. */
export function writeSandJsonAtomic(authDir: string, name: typeof SAND_STATE_FILE | typeof SAND_POLICY_FILE, value: unknown, canPublish: () => boolean): void {
  const check = (): void => { if (!canPublish()) throw new Error("SAND_OWNER_STOPPED"); };
  check();
  if (![SAND_STATE_FILE, SAND_POLICY_FILE].includes(name)) throw new Error("SAND_PATH_INVALID");
  const st = lstatSync(authDir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("SAND_DIRECTORY_INVALID");
  const text = JSON.stringify(name === SAND_STATE_FILE ? parseSandLifecycleState(value) : value) + "\n";
  if (Buffer.byteLength(text) > (name === SAND_STATE_FILE ? MAX_STATE_BYTES : SAND_POLICY_MAX_BYTES)) throw new Error("SAND_STATE_CAPACITY");
  const temp = join(authDir, `${name}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  const dest = join(authDir, name);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
    check(); renameSync(temp, dest);
    const parent = openSync(authDir, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function readSandLifecycleState(authDir: string): SandLifecycleState {
  const file = join(authDir, SAND_STATE_FILE);
  if (!existsSync(file)) return { version: 1, accounts: {}, operations: {} };
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_STATE_BYTES) throw new Error("SAND_STATE_INVALID");
  return parseSandLifecycleState(JSON.parse(readFileSync(file, "utf8")));
}

export function cursorSandLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_CURSOR_SAND_LIFECYCLE === "1" && Boolean(env.OC_V5_CURSOR_AUTH_DIR?.startsWith("/"));
}

export function readySandBinding(state: SandLifecycleState, accountId: string, credential: string, machine: string | null, now = Date.now()): SandReadyBinding | null {
  const a = state.accounts[accountId];
  if (!a || a.phase !== "ready" || a.credentialHash !== sandHash(credential) || !a.readyUntil || a.readyUntil <= now || !a.subjectHash || !a.machineHash || !a.machineId) return null;
  if (machine !== null && sandHash(machine) !== a.machineHash) return null;
  return { accountId, subjectHash: a.subjectHash, machineHash: a.machineHash, ...(machine === null ? { machineId: a.machineId } : {}) };
}

export function renderManagedSandPolicy(bindings: SandReadyBinding[]): { version: 1; managed: true; accounts: SandReadyBinding[] } {
  if (bindings.length > SAND_MAX_ACCOUNTS || new Set(bindings.map((b) => b.accountId)).size !== bindings.length) throw new Error("SAND_POLICY_CAPACITY");
  for (const b of bindings) {
    if (!/^[1-9][0-9]{0,19}$/.test(b.accountId) || !HEX.test(b.subjectHash) || !HEX.test(b.machineHash)
      || !optionalString(b.machineId, /^[a-z0-9]{16,64}$/) || (b.machineId && sandHash(b.machineId) !== b.machineHash)) throw new Error("SAND_POLICY_INVALID");
  }
  const policy = { version: 1 as const, managed: true as const, accounts: bindings };
  if (Buffer.byteLength(JSON.stringify(policy) + "\n") > SAND_POLICY_MAX_BYTES) throw new Error("SAND_POLICY_CAPACITY");
  return policy;
}

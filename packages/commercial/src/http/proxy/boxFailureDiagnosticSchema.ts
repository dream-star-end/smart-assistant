/** Diagnostic metadata is observational, never stop/billing/replay authority. */
import { createHash } from "node:crypto";
import { parseBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";

export const DIAGNOSTIC_MAX_BYTES = 8192;
export const DIAGNOSTIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export interface BoxFailureDiagnosticIdentity {
  uid: bigint; requestId: string; accountId: bigint; runNonce: string; leaseEpoch: string;
}
const stages = ["setup", "stream", "publish", "shutdown", "child_exit"] as const;
const reasons = ["child_exit", "deadline", "output_limit", "stderr_limit", "interrupted",
  "delivery_timeout", "internal_error", "unknown"] as const;
const upstream = ["authentication", "permission", "rate_limit", "overloaded", "context_limit",
  "network", "invalid_request", "unknown"] as const;
const events = ["none", "system", "assistant", "user", "result", "stream_event", "other"] as const;
export interface RemoteDiagnostic {
  version: 1; runNonce: string; leaseEpoch: string; producer: "supervisor";
  stage: typeof stages[number]; reason: typeof reasons[number]; cliExitCode: number | null;
  cliSignal: number | null; httpStatus: number | null; upstreamCode: typeof upstream[number];
  lastEvent: typeof events[number]; stdoutBytes: number; stderrBytes: number;
  flags: { stderrTruncated: boolean; stdoutTruncated: boolean; parseFailed: boolean };
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function keys(x: Record<string, unknown>, expected: string): boolean {
  return Object.keys(x).sort().join(",") === expected.split(",").sort().join(",");
}
function integer(x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number {
  return Number.isSafeInteger(x) && Number(x) >= min && Number(x) <= max;
}
export function validDiagnosticIdentity(x: BoxFailureDiagnosticIdentity): boolean {
  return /^[1-9][0-9]{0,18}$/.test(String(x.uid)) && /^[1-9][0-9]{0,18}$/.test(String(x.accountId))
    && /^[A-Za-z0-9_-]{1,64}$/.test(x.requestId) && /^[a-f0-9]{24}$/.test(x.runNonce)
    && /^[a-f0-9]{32}$/.test(x.leaseEpoch);
}
export function diagnosticId(x: BoxFailureDiagnosticIdentity): string {
  if (!validDiagnosticIdentity(x)) throw new Error("BOX_DIAGNOSTIC_IDENTITY_INVALID");
  return "bdiag_" + createHash("sha256").update(JSON.stringify([
    String(x.uid), x.requestId, String(x.accountId), x.runNonce, x.leaseEpoch])).digest("hex").slice(0, 24);
}
export function parseRemoteDiagnostic(value: unknown, identity: Pick<BoxFailureDiagnosticIdentity,
  "runNonce" | "leaseEpoch">): RemoteDiagnostic | null {
  if (!record(value) || !keys(value, "version,runNonce,leaseEpoch,producer,stage,reason,cliExitCode,cliSignal,httpStatus,upstreamCode,lastEvent,stdoutBytes,stderrBytes,flags")
    || value.version !== 1 || value.producer !== "supervisor" || value.runNonce !== identity.runNonce
    || value.leaseEpoch !== identity.leaseEpoch || !stages.includes(value.stage as never)
    || !reasons.includes(value.reason as never) || !upstream.includes(value.upstreamCode as never)
    || !events.includes(value.lastEvent as never)
    || (value.cliExitCode !== null && !integer(value.cliExitCode, -255, 255))
    || (value.cliSignal !== null && !integer(value.cliSignal, 1, 64))
    || (value.httpStatus !== null && ![400,401,403,408,413,429,500,502,503,504].includes(value.httpStatus as number))
    || !integer(value.stdoutBytes, 0) || !integer(value.stderrBytes, 0)
    || !record(value.flags) || !keys(value.flags, "stderrTruncated,stdoutTruncated,parseFailed")
    || Object.values(value.flags).some(x => typeof x !== "boolean")) return null;
  // Copy only after the exact schema was checked; no raw error text can pass.
  return structuredClone(value) as unknown as RemoteDiagnostic;
}
export type DiagnosticStatus = "ok" | "missing" | "invalid" | "timeout" | "read_failed";
export interface DiagnosticSnapshot {
  version: 1; id: string; observedAtMs: number; expiresAtMs: number;
  identity: { uid: string; accountId: string; requestId: string; runNonce: string; leaseEpoch: string };
  terminal: BoxTerminalProof; status: DiagnosticStatus; remote: RemoteDiagnostic | null;
}
export function parseDiagnosticSnapshot(raw: unknown): DiagnosticSnapshot | null {
  if (!record(raw) || !keys(raw, "version,id,observedAtMs,expiresAtMs,identity,terminal,status,remote")
    || raw.version !== 1 || !integer(raw.observedAtMs, 1) || !integer(raw.expiresAtMs, 1)
    || raw.expiresAtMs - raw.observedAtMs !== DIAGNOSTIC_TTL_MS
    || !record(raw.identity) || !keys(raw.identity, "uid,accountId,requestId,runNonce,leaseEpoch")
    || Object.values(raw.identity).some(x => typeof x !== "string")
    || !["ok", "missing", "invalid", "timeout", "read_failed"].includes(String(raw.status))) return null;
  try {
    const id = { ...raw.identity, uid: BigInt(raw.identity.uid as string),
      accountId: BigInt(raw.identity.accountId as string) } as BoxFailureDiagnosticIdentity;
    if (!validDiagnosticIdentity(id) || raw.id !== diagnosticId(id)) return null;
    const terminal = parseBoxTerminalProof(JSON.stringify(raw.terminal) + "\n", id);
    if (terminal.reason === "worker_complete") return null;
    const remote = raw.remote === null ? null : parseRemoteDiagnostic(raw.remote, id);
    if ((raw.status === "ok") !== (remote !== null) || (raw.remote !== null && remote === null)) return null;
    return { version: 1, id: raw.id as string, observedAtMs: raw.observedAtMs,
      expiresAtMs: raw.expiresAtMs, identity: raw.identity as DiagnosticSnapshot["identity"],
      terminal, status: raw.status as DiagnosticStatus, remote };
  } catch { return null; }
}

/** Content-free, bounded evidence for one admitted Box attempt. Persisted in
 * the existing journal; it never grants launch, billing or cleanup authority. */
import { createHash } from "node:crypto";
export const BOX_FAILURE_CODES = [
  "BOX_CLI_UPSTREAM_REFUSED", "BOX_CLI_UPSTREAM_RATE_LIMITED", "BOX_CLI_MODEL_REFUSED",
  "BOX_TOOL_SNAPSHOT_MISMATCH", "BOX_TOOL_ECHO_CONTENT_MISMATCH",
  "BOX_TOOL_ECHO_ID_MISMATCH", "BOX_TOOL_ECHO_ERROR_MISMATCH",
  "BOX_SPOOL_POLL_ABORTED", "BOX_SPOOL_POLL_TIMEOUT", "BOX_EXEC_TIMEOUT",
  "BOX_SPOOL_WORKER_FAILED", "BOX_SPOOL_KEEPER_STOPPED", "BOX_SPOOL_TERMINAL_INCOMPLETE",
] as const;
export type BoxFailureCode = typeof BOX_FAILURE_CODES[number];
export type BoxFailurePhase = "first_round" | "continuation" | "proxy_stream" | "remote_terminal";

export interface BoxFailureDiagnostic {
  branch?: "synthetic_api_error" | "missing_snapshot" | "snapshot_coverage"
    | "snapshot_content" | "echo_content" | "echo_error_bit" | "unsupported_shape"
    | "worker_terminal" | "terminal_without_message";
  upstreamTag?: "authentication_failed" | "rate_limit" | "invalid_request"
    | "overloaded_error" | "api_error" | "other";
  upstreamStatus?: number;
  blockIndex?: number;
  expectedBlocks?: number;
  observedBlocks?: number;
  expectedType?: "text" | "image" | "tool_use" | "tool_result" | "thinking" | "missing" | "unknown";
  observedType?: BoxFailureDiagnostic["expectedType"];
  expectedBytes?: number;
  observedBytes?: number;
  expectedSha256?: string;
  observedSha256?: string;
  hashOnly?: boolean;
}
export interface BoxFailureInput {
  code: BoxFailureCode;
  phase: BoxFailurePhase;
  diagnostic?: BoxFailureDiagnostic;
}
export interface BoxFirstFailure extends BoxFailureInput {
  version: 1;
  observedAtMs: number;
}
export interface BoxFallbackFailure extends BoxFirstFailure { requestId: string }

const phases = new Set<BoxFailurePhase>(["first_round", "continuation", "proxy_stream", "remote_terminal"]);
const codes: ReadonlySet<string> = new Set(BOX_FAILURE_CODES);
const branches = new Set(["synthetic_api_error", "missing_snapshot", "snapshot_coverage",
  "snapshot_content", "echo_content", "echo_error_bit", "unsupported_shape",
  "worker_terminal", "terminal_without_message"]);
const tags = new Set(["authentication_failed", "rate_limit", "invalid_request",
  "overloaded_error", "api_error", "other"]);
const blockTypes = new Set(["text", "image", "tool_use", "tool_result", "thinking", "missing", "unknown"]);
const diagnosticKeys = new Set(["branch", "upstreamTag", "upstreamStatus", "blockIndex", "expectedBlocks", "observedBlocks",
  "expectedType", "observedType", "expectedBytes", "observedBytes", "expectedSha256",
  "observedSha256", "hashOnly"]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isBoxFailureCode(value: unknown): value is BoxFailureCode {
  return typeof value === "string" && codes.has(value);
}
/** A diagnostic fingerprint, never raw input or an admission comparison. */
export function summarizeBoxFailureValue(value: unknown): {
  type: NonNullable<BoxFailureDiagnostic["expectedType"]>; bytes?: number; sha256?: string;
} {
  const type = value === undefined ? "missing" : typeof value === "string" ? "text"
    : record(value) && typeof value.type === "string" && blockTypes.has(value.type)
      ? value.type as NonNullable<BoxFailureDiagnostic["expectedType"]> : "unknown";
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (encoded === undefined) return { type };
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 1_073_741_824) return { type };
    return { type, bytes, sha256: createHash("sha256").update(encoded).digest("hex") };
  } catch { return { type }; }
}
function validDiagnostic(value: unknown): value is BoxFailureDiagnostic {
  if (!record(value) || Object.keys(value).some((key) => !diagnosticKeys.has(key))) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === "branch" && (typeof item !== "string" || !branches.has(item))) return false;
    if (key === "upstreamTag" && (typeof item !== "string" || !tags.has(item))) return false;
    if ((key === "expectedType" || key === "observedType")
      && (typeof item !== "string" || !blockTypes.has(item))) return false;
    if (key === "upstreamStatus" && (!Number.isSafeInteger(item) || Number(item) < 400 || Number(item) > 599)) return false;
    if (["blockIndex", "expectedBlocks", "observedBlocks"].includes(key)
      && (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > 100_000)) return false;
    if ((key === "expectedBytes" || key === "observedBytes")
      && (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > 1_073_741_824)) return false;
    if ((key === "expectedSha256" || key === "observedSha256")
      && (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) return false;
    if (key === "hashOnly" && typeof item !== "boolean") return false;
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 2048;
}
export function parseBoxFirstFailure(value: unknown): BoxFirstFailure | null {
  if (!record(value) || Object.keys(value).some((key) =>
    !["version", "code", "phase", "observedAtMs", "diagnostic"].includes(key))
    || value.version !== 1 || !isBoxFailureCode(value.code)
    || typeof value.phase !== "string" || !phases.has(value.phase as BoxFailurePhase)
    || !Number.isSafeInteger(value.observedAtMs) || Number(value.observedAtMs) <= 0
    || Number(value.observedAtMs) > 8_640_000_000_000_000
    || (Object.hasOwn(value, "diagnostic") && !validDiagnostic(value.diagnostic))) return null;
  return { version: 1, code: value.code, phase: value.phase as BoxFailurePhase,
    observedAtMs: Number(value.observedAtMs),
    ...(value.diagnostic ? { diagnostic: { ...value.diagnostic as BoxFailureDiagnostic } } : {}) };
}
/** Error text, cause objects, stack traces and synthetic output never enter
 * the envelope. Unknown error classes remain unclassified. */
export function boxFailureFromError(error: unknown, phase: BoxFailurePhase): BoxFailureInput | null {
  if (!phases.has(phase) || !record(error)) return null;
  const code = isBoxFailureCode(error.code) ? error.code
    : isBoxFailureCode(error.message) ? error.message : null;
  if (!code) return null;
  const diagnostic = validDiagnostic(error.boxFailureDiagnostic) ? error.boxFailureDiagnostic : undefined;
  return { code, phase, ...(diagnostic ? { diagnostic: { ...diagnostic } } : {}) };
}

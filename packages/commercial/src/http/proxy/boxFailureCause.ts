/** Privacy boundary: only fixed tags, never message/stack/URL/header/body. */
export type BoxFailureCauseTag = "unknown" | "dns" | "connection_reset" | "connection_refused"
  | "connect_timeout" | "headers_timeout" | "body_timeout" | "socket" | "tls"
  | "aborted" | "deadline" | "http" | "invalid_request" | "account_guard"
  | "output_limit" | "protocol" | "consumer" | "remote_exit";
export type BoxFailureStage = "validate" | "guard" | "fetch" | "http" | "stream"
  | "decode" | "consumer" | "remote_exit";
const causes: Readonly<Record<string, BoxFailureCauseTag>> = Object.freeze({
  ENOTFOUND: "dns", EAI_AGAIN: "dns", ECONNRESET: "connection_reset",
  ECONNREFUSED: "connection_refused", ETIMEDOUT: "connect_timeout",
  UND_ERR_CONNECT_TIMEOUT: "connect_timeout", UND_ERR_HEADERS_TIMEOUT: "headers_timeout",
  UND_ERR_BODY_TIMEOUT: "body_timeout", UND_ERR_SOCKET: "socket",
  CERT_HAS_EXPIRED: "tls", DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls", ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  ABORT_ERR: "aborted", BOX_EXEC_ABORTED: "aborted", BOX_EXEC_TIMEOUT: "deadline",
  BOX_EXEC_TARGET_INVALID: "invalid_request", BOX_EXEC_REQUEST_INVALID: "invalid_request",
  BOX_EXEC_REQUEST_TOO_LARGE: "invalid_request", BOX_EXEC_ACCOUNT_GUARD_FAILED: "account_guard",
  BOX_EXEC_RESPONSE_TOO_LARGE: "output_limit", BOX_EXEC_FRAME_INVALID: "protocol",
  BOX_EXEC_AFTER_END: "protocol", BOX_EXEC_END_BEFORE_EXIT: "protocol",
  BOX_EXEC_AFTER_EXIT: "protocol", BOX_EXEC_INCOMPLETE: "protocol",
  BOX_EXEC_CONSUMER_FAILED: "consumer", BOX_EXEC_REMOTE_EXIT: "remote_exit",
});
const httpStatuses: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
  [400, 401, 403, 408, 413, 429, 500, 502, 503, 504].map(status => [`BOX_EXEC_HTTP_${status}`, status])));
const tags = new Set<BoxFailureCauseTag>(["unknown", ...Object.values(causes), "http"]);
const stages = new Set<BoxFailureStage>(["validate", "guard", "fetch", "http", "stream",
  "decode", "consumer", "remote_exit"]);
/** Do not invoke accessors or stringify attacker-controlled exceptions. */
function data(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return; }
}
export function classifyBoxFailureCause(error: unknown): BoxFailureCauseTag {
  let current = error;
  for (let hop = 0; hop < 3; hop++) {
    const code = data(current, "code");
    if (typeof code === "string" && Object.hasOwn(causes, code)) return causes[code]!;
    if (data(current, "name") === "AbortError") return "aborted";
    current = data(current, "cause");
  }
  return "unknown";
}
export function boxFailureObservation(error: unknown, stage: BoxFailureStage): {
  causeTag: BoxFailureCauseTag; stage: BoxFailureStage;
  httpStatus?: number; remoteExitCode?: number; terminalKnown?: boolean;
} {
  const tag = data(error, "causeTag"), observedStage = data(error, "stage");
  const code = data(error, "code"), exit = data(error, "remoteExitCode"), terminal = data(error, "terminalKnown");
  const httpStatus = typeof code === "string" && Object.hasOwn(httpStatuses, code) ? httpStatuses[code] : undefined;
  return { causeTag: typeof tag === "string" && tags.has(tag as BoxFailureCauseTag)
    ? tag as BoxFailureCauseTag : classifyBoxFailureCause(error),
  stage: typeof observedStage === "string" && stages.has(observedStage as BoxFailureStage)
    ? observedStage as BoxFailureStage : stage,
  ...(httpStatus !== undefined ? { httpStatus } : {}),
  ...(Number.isSafeInteger(exit) && Number(exit) >= -255 && Number(exit) <= 255
    ? { remoteExitCode: Number(exit) } : {}),
  ...(typeof terminal === "boolean" ? { terminalKnown: terminal } : {}) };
}

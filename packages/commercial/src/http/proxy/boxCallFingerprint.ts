/** Stable *secondary* Box replay fingerprint for one OpenClaude turn and
 * canonical Messages request. This is NOT a client-supplied logical call ID:
 * identical independent requests in the same turn are intentionally treated
 * as ambiguous until the product chooses a fail-closed policy or proves a
 * genuine per-call ID transport. Never use this alone to enable the route.
 */
import { createHash } from "node:crypto";
import type { ProxyBody } from "./shared.js";

export class BoxCallFingerprintError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxCallFingerprintError"; }
}

function updateStableJson(value: unknown, emit: (part: string) => void,
  depth = 0): void {
  if (depth > 64) throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_DEEP");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    emit(JSON.stringify(value)); return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    emit(JSON.stringify(value)); return;
  }
  if (Array.isArray(value)) {
    emit("[");
    value.forEach((item, index) => {
      if (index) emit(",");
      updateStableJson(item, emit, depth + 1);
    });
    emit("]"); return;
  }
  if (!value || typeof value !== "object") {
    throw new BoxCallFingerprintError("BOX_CALL_BODY_INVALID");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length > 4096) throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_LARGE");
  emit("{");
  keys.forEach((key, index) => {
    if (index) emit(",");
    emit(JSON.stringify(key)); emit(":");
    updateStableJson(object[key], emit, depth + 1);
  });
  emit("}");
}

export interface BoxCallFingerprint {
  readonly turnKey: string;
  readonly sessionId: string;
  readonly requestHash: string;
  /** Secondary replay fence, not a unique logical-call claim. */
  readonly replayFingerprint: string;
}

/** Privacy-safe binding for the CLI's effective invocation context. A resume
 * request adds the assistant tool_use and user tool_result pair to the
 * already-running CLI; neither message was part of its previous context. */
export function deriveBoxContextHash(body: ProxyBody,
  completedToolTail = false): string {
  if (!Array.isArray(body.messages)
    || (completedToolTail && body.messages.length < 2)) {
    throw new BoxCallFingerprintError("BOX_CALL_CONTEXT_INVALID");
  }
  const { metadata: _tracking, ...modelBody } = body;
  const messages = completedToolTail ? body.messages.slice(0, -2) : body.messages;
  const hasher = createHash("sha256").update("ocv5-box-context-v1\0");
  let bytes = 0;
  updateStableJson({ ...modelBody, messages }, (part) => {
    bytes += Buffer.byteLength(part);
    if (bytes > 16 * 1024 * 1024) {
      throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_LARGE");
    }
    hasher.update(part);
  });
  return hasher.digest("hex");
}

export function deriveBoxCallFingerprint(uid: bigint, body: ProxyBody): BoxCallFingerprint {
  if (uid <= 0n || !body.metadata || typeof body.metadata.user_id !== "string") {
    throw new BoxCallFingerprintError("BOX_CALL_IDENTITY_MISSING");
  }
  let userMeta: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body.metadata.user_id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    userMeta = value as Record<string, unknown>;
  } catch { throw new BoxCallFingerprintError("BOX_CALL_IDENTITY_INVALID"); }
  const turnKey = userMeta.oc_turn_key;
  if (typeof turnKey !== "string" || !/^[a-f0-9]{64}$/.test(turnKey)) {
    throw new BoxCallFingerprintError("BOX_CALL_TURN_KEY_MISSING");
  }
  const outer = body.metadata.session_id;
  const inner = userMeta.session_id;
  if (outer !== undefined && typeof outer !== "string") {
    throw new BoxCallFingerprintError("BOX_CALL_IDENTITY_INVALID");
  }
  if (inner !== undefined && typeof inner !== "string") {
    throw new BoxCallFingerprintError("BOX_CALL_IDENTITY_INVALID");
  }
  if (outer !== undefined && inner !== undefined && outer !== inner) {
    throw new BoxCallFingerprintError("BOX_CALL_SESSION_CONFLICT");
  }
  const sessionId = outer ?? inner;
  if (typeof sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
    throw new BoxCallFingerprintError("BOX_CALL_IDENTITY_MISSING");
  }
  // Tracking metadata can change independently of the model request. Identity
  // is separately bound by authenticated uid, session and the signed turn key.
  const { metadata: _tracking, ...modelBody } = body;
  const hasher = createHash("sha256");
  let bytes = 0;
  updateStableJson(modelBody, (part) => {
    bytes += Buffer.byteLength(part);
    if (bytes > 16 * 1024 * 1024) {
      throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_LARGE");
    }
    hasher.update(part);
  });
  const requestHash = hasher.digest("hex");
  const replayFingerprint = createHash("sha256")
    .update("ocv5-box-replay-v1\0").update(uid.toString()).update("\0")
    .update(sessionId).update("\0").update(turnKey).update("\0")
    .update(requestHash).digest("hex");
  return { turnKey, sessionId, requestHash, replayFingerprint };
}

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

function stableJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_DEEP");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new BoxCallFingerprintError("BOX_CALL_BODY_INVALID");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length > 4096) throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_LARGE");
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key], depth + 1)}`)
    .join(",")}}`;
}

export interface BoxCallFingerprint {
  readonly turnKey: string;
  readonly sessionId: string;
  readonly requestHash: string;
  /** Secondary replay fence, not a unique logical-call claim. */
  readonly replayFingerprint: string;
}

export function deriveBoxCallFingerprint(uid: bigint, body: ProxyBody): BoxCallFingerprint {
  if (uid <= 0n || !body.metadata || typeof body.metadata.user_id !== "string"
    || typeof body.metadata.session_id !== "string"
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(body.metadata.session_id)) {
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
  // Tracking metadata can change independently of the model request. Identity
  // is separately bound by authenticated uid, session and the signed turn key.
  const { metadata: _tracking, ...modelBody } = body;
  const canonical = stableJson(modelBody);
  if (Buffer.byteLength(canonical) > 8 * 1024 * 1024) {
    throw new BoxCallFingerprintError("BOX_CALL_BODY_TOO_LARGE");
  }
  const requestHash = createHash("sha256").update(canonical).digest("hex");
  const replayFingerprint = createHash("sha256")
    .update("ocv5-box-replay-v1\0").update(uid.toString()).update("\0")
    .update(body.metadata.session_id).update("\0").update(turnKey).update("\0")
    .update(requestHash).digest("hex");
  return { turnKey, sessionId: body.metadata.session_id, requestHash, replayFingerprint };
}

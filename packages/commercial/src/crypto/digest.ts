/**
 * Platform SHA-256 and constant-time hex comparison primitives (L2 platform-auth-crypto).
 * Centralizes `node:crypto` digest calls so upper domain layers stay R3-crypto clean.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function sha256HexUtf8(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

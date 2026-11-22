/**
 * Shared WS frame payload budget for master bridge ↔ container gateway (OCV5-825 B1).
 *
 * Matches gateway `wsPayloadPolicy.ts` default (16 MiB) and supports the same
 * `OC_WS_MAX_PAYLOAD_BYTES` emergency override (clamped to [256 KiB, 448 MiB]),
 * ensuring master rejects oversized frames before forwarding them to containers.
 */
export const DEFAULT_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MIN_BRIDGE_MAX_FRAME_BYTES = 256 * 1024;
export const MAX_BRIDGE_MAX_FRAME_BYTES = 448 * 1024 * 1024;

export function resolveBridgeMaxFrameBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_WS_MAX_PAYLOAD_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_BRIDGE_MAX_FRAME_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_BRIDGE_MAX_FRAME_BYTES) {
    return DEFAULT_BRIDGE_MAX_FRAME_BYTES;
  }
  return Math.min(parsed, MAX_BRIDGE_MAX_FRAME_BYTES);
}

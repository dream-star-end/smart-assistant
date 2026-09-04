/**
 * Extract device mTLS context. P1 strips inbound self-reported device headers.
 * Listener bind is C-stage; this is the shared verification helper.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { DesktopIdentityTlsCtx } from "../auth/desktopIdentity.js";
import { extractDeviceIdFromSpiffe } from "./deviceCa.js";
import { DESKTOP_SPIFFE_PREFIX } from "./flags.js";

const STRIP_HEADERS = [
  "x-oc-device-id",
  "x-oc-device-fp",
  "x-oc-verified-device-fp",
  "x-oc-device-spiffe",
];

export function stripUntrustedDeviceHeaders(req: IncomingMessage): void {
  const headers = req.headers as Record<string, unknown>;
  for (const h of STRIP_HEADERS) {
    delete headers[h];
  }
}

function isTlsSocket(sock: IncomingMessage["socket"]): sock is TLSSocket {
  return !!sock && typeof (sock as TLSSocket).getPeerCertificate === "function" && (sock as TLSSocket).encrypted === true;
}

export type PeerCertReader = (req: IncomingMessage) => { raw?: Buffer; subjectaltname?: string; pem?: string } | null;

export function extractDesktopTlsContext(
  req: IncomingMessage,
  opts?: { peerCert?: PeerCertReader },
): DesktopIdentityTlsCtx | null {
  stripUntrustedDeviceHeaders(req);
  const peer = opts?.peerCert
    ? opts.peerCert(req)
    : isTlsSocket(req.socket)
      ? (req.socket.getPeerCertificate(true) as { raw?: Buffer; subjectaltname?: string })
      : null;
  if (!peer) return null;
  let fp: Buffer | null = null;
  if (Buffer.isBuffer(peer.raw) && peer.raw.length > 0) {
    fp = createHash("sha256").update(peer.raw).digest();
  }
  if (!fp || fp.length !== 32) return null;
  const san = peer.subjectaltname ?? "";
  const uriMatch = /URI:([^,\s]+)/i.exec(san);
  const spiffe = uriMatch?.[1] ?? "";
  const deviceId = extractDeviceIdFromSpiffe(spiffe);
  if (!deviceId) return null;
  return {
    tls: true,
    deviceCertFp: fp,
    deviceSpiffe: `${DESKTOP_SPIFFE_PREFIX}${deviceId}`,
  };
}

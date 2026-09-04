/**
 * GET /ws/desktop-container-register — WSS on the 18445 device-mTLS listener.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import {
  verifyDesktopIdentity,
  type DesktopIdentityRepo,
} from "../auth/desktopIdentity.js";
import { compareHash, hashSecret, parseContainerToken } from "../auth/containerIdentity.js";
import {
  getDesktopTunnelRegistry,
  markDesktopTunnelHeartbeat,
  DesktopTunnelGenerationError,
} from "./desktopTunnelRegistry.js";
import { extractDesktopTlsContext, type PeerCertReader } from "../desktop/tlsContext.js";
import { getDesktopFlagSnapshot } from "../desktop/flags.js";
import { createPgDesktopIdentityRepo } from "../http/desktopEnroll.js";
import { DesktopMuxSession, MUX_VERSION, type MuxTransport } from "./desktopMux.js";

import { markV3ContainerActivity, type V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import { rootLogger } from "../logging/logger.js";

export const DESKTOP_REGISTER_PATH = "/ws/desktop-container-register";

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

export interface DesktopRegisterDeps {
  identityRepo?: DesktopIdentityRepo;
  peerCert?: PeerCertReader;
  v3Deps?: V3SupervisorDeps | null;
  expectedKeyringFp?: () => string | null;
}

function wsToMux(ws: WebSocket): MuxTransport {
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    },
    close(code, reason) {
      try { ws.close(code, reason); } catch { /* */ }
    },
    terminate() {
      try { ws.terminate(); } catch { /* */ }
    },
    on(event, cb) {
      ws.on(event, cb as never);
    },
    off(event, cb) {
      ws.off(event, cb as never);
    },
  };
}

async function auditTunnel(event: string, userId: number, deviceId: string | null, containerId: number): Promise<void> {
  try {
    await query(
      `INSERT INTO desktop_device_audit(device_id, user_id, event, container_id, extra)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [deviceId, String(userId), event, containerId, JSON.stringify({})],
    );
  } catch { /* best-effort */ }
}

export function handleDesktopRegisterUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: DesktopRegisterDeps = {},
): void {
  void (async () => {
    const flags = await getDesktopFlagSnapshot();
    if (!flags.assembled) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (flags.killSwitch) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      getDesktopTunnelRegistry().dropAll("killswitch");
      return;
    }
    const tls = extractDesktopTlsContext(req, deps.peerCert ? { peerCert: deps.peerCert } : undefined);
    if (!tls) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const repo = deps.identityRepo ?? createPgDesktopIdentityRepo();
    let ident;
    try {
      ident = await verifyDesktopIdentity(repo, tls, req.headers.authorization);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const { secret: upgradeSecret } = parseContainerToken(req.headers.authorization);
    const genAtUpgrade = await query<{ session_secret_generation: number }>(
      `SELECT COALESCE(session_secret_generation, 0)::int AS session_secret_generation
         FROM agent_containers
        WHERE id = $1 AND runtime_kind = 'desktop' AND state = 'active'`,
      [ident.containerId],
    );
    const upgradeGeneration = Number(genAtUpgrade.rows[0]?.session_secret_generation ?? 0);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timer = setTimeout(() => {
        try { ws.close(1008, "register_timeout"); } catch { /* */ }
      }, 10_000);
      timer.unref?.();
      ws.once("message", (raw) => {
        clearTimeout(timer);
        void (async () => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) as Record<string, unknown>;
          } catch {
            ws.close(1008, "bad_register");
            return;
          }
          if (msg.type !== "register" || msg.v !== 1) {
            ws.close(1008, "bad_register");
            return;
          }
          if (msg.muxVersion !== MUX_VERSION) {
            ws.close(1008, "mux_version");
            return;
          }
          if (Number(msg.containerId) !== ident.containerId) {
            ws.close(1008, "container_mismatch");
            return;
          }
          const expected = deps.expectedKeyringFp?.() ?? null;
          const got = typeof msg.keyringFp === "string" ? msg.keyringFp : "";
          if (expected && got && expected !== got) {
            await query(
              `UPDATE agent_containers SET update_required = true, updated_at = NOW()
                WHERE id = $1 AND runtime_kind = 'desktop'`,
              [ident.containerId],
            );
            await auditTunnel("update_required", ident.userId, null, ident.containerId);
            ws.close(1008, "update_required");
            return;
          }
          const expires = await query<{
            session_secret_expires_at: Date | null;
            session_secret_generation: number;
            secret_hash: Buffer | null;
          }>(
            `SELECT session_secret_expires_at,
                    COALESCE(session_secret_generation, 0)::int AS session_secret_generation,
                    secret_hash
               FROM agent_containers
              WHERE id = $1 AND runtime_kind = 'desktop' AND state = 'active'`,
            [ident.containerId],
          );
          const live = expires.rows[0];
          if (!live || live.session_secret_generation !== upgradeGeneration) {
            ws.close(1008, "stale_generation");
            return;
          }
          if (!live.secret_hash || !compareHash(hashSecret(upgradeSecret), live.secret_hash)) {
            ws.close(1008, "stale_generation");
            return;
          }
          const exp = live.session_secret_expires_at ?? new Date(Date.now() + 3_600_000);
          const mux = new DesktopMuxSession(wsToMux(ws), {
            onHeartbeat: async () => {
              const flagsNow = await getDesktopFlagSnapshot();
              if (flagsNow.killSwitch) return false;
              const row = await query<{ session_secret_expires_at: Date | null; revoked: string; session_secret_generation: number }>(
                `SELECT c.session_secret_expires_at,
                        COALESCE(c.session_secret_generation, 0)::int AS session_secret_generation,
                        CASE WHEN d.revoked_at IS NULL THEN '0' ELSE '1' END AS revoked
                   FROM agent_containers c
                   JOIN desktop_devices d ON d.container_id = c.id
                  WHERE c.id = $1 AND c.runtime_kind = 'desktop' AND c.state = 'active'
                  LIMIT 1`,
                [ident.containerId],
              );
              const r = row.rows[0];
              if (!r || r.revoked === "1") return false;
              if (r.session_secret_generation !== upgradeGeneration) return false;
              if (r.session_secret_expires_at && r.session_secret_expires_at.getTime() <= Date.now()) return false;
              markDesktopTunnelHeartbeat(ident.containerId);
              if (deps.v3Deps) void markV3ContainerActivity(deps.v3Deps, ident.containerId);
              return true;
            },
            onActivity: () => {
              if (deps.v3Deps) void markV3ContainerActivity(deps.v3Deps, ident.containerId);
            },
            onClose: () => {
              getDesktopTunnelRegistry().drop(ident.containerId, "ws_close");
              void auditTunnel("tunnel_down", ident.userId, null, ident.containerId);
            },
          });
          try {
            getDesktopTunnelRegistry().attach(ident.containerId, {
              mux,
              close: (code, reason) => {
                try { ws.close(code ?? 4001, reason); } catch { /* */ }
              },
            }, {
              deviceId: extractDeviceId(tls.deviceSpiffe),
              uid: ident.userId,
              expiresAt: exp,
              generation: upgradeGeneration,
            });
          } catch (err) {
            if (err instanceof DesktopTunnelGenerationError) {
              ws.close(1008, "stale_generation");
              return;
            }
            throw err;
          }
          await auditTunnel("tunnel_up", ident.userId, extractDeviceId(tls.deviceSpiffe), ident.containerId);
          if (deps.v3Deps) void markV3ContainerActivity(deps.v3Deps, ident.containerId);
          ws.send(JSON.stringify({
            type: "register_ok",
            v: 1,
            containerId: ident.containerId,
            muxVersion: MUX_VERSION,
            keyringFp: expected ?? hashEmptyKeyring(),
          }));
        })().catch((err) => {
          rootLogger.warn("desktop_register_failed", { err: (err as Error)?.message });
          try { ws.close(1011, "register_failed"); } catch { /* */ }
        });
      });
    });
  })().catch((err) => {
    rootLogger.warn("desktop_register_upgrade_failed", { err: (err as Error)?.message });
    try { socket.destroy(); } catch { /* */ }
  });
}

function extractDeviceId(spiffe: string): string {
  const i = spiffe.lastIndexOf("/");
  return i >= 0 ? spiffe.slice(i + 1) : spiffe;
}

function hashEmptyKeyring(): string {
  return createHash("sha256").update("openclaude-desktop-keyring").digest("hex");
}

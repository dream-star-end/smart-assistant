/**
 * 18445 HTTPS + WSS listener (device mTLS). Flag off → do not bind.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertOriginCertCoversHost, ensureDesktopOriginCert } from "../desktop/deviceCa.js";
import { readDesktopPublicHost } from "../desktop/publicHost.js";
import { extractDesktopTlsContext, stripUntrustedDeviceHeaders } from "../desktop/tlsContext.js";
import { getDesktopFlagSnapshot } from "../desktop/flags.js";
import {
  verifyDesktopIdentity,
  makeDesktopIdentityStrategy,
  type DesktopIdentityRepo,
} from "../auth/desktopIdentity.js";
import { createPgDesktopIdentityRepo } from "./desktopEnroll.js";
import { DESKTOP_REGISTER_PATH, handleDesktopRegisterUpgrade } from "../ws/desktopRegister.js";
import {
  classifyDesktopPath,
  desktopRuntimeManifestAction,
  desktopTokenAction,
  pathnameOf,
  sendDesktopEngineDisabled,
  sendDesktopNotFound,
} from "./desktopInternalDispatch.js";
import { getDesktopTunnelRegistry, sweepDesktopOwnersBeforeListen } from "../ws/desktopTunnelRegistry.js";
import { HttpError, sendJson } from "./util.js";
import { rootLogger } from "../logging/logger.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

export interface DesktopTlsHandlers {
  messages: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  serverAuthored: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  turnTape: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  turnLease: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  catalog: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  /** Master-only: device mTLS token mint. Egress omits → 404. */
  tokenMint?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  /** Master-only: device mTLS token refresh. Egress omits → 404. */
  tokenRefresh?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  /** Master-only: runtime manifest (device mTLS). Egress omits → 404. */
  runtimeManifest?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export type DesktopTlsRole = "master" | "egress";

export interface DesktopTlsListenerOpts {
  bind?: string;
  port?: number;
  role?: DesktopTlsRole;
  /** WSS register belongs on master (same process as DesktopTunnelRegistry). Egress must 404. */
  allowRegister?: boolean;
  handlers: DesktopTlsHandlers;
  identityRepo?: DesktopIdentityRepo;
  v3Deps?: V3SupervisorDeps | null;
}

export interface DesktopTlsListener {
  server: HttpsServer;
  address: { host: string; port: number };
  close(): Promise<void>;
}

export function desktopTlsBindPort(role: DesktopTlsRole = "master"): { bind: string; port: number } {
  if (role === "egress") {
    const bind = process.env.OC_DESKTOP_EGRESS_TLS_BIND?.trim()
      || process.env.OC_DESKTOP_TLS_BIND?.trim()
      || "127.0.0.1";
    const port = Number(process.env.OC_DESKTOP_EGRESS_TLS_PORT ?? "18446");
    return { bind, port: Number.isFinite(port) && port > 0 ? port : 18446 };
  }
  const bind = process.env.OC_DESKTOP_TLS_BIND?.trim() || "127.0.0.1";
  const port = Number(process.env.OC_DESKTOP_TLS_PORT ?? "18445");
  return { bind, port: Number.isFinite(port) && port > 0 ? port : 18445 };
}

/** Master owns WSS register (registry lives in-process). Egress HTTPS must not attach a second registry. */
export function desktopUpgradeAction(role: DesktopTlsRole, pathname: string): "register" | "not_found" {
  if (pathname !== DESKTOP_REGISTER_PATH) return "not_found";
  return role === "egress" ? "not_found" : "register";
}

export async function startDesktopTlsListener(opts: DesktopTlsListenerOpts): Promise<DesktopTlsListener | null> {
  const flags = await getDesktopFlagSnapshot();
  if (!flags.assembled) return null;
  const origin = await ensureDesktopOriginCert();
  await assertOriginCertCoversHost(origin.certPem, readDesktopPublicHost());
  const role: DesktopTlsRole = opts.role ?? "master";
  const allowRegister = opts.allowRegister ?? role !== "egress";
  const explicit = opts.bind !== undefined && opts.port !== undefined;
  const { bind, port } = explicit ? { bind: opts.bind!, port: opts.port! } : desktopTlsBindPort(role);
  const repo = opts.identityRepo ?? createPgDesktopIdentityRepo();

  const server = createHttpsServer(
    {
      key: origin.keyPem,
      cert: origin.certPem,
      ca: origin.caCertPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    (req, res) => {
      void handleHttps(req, res, opts, repo).catch((err) => {
        rootLogger.warn("desktop_tls_handler_threw", { err: (err as Error)?.message });
        if (!res.headersSent) {
          try {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: { code: "INTERNAL", message: "desktop tls error" } }));
          } catch { /* */ }
        }
      });
    },
  );

  await sweepDesktopOwnersBeforeListen();

  server.on("upgrade", (req, socket, head) => {
    const path = pathnameOf(req);
    const action = allowRegister ? desktopUpgradeAction("master", path) : desktopUpgradeAction("egress", path);
    if (action !== "register") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    handleDesktopRegisterUpgrade(req, socket, head, { identityRepo: repo, v3Deps: opts.v3Deps ?? null });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  rootLogger.info("desktop_tls_listening", { bind, port: boundPort, role, allowRegister });
  return {
    server,
    address: { host: bind, port: boundPort },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    }),
  };
}

async function handleHttps(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DesktopTlsListenerOpts,
  repo: DesktopIdentityRepo,
): Promise<void> {
  stripUntrustedDeviceHeaders(req);
  const flags = await getDesktopFlagSnapshot();
  if (!flags.assembled) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
    return;
  }
  if (flags.killSwitch) {
    getDesktopTunnelRegistry().dropAll("killswitch");
    sendJson(res, 503, { error: { code: "DESKTOP_KILLSWITCH", message: "desktop runtime temporarily unavailable" } });
    return;
  }
  const method = req.method ?? "GET";
  const path = pathnameOf(req);
  const kind = classifyDesktopPath(method, path);
  if (kind === "engine_disabled") {
    sendDesktopEngineDisabled(res);
    return;
  }
  if (kind === "not_found") {
    sendDesktopNotFound(res);
    return;
  }
  const role: DesktopTlsRole = opts.role ?? "master";
  if (kind === "tokenMint" || kind === "tokenRefresh") {
    if (desktopTokenAction(role, kind) !== "handle") {
      sendDesktopNotFound(res);
      return;
    }
    const tokenHandler = kind === "tokenMint" ? opts.handlers.tokenMint : opts.handlers.tokenRefresh;
    if (!tokenHandler) {
      sendDesktopNotFound(res);
      return;
    }
    // Token handlers pin the listener-verified peer cert themselves (device
    // credential + fp). They must not go through oc-v3 verifyDesktopIdentity.
    try {
      await tokenHandler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
    return;
  }
  if (kind === "runtimeManifest") {
    if (desktopRuntimeManifestAction(role, kind) !== "handle") {
      sendDesktopNotFound(res);
      return;
    }
    const manifestHandler = opts.handlers.runtimeManifest;
    if (!manifestHandler) {
      sendDesktopNotFound(res);
      return;
    }
    const tlsManifest = extractDesktopTlsContext(req);
    if (!tlsManifest) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "container identity verification failed" } });
      return;
    }
    try {
      await manifestHandler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
    return;
  }
  const tls = extractDesktopTlsContext(req);
  if (!tls) {
    sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "container identity verification failed" } });
    return;
  }
  // Identity for /v1/messages is inside the proxy strategy; other handlers use deps.verify.
  if (kind !== "messages") {
    try {
      await verifyDesktopIdentity(repo, tls, req.headers.authorization);
    } catch {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "container identity verification failed" } });
      return;
    }
  }
  const ctx = { hostUuid: "", boundIp: "" };
  const handler =
    kind === "messages" ? opts.handlers.messages
    : kind === "serverAuthored" ? opts.handlers.serverAuthored
    : kind === "turnTape" ? opts.handlers.turnTape
    : kind === "turnLease" ? opts.handlers.turnLease
    : opts.handlers.catalog;
  await handler(req, res, ctx);
}

export function makeDesktopRequestVerifier(repo: DesktopIdentityRepo) {
  return async (req: IncomingMessage, _ctx: { hostUuid: string; boundIp: string }) => {
    const tls = extractDesktopTlsContext(req);
    if (!tls) {
      const { DesktopIdentityError } = await import("../auth/desktopIdentity.js");
      throw new DesktopIdentityError("TLS_REQUIRED", "missing device cert");
    }
    return verifyDesktopIdentity(repo, tls, req.headers.authorization);
  };
}

export { makeDesktopIdentityStrategy };

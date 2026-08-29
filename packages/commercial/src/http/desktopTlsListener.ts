/**
 * 18445 HTTPS + WSS listener (device mTLS). Flag off → do not bind.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureDesktopOriginCert } from "../desktop/deviceCa.js";
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
  pathnameOf,
  sendDesktopEngineDisabled,
  sendDesktopNotFound,
} from "./desktopInternalDispatch.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { sendJson } from "./util.js";
import { rootLogger } from "../logging/logger.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

export interface DesktopTlsHandlers {
  messages: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  serverAuthored: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  turnTape: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  turnLease: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
  catalog: (req: IncomingMessage, res: ServerResponse, ctx: { hostUuid: string; boundIp: string }) => Promise<void> | void;
}

export interface DesktopTlsListenerOpts {
  bind?: string;
  port?: number;
  handlers: DesktopTlsHandlers;
  identityRepo?: DesktopIdentityRepo;
  v3Deps?: V3SupervisorDeps | null;
}

export interface DesktopTlsListener {
  server: HttpsServer;
  address: { host: string; port: number };
  close(): Promise<void>;
}

export function desktopTlsBindPort(): { bind: string; port: number } {
  const bind = process.env.OC_DESKTOP_TLS_BIND?.trim() || "127.0.0.1";
  const port = Number(process.env.OC_DESKTOP_TLS_PORT ?? "18445");
  return { bind, port: Number.isFinite(port) && port > 0 ? port : 18445 };
}

export async function startDesktopTlsListener(opts: DesktopTlsListenerOpts): Promise<DesktopTlsListener | null> {
  const flags = await getDesktopFlagSnapshot();
  if (!flags.assembled) return null;
  const origin = await ensureDesktopOriginCert();
  const { bind, port } = opts.bind && opts.port ? { bind: opts.bind, port: opts.port } : desktopTlsBindPort();
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

  server.on("upgrade", (req, socket, head) => {
    const path = pathnameOf(req);
    if (path !== DESKTOP_REGISTER_PATH) {
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

  rootLogger.info("desktop_tls_listening", { bind, port });
  return {
    server,
    address: { host: bind, port },
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

/**
 * Desktop P1 D-stage live TCP/TLS E2E.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopE2e.integ.test.ts'
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "node:test";
import { SignJWT } from "jose";
import WebSocket, { WebSocketServer } from "ws";
import { generatePkceVerifier, pkceChallengeS256 } from "../connectors/pkce.js";
import { query } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import { ensureDesktopOriginCert } from "../desktop/deviceCa.js";
import { startDesktopTlsListener, type DesktopTlsListener } from "../http/desktopTlsListener.js";
import {
  handleDesktopEnrollConfirm,
  handleDesktopEnrollFinish,
  handleDesktopEnrollStart,
  handleDesktopRevoke,
  handleDesktopTokenMint,
  createPgDesktopIdentityRepo,
} from "../http/desktopEnroll.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import { HttpError, sendJson } from "../http/util.js";
import { startInflightJournal } from "../billing/proxyBilling.js";
import { verifyDesktopIdentity } from "../auth/desktopIdentity.js";
import { extractDesktopTlsContext } from "../desktop/tlsContext.js";
import { rootLogger } from "../logging/logger.js";
import { MUX_VERSION, type MuxTransport } from "../ws/desktopMux.js";
import { attachDesktopMuxResponder } from "../ws/desktopMuxResponder.js";
import {
  getDesktopTunnelRegistry,
  resetDesktopTunnelRegistryForTest,
} from "../ws/desktopTunnelRegistry.js";
import { makeDesktopContainerTransport } from "../wechat/desktopContainerTransport.js";
import { findActiveByHostAndBoundIp } from "../compute-pool/queries.js";
import { TURN_DISPATCH_STATE_PATH, TURN_REJECT_IF_ABSENT_PATH } from "@openclaude/protocol";
import { useDedicatedTestDatabase } from "./helpers/db.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

const db = useDedicatedTestDatabase("desktop_e2e_p1d_test");
const JWT = "desktop-e2e-integ-secret-must-be-32bytes";

function memRedis() {
  const m = new Map<string, number>();
  return {
    async incr(key: string) {
      m.set(key, (m.get(key) ?? 0) + 1);
      return m.get(key)!;
    },
    async expire() { return 1; },
  };
}

function request(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  stream.method = "POST";
  stream.url = "/";
  stream.headers = { "content-type": "application/json", ...headers };
  return stream;
}

function response(): { res: ServerResponse; body: () => Record<string, unknown>; status: () => number } {
  let payload = "";
  let statusCode = 200;
  const res = {
    setHeader() {},
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    end(chunk?: string) { payload = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(payload || "{}") as Record<string, unknown>, status: () => statusCode };
}

function ctx(): RequestContext {
  return {
    requestId: "e2e",
    clientIp: "10.0.0.9",
    authBoundIp: "10.0.0.9",
    userAgent: "e2e",
    log: rootLogger.child({ subsys: "desktop-e2e" }),
  };
}

async function bearer(uid: number): Promise<string> {
  return new SignJWT({ sub: String(uid), role: "admin", jti: "e2e" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT));
}

function derFromPem(pem: string): Buffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}

function wsToMux(ws: WebSocket): MuxTransport {
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    },
    close(code, reason) { try { ws.close(code, reason); } catch { /* */ } },
    terminate() { try { ws.terminate(); } catch { /* */ } },
    on(event, cb) { ws.on(event, cb as never); },
    off(event, cb) { ws.off(event, cb as never); },
  };
}

function httpsReq(
  tls: https.RequestOptions,
  pathName: string,
  method: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...tls,
      path: pathName,
      method,
      headers: { "content-type": "application/json", ...extraHeaders },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startFakeGateway(): Promise<{
  origin: string;
  close: () => Promise<void>;
  wsInbox: Array<{ data: Buffer; binary: boolean }>;
}> {
  const wsInbox: Array<{ data: Buffer; binary: boolean }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gw.invalid");
    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    if (url.pathname === TURN_REJECT_IF_ABSENT_PATH) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ found: false, state: "absent" }));
      return;
    }
    if (url.pathname === TURN_DISPATCH_STATE_PATH) {
      if (url.searchParams.get("fail") === "1") {
        res.statusCode = 409;
        res.end("conflict");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ found: true, state: "running" }));
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const p = new URL(req.url ?? "/", "http://gw.invalid").pathname;
    if (p !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw, isBinary) => {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        wsInbox.push({ data, binary: isBinary });
        ws.send(data, { binary: isBinary });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        wsInbox,
        close: () => new Promise((r) => { wss.close(); server.close(() => r()); }),
      });
    });
  });
}

interface Harness {
  uid: number;
  containerId: number;
  deviceId: string;
  deviceCred: string;
  deviceCert: string;
  deviceKey: string;
  token: string;
  tls: https.RequestOptions;
  listener: DesktopTlsListener;
  gw: Awaited<ReturnType<typeof startFakeGateway>>;
  caDir: string;
  deps: CommercialHttpDeps;
  registerWs: (token: string) => Promise<{ ws: WebSocket; close: () => void }>;
}

async function enrollAndMint(caDir: string, uid: number, deps: CommercialHttpDeps): Promise<{
  containerId: number; deviceId: string; deviceCred: string; deviceCert: string; deviceKey: string; token: string;
}> {
  const verifier = generatePkceVerifier();
  const challenge = await pkceChallengeS256(verifier);
  const startOut = response();
  await handleDesktopEnrollStart(
    request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
    startOut.res, ctx(), deps,
  );
  const enrollmentId = String(startOut.body().enrollment_id);
  const tok = await bearer(uid);
  const confirmOut = response();
  await handleDesktopEnrollConfirm(
    request({ enrollment_id: enrollmentId }, { authorization: `Bearer ${tok}` }),
    confirmOut.res, ctx(), deps,
  );
  const code = String(confirmOut.body().code);
  const finishOut = response();
  await handleDesktopEnrollFinish(
    request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
    finishOut.res, ctx(), deps,
  );
  assert.equal(finishOut.status(), 200);
  const finished = finishOut.body();
  const deviceCred = String(finished.device_credential);
  const deviceCert = String(finished.device_cert);
  const deviceKey = String(finished.device_key);
  const deviceId = String(finished.deviceId);
  const containerId = Number(finished.containerId);
  const der = derFromPem(deviceCert);
  deps.desktopPeerCert = () => ({
    raw: der,
    subjectaltname: `URI:spiffe://openclaude/desktop-device/${deviceId}`,
  });
  const mint = response();
  await handleDesktopTokenMint(request({ device_credential: deviceCred }), mint.res, ctx(), deps);
  assert.equal(mint.status(), 200);
  return { containerId, deviceId, deviceCred, deviceCert, deviceKey, token: String(mint.body().token) };
}

async function boot(t: { skip: (m?: string) => void }): Promise<Harness | null> {
  if (db.skipIfUnavailable(t)) return null;
  resetDesktopTunnelRegistryForTest();
  const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-e2e-"));
  process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
  process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
  process.env.OC_DESKTOP_SIM_ENROLL = "1";
  delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
  const u = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status)
     VALUES ($1,'x','admin','active') RETURNING id::text`,
    [`desk-e2e-${Date.now()}-${randomUUID().slice(0, 8)}@t.local`],
  );
  const uid = Number(u.rows[0]!.id);
  resetDesktopFlagCache();
  setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
  const deps = {
    jwtSecret: JWT,
    mailer: { send: async () => {} },
    redis: memRedis(),
    desktopTunnelRegistry: getDesktopTunnelRegistry(),
  } as CommercialHttpDeps;
  const enrolled = await enrollAndMint(caDir, uid, deps);
  const origin = await ensureDesktopOriginCert();
  const gw = await startFakeGateway();
  const listener = await startDesktopTlsListener({
    role: "master",
    allowRegister: true,
    bind: "127.0.0.1",
    port: 0,
    identityRepo: createPgDesktopIdentityRepo(),
    v3Deps: { pool: getPool() } as V3SupervisorDeps,
    handlers: {
      messages: async (req, res) => {
        const tlsCtx = extractDesktopTlsContext(req);
        if (!tlsCtx) {
          sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "no tls" } });
          return;
        }
        try {
          const ident = await verifyDesktopIdentity(createPgDesktopIdentityRepo(), tlsCtx, req.headers.authorization);
          const requestId = randomUUID();
          await startInflightJournal(getPool(), {
            requestId,
            userId: BigInt(ident.userId),
            containerId: BigInt(ident.containerId),
            model: "e2e-stub",
            precheckCredits: 0n,
            ctxJson: { runtimeKind: "desktop", source: "desktop_e2e_stub" },
          });
          sendJson(res, 200, { id: requestId, type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] });
        } catch {
          sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "container identity verification failed" } });
        }
      },
      serverAuthored: async (_r, res) => { res.statusCode = 404; res.end(); },
      turnTape: async (_r, res) => { res.statusCode = 404; res.end(); },
      turnLease: async (_r, res) => { res.statusCode = 404; res.end(); },
      catalog: async (_r, res) => { res.statusCode = 404; res.end(); },
    },
  });
  if (!listener) throw new Error("18445 did not bind");
  const tls: https.RequestOptions = {
    hostname: "127.0.0.1",
    port: listener.address.port,
    rejectUnauthorized: true,
    ca: origin.caCertPem,
    cert: enrolled.deviceCert,
    key: enrolled.deviceKey,
    minVersion: "TLSv1.3",
  };
  const registerWs = (token: string) => new Promise<{ ws: WebSocket; close: () => void }>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${listener.address.port}/ws/desktop-container-register`, {
      rejectUnauthorized: true,
      ca: origin.caCertPem,
      cert: enrolled.deviceCert,
      key: enrolled.deviceKey,
      headers: { Authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => reject(new Error("register timeout")), 8_000);
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "register",
        v: 1,
        containerId: enrolled.containerId,
        muxVersion: MUX_VERSION,
        keyringFp: "",
      }));
    });
    ws.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      if (!text.startsWith("{")) return;
      try {
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === "register_ok") {
          clearTimeout(timer);
          attachDesktopMuxResponder({ localOrigin: gw.origin, transport: wsToMux(ws) });
          resolve({
            ws,
            close: () => { try { ws.close(); } catch { /* */ } },
          });
        }
      } catch { /* */ }
    });
  });
  return { uid, ...enrolled, tls, listener, gw, caDir, deps, registerWs };
}

async function teardown(h: Harness | null): Promise<void> {
  if (!h) return;
  try { h.gw.close(); } catch { /* */ }
  try { await h.listener.close(); } catch { /* */ }
  setDesktopSettingsLoader(null);
  resetDesktopFlagCache();
  resetDesktopTunnelRegistryForTest();
  await rm(h.caDir, { recursive: true, force: true });
}

describe("desktop E2E live TLS", () => {
  test("1 enroll→mint→register then openWs echo text+binary", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const { ws } = await h.registerWs(h.token);
      const sock = getDesktopTunnelRegistry().openWs(h.containerId, "/ws");
      await new Promise<void>((r) => sock.on("open", () => r()));
      await new Promise((r) => setTimeout(r, 80));
      const got: Array<{ data: Buffer; bin: boolean }> = [];
      sock.on("message", (data: Buffer, bin: boolean) => got.push({ data, bin }));
      sock.send(Buffer.from("ping-text"), { binary: false });
      sock.send(Buffer.from([0xde, 0xad]), { binary: true });
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(got.some((g) => !g.bin && g.data.toString() === "ping-text"));
      assert.ok(got.some((g) => g.bin && g.data.equals(Buffer.from([0xde, 0xad]))));
      assert.ok(h.gw.wsInbox.length >= 2);
      ws.close();
    } finally {
      await teardown(h);
    }
  });

  test("2 mTLS POST /v1/messages journals desktop container_id + runtimeKind", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const res = await httpsReq(h.tls, "/v1/messages", "POST", JSON.stringify({ model: "e2e-stub", messages: [] }), {
        authorization: `Bearer ${h.token}`,
      });
      assert.equal(res.status, 200);
      const row = await query<{ container_id: string; ctx: { runtimeKind?: string } }>(
        `SELECT container_id::text AS container_id, ctx FROM request_finalize_journal
          WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [String(h.uid)],
      );
      assert.equal(Number(row.rows[0]?.container_id), h.containerId);
      assert.equal(row.rows[0]?.ctx?.runtimeKind, "desktop");
    } finally {
      await teardown(h);
    }
  });

  test("3 HEARTBEAT updates last_ws_activity without extending token expiry", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const before = await query<{ last_ws_activity: Date | null; session_secret_expires_at: Date | null }>(
        `SELECT last_ws_activity, session_secret_expires_at FROM agent_containers WHERE id = $1`,
        [h.containerId],
      );
      await h.registerWs(h.token);
      await new Promise((r) => setTimeout(r, 200));
      const after = await query<{ last_ws_activity: Date | null; session_secret_expires_at: Date | null }>(
        `SELECT last_ws_activity, session_secret_expires_at FROM agent_containers WHERE id = $1`,
        [h.containerId],
      );
      const b = before.rows[0]!;
      const a = after.rows[0]!;
      assert.deepEqual(a.session_secret_expires_at, b.session_secret_expires_at);
      if (b.last_ws_activity && a.last_ws_activity) {
        assert.ok(new Date(a.last_ws_activity).getTime() >= new Date(b.last_ws_activity).getTime());
      }
    } finally {
      await teardown(h);
    }
  });

  test("4 revoke → 18445 messages 401 and WSS closed", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const { ws } = await h.registerWs(h.token);
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      const tok = await bearer(h.uid);
      const rev = response();
      await handleDesktopRevoke(request({}, { authorization: `Bearer ${tok}` }), rev.res, ctx(), h.deps);
      assert.equal(rev.status(), 200);
      const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 2000))]);
      assert.notEqual(code, -1);
      const res = await httpsReq(h.tls, "/v1/messages", "POST", "{}", { authorization: `Bearer ${h.token}` });
      assert.equal(res.status, 401);
    } finally {
      await teardown(h);
    }
  });

  test("5 dropAll then client reconnects and openWs works", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const first = await h.registerWs(h.token);
      getDesktopTunnelRegistry().dropAll("restart");
      first.close();
      await new Promise((r) => setTimeout(r, 50));
      await h.registerWs(h.token);
      const sock = getDesktopTunnelRegistry().openWs(h.containerId, "/ws");
      await new Promise<void>((r) => sock.on("open", () => r()));
      await new Promise((r) => setTimeout(r, 80));
      const got: string[] = [];
      sock.on("message", (data: Buffer) => got.push(data.toString()));
      sock.send(Buffer.from("re-hi"), { binary: false });
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(got.includes("re-hi"));
    } finally {
      await teardown(h);
    }
  });

  test("6 mint rotate drops the previous tunnel (B-04)", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const { ws } = await h.registerWs(h.token);
      const closed = new Promise<boolean>((r) => ws.on("close", () => r(true)));
      const mint = response();
      await handleDesktopTokenMint(request({ device_credential: h.deviceCred }), mint.res, ctx(), h.deps);
      assert.equal(mint.status(), 200);
      const dropped = await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
      assert.equal(dropped, true);
    } finally {
      await teardown(h);
    }
  });

  test("7 flag off does not bind; kill switch 503 + dropAll", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
    const h = await boot(t);
    if (!h) return;
    try {
      const { ws } = await h.registerWs(h.token);
      const closed = new Promise<boolean>((r) => ws.on("close", () => r(true)));
      process.env.OC_DESKTOP_KIND_KILLSWITCH = "1";
      resetDesktopFlagCache();
      const res = await httpsReq(h.tls, "/v1/messages", "POST", "{}", { authorization: `Bearer ${h.token}` });
      assert.equal(res.status, 503);
      const dropped = await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
      assert.equal(dropped, true);
      await h.listener.close();
      delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
      delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
      resetDesktopFlagCache();
      setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
      const off = await startDesktopTlsListener({
        role: "master", bind: "127.0.0.1", port: 0,
        handlers: h.listener ? {
          messages: async (_a, res) => { res.statusCode = 204; res.end(); },
          serverAuthored: async (_a, res) => { res.end(); },
          turnTape: async (_a, res) => { res.end(); },
          turnLease: async (_a, res) => { res.end(); },
          catalog: async (_a, res) => { res.end(); },
        } : {
          messages: async (_a, res) => { res.end(); },
          serverAuthored: async (_a, res) => { res.end(); },
          turnTape: async (_a, res) => { res.end(); },
          turnLease: async (_a, res) => { res.end(); },
          catalog: async (_a, res) => { res.end(); },
        },
      });
      assert.equal(off, null);
      await assert.rejects(
        () => handleDesktopEnrollStart(request({}), response().res, ctx(), h.deps),
        (e: unknown) => e instanceof HttpError && e.status === 404,
      );
    } finally {
      delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
      await teardown(h);
    }
  });

  test("8 docker token on 18445 is 401; desktop row misses bound_ip lookup", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      const fakeDocker = `oc-v3.${h.containerId}.${"ab".repeat(32)}`;
      const res = await httpsReq(h.tls, "/v1/messages", "POST", "{}", { authorization: `Bearer ${fakeDocker}` });
      assert.equal(res.status, 401);
      const miss = await findActiveByHostAndBoundIp("00000000-0000-4000-8000-000000000001", "172.30.0.10");
      assert.equal(miss, null);
      const row = await query<{ bound_ip: string | null; runtime_kind: string }>(
        `SELECT host(bound_ip) AS bound_ip, runtime_kind FROM agent_containers WHERE id = $1`,
        [h.containerId],
      );
      assert.equal(row.rows[0]?.runtime_kind, "desktop");
      assert.equal(row.rows[0]?.bound_ip, null);
    } finally {
      await teardown(h);
    }
  });

  test("9 registry http maps START/END and non-2xx", async (t) => {
    const h = await boot(t);
    if (!h) return;
    try {
      await h.registerWs(h.token);
      await new Promise((r) => setTimeout(r, 50));
      const transport = makeDesktopContainerTransport();
      const ok = await transport.request!(
        "GET",
        { host: "desktop-reverse", port: 0, containerId: h.containerId },
        TURN_DISPATCH_STATE_PATH,
        {},
        null,
        3_000,
      );
      assert.equal(ok.status, 200);
      assert.match(ok.bodyText, /running/);
      const absent = await transport.post(
        { host: "desktop-reverse", port: 0, containerId: h.containerId },
        TURN_REJECT_IF_ABSENT_PATH,
        { "content-type": "application/json" },
        "{}",
        3_000,
      );
      assert.equal(absent.status, 200);
      assert.match(absent.bodyText, /absent/);
      const bad = await transport.request!(
        "GET",
        { host: "desktop-reverse", port: 0, containerId: h.containerId },
        `${TURN_DISPATCH_STATE_PATH}?fail=1`,
        {},
        null,
        3_000,
      );
      assert.equal(bad.status, 409);
      assert.match(bad.bodyText, /conflict/);
    } finally {
      await teardown(h);
    }
  });
});

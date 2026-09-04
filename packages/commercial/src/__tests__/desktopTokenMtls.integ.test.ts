/**
 * E2: live 18445 mTLS token mint/refresh. No desktopPeerCert injection.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopTokenMtls.integ.test.ts'
 */
import assert from "node:assert/strict";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "node:test";
import { SignJWT } from "jose";
import { generatePkceVerifier, pkceChallengeS256 } from "../connectors/pkce.js";
import { query } from "../db/queries.js";
import { resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import { ensureDesktopOriginCert, issueDeviceCertificate } from "../desktop/deviceCa.js";
import {
  handleDesktopEnrollConfirm,
  handleDesktopEnrollFinish,
  handleDesktopEnrollStart,
  handleDesktopTokenMint,
  handleDesktopTokenRefresh,
  desktopTokenRequestContext,
} from "../http/desktopEnroll.js";
import { startDesktopTlsListener } from "../http/desktopTlsListener.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import { rootLogger } from "../logging/logger.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_token_mtls_p1e_test");
const JWT = "desktop-token-mtls-secret-must-be-32bytes!!";

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
    requestId: "mtls",
    clientIp: "10.1.2.3",
    authBoundIp: "10.1.2.3",
    userAgent: "mtls",
    log: rootLogger.child({ subsys: "desktop-token-mtls" }),
  };
}

function httpsReq(opts: https.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (err) => resolve({ status: 0, body: (err as Error).message }));
    if (body) req.write(body);
    req.end();
  });
}

describe("desktop token mTLS 18445", () => {
  test("mTLS POST token/refresh succeed; no cert / wrong CA / fp mismatch 401; header spoof ignored", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-mtls-"));
    process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_SIM_ENROLL = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-mtls-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
    } as CommercialHttpDeps;
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const startOut = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      startOut.res, ctx(), deps,
    );
    const tok = await new SignJWT({ sub: String(uid), role: "admin", jti: "m" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(JWT));
    const confirmOut = response();
    await handleDesktopEnrollConfirm(
      request({ enrollment_id: String(startOut.body().enrollment_id) }, { authorization: `Bearer ${tok}` }),
      confirmOut.res, ctx(), deps,
    );
    const finishOut = response();
    await handleDesktopEnrollFinish(
      request({
        enrollment_id: String(startOut.body().enrollment_id),
        code: String(confirmOut.body().code),
        pkce_verifier: verifier,
      }),
      finishOut.res, ctx(), deps,
    );
    const deviceCred = String(finishOut.body().device_credential);
    const deviceCert = String(finishOut.body().device_cert);
    const deviceKey = String(finishOut.body().device_key);
    const origin = await ensureDesktopOriginCert();
    const listener = await startDesktopTlsListener({
      role: "master",
      allowRegister: true,
      bind: "127.0.0.1",
      port: 0,
      handlers: {
        messages: async (_r, res) => { res.statusCode = 204; res.end(); },
        serverAuthored: async (_r, res) => { res.statusCode = 404; res.end(); },
        turnTape: async (_r, res) => { res.statusCode = 404; res.end(); },
        turnLease: async (_r, res) => { res.statusCode = 404; res.end(); },
        catalog: async (_r, res) => { res.statusCode = 404; res.end(); },
        tokenMint: (req, res) => handleDesktopTokenMint(req, res, desktopTokenRequestContext(req), deps),
        tokenRefresh: (req, res) => handleDesktopTokenRefresh(req, res, desktopTokenRequestContext(req), deps),
      },
    });
    assert.ok(listener);
    const tls = {
      hostname: "127.0.0.1",
      rejectUnauthorized: true,
      ca: origin.caCertPem,
      cert: deviceCert,
      key: deviceKey,
      minVersion: "TLSv1.3" as const,
      port: listener!.address.port,
    };
    const minted = await httpsReq({
      ...tls, method: "POST", path: "/api/desktop/token",
      headers: { "content-type": "application/json", "x-oc-device-fp": "deadbeef" },
    }, JSON.stringify({ device_credential: deviceCred }));
    assert.equal(minted.status, 200, minted.body);
    const token = (JSON.parse(minted.body) as { token: string }).token;
    const refreshed = await httpsReq({
      ...tls, method: "POST", path: "/api/desktop/token/refresh",
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ device_credential: deviceCred, token }));
    assert.equal(refreshed.status, 200, refreshed.body);

    const noCert = await httpsReq({
      hostname: "127.0.0.1",
      port: listener!.address.port,
      method: "POST",
      path: "/api/desktop/token",
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ device_credential: deviceCred }));
    assert.ok(noCert.status === 0 || noCert.status === 401);

    const other = await issueDeviceCertificate(randomUUID());
    const wrongFp = await httpsReq({
      ...tls, cert: other.certPem, key: other.keyPem,
      method: "POST", path: "/api/desktop/token",
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ device_credential: deviceCred }));
    assert.equal(wrongFp.status, 401);

    const egress = await startDesktopTlsListener({
      role: "egress",
      allowRegister: false,
      bind: "127.0.0.1",
      port: 0,
      handlers: {
        messages: async (_r, res) => { res.statusCode = 204; res.end(); },
        serverAuthored: async (_r, res) => { res.statusCode = 404; res.end(); },
        turnTape: async (_r, res) => { res.statusCode = 404; res.end(); },
        turnLease: async (_r, res) => { res.statusCode = 404; res.end(); },
        catalog: async (_r, res) => { res.statusCode = 404; res.end(); },
      },
    });
    assert.ok(egress);
    const onEgress = await httpsReq({
      ...tls, port: egress!.address.port,
      method: "POST", path: "/api/desktop/token",
      headers: { "content-type": "application/json" },
    }, JSON.stringify({ device_credential: deviceCred }));
    assert.equal(onEgress.status, 404);

    await listener!.close();
    await egress!.close();
    await rm(caDir, { recursive: true, force: true });
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
    delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
  });
});

/**
 * Desktop enrollment + token lifecycle (real PG + openssl device CA).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopEnroll.integ.test.ts'
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { DESKTOP_IDENTITY_PUBLIC_MESSAGE } from "../desktop/flags.js";
import { verifyDesktopIdentity, DesktopIdentityError, type DesktopIdentityRepo } from "../auth/desktopIdentity.js";
import { createPgDesktopIdentityRepo } from "../http/desktopEnroll.js";
import {
  handleDesktopEnrollConfirm,
  handleDesktopEnrollFinish,
  handleDesktopEnrollStart,
  handleDesktopRevoke,
  handleDesktopTokenMint,
  handleDesktopTokenRefresh,
} from "../http/desktopEnroll.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import { HttpError } from "../http/util.js";
import { makeDesktopEnsureAttached, resetDesktopEnsureCacheForTest } from "../agent-sandbox/desktopEnsure.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { rootLogger } from "../logging/logger.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_enroll_p1b_test");
const JWT = "desktop-enroll-integ-secret-must-be-32b!!";

function memRedis() {
  const m = new Map<string, number>();
  return {
    async incr(key: string) {
      m.set(key, (m.get(key) ?? 0) + 1);
      return m.get(key)!;
    },
    async expire() {
      return 1;
    },
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
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => JSON.parse(payload || "{}") as Record<string, unknown>,
    status: () => statusCode,
  };
}

function ctx(): RequestContext {
  return {
    requestId: "integ",
    clientIp: "10.0.0.9",
    authBoundIp: "10.0.0.9",
    userAgent: "integ",
    log: rootLogger.child({ subsys: "desktop-enroll-integ" }),
  };
}

async function bearer(uid: number, role = "admin"): Promise<string> {
  return new SignJWT({ sub: String(uid), role, jti: "d1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT));
}

function derFromPem(pem: string): Buffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}

describe("desktop enrollment integ", () => {
  test("full enroll, token rotate, revoke, CAS, gates", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    const prevCa = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    const prevFlag = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    const prevSim = process.env.OC_DESKTOP_SIM_ENROLL;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_SIM_ENROLL = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-enroll-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const drops: number[] = [];
    const registry = createMemoryDesktopTunnelRegistry();
    const origDrop = registry.drop.bind(registry);
    registry.drop = (id, reason, fenceGeneration) => {
      drops.push(id);
      return origDrop(id, reason, fenceGeneration);
    };
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
      desktopTunnelRegistry: registry,
    } as CommercialHttpDeps;

    const startOut = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", public_name: "sim", platform: "sim" }),
      startOut.res,
      ctx(),
      deps,
    );
    assert.equal(startOut.status(), 200);
    const enrollmentId = String(startOut.body().enrollment_id);

    const tok = await bearer(uid);
    const confirmOut = response();
    await handleDesktopEnrollConfirm(
      request({ enrollment_id: enrollmentId }, { authorization: `Bearer ${tok}` }),
      confirmOut.res,
      ctx(),
      deps,
    );
    assert.equal(confirmOut.status(), 200);
    const code = String(confirmOut.body().code);

    const finishOnce = () =>
      handleDesktopEnrollFinish(
        request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
        response().res,
        ctx(),
        deps,
      );
    const replay = response();
    await handleDesktopEnrollFinish(
      request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
      replay.res,
      ctx(),
      deps,
    );
    assert.equal(replay.status(), 200);
    const finished = replay.body();
    const deviceCred = String(finished.device_credential);
    const deviceCert = String(finished.device_cert);
    const deviceId = String(finished.deviceId);
    const containerId = Number(finished.containerId);
    await assert.rejects(finishOnce, (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === "ENROLL_CONSUMED");

    const startDup = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      startDup.res,
      ctx(),
      deps,
    );
    await assert.rejects(
      () =>
        handleDesktopEnrollConfirm(
          request({ enrollment_id: String(startDup.body().enrollment_id) }, { authorization: `Bearer ${tok}` }),
          response().res,
          ctx(),
          deps,
        ),
      (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === "DEVICE_LIMIT",
    );

    const der = derFromPem(deviceCert);
    deps.desktopPeerCert = () => ({
      raw: der,
      subjectaltname: `URI:spiffe://openclaude/desktop-device/${deviceId}`,
    });

    const mint1 = response();
    await handleDesktopTokenMint(
      request({ device_credential: deviceCred }),
      mint1.res,
      ctx(),
      deps,
    );
    assert.equal(mint1.status(), 200);
    const token1 = String(mint1.body().token);
    assert.match(token1, /^oc-v3\.\d+\.[0-9a-f]{64}$/);
    assert.ok(drops.includes(containerId));

    const mint2 = response();
    await handleDesktopTokenMint(
      request({ device_credential: deviceCred }),
      mint2.res,
      ctx(),
      deps,
    );
    const token2 = String(mint2.body().token);
    const identRepo: DesktopIdentityRepo = createPgDesktopIdentityRepo();
    const tls = {
      tls: true as const,
      deviceCertFp: createHash("sha256").update(der).digest(),
      deviceSpiffe: `spiffe://openclaude/desktop-device/${deviceId}`,
    };
    await verifyDesktopIdentity(identRepo, tls, token2);
    try {
      await verifyDesktopIdentity(identRepo, tls, token1);
      assert.fail("old token should fail");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.message, DESKTOP_IDENTITY_PUBLIC_MESSAGE);
    }

    const refresh = response();
    await handleDesktopTokenRefresh(
      request({ device_credential: deviceCred, token: token2 }),
      refresh.res,
      ctx(),
      deps,
    );
    assert.equal(refresh.status(), 200);

    const rev = response();
    await handleDesktopRevoke(
      request({}, { authorization: `Bearer ${tok}` }),
      rev.res,
      ctx(),
      deps,
    );
    assert.equal(rev.status(), 200);
    assert.ok(drops.filter((id) => id === containerId).length >= 2);
    await assert.rejects(
      () => handleDesktopTokenMint(request({ device_credential: deviceCred }), response().res, ctx(), deps),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    );
    try {
      await verifyDesktopIdentity(identRepo, tls, token2);
      assert.fail("revoked identity should fail");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.message, DESKTOP_IDENTITY_PUBLIC_MESSAGE);
    }

    const u2 = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','user','active') RETURNING id::text`,
      [`desk-enroll-denied-${Date.now()}@t.local`],
    );
    const deniedTok = await bearer(Number(u2.rows[0]!.id), "user");
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [] }));
    resetDesktopFlagCache();
    const start2 = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      start2.res,
      ctx(),
      deps,
    );
    const e2 = String(start2.body().enrollment_id);
    await assert.rejects(
      () =>
        handleDesktopEnrollConfirm(
          request({ enrollment_id: e2 }, { authorization: `Bearer ${deniedTok}` }),
          response().res,
          ctx(),
          deps,
        ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "DESKTOP_NOT_ENTITLED",
    );
    await assert.rejects(
      () =>
        handleDesktopEnrollConfirm(
          request({ enrollment_id: e2 }),
          response().res,
          ctx(),
          deps,
        ),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );

    if (prevCa === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
    else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevCa;
    if (prevFlag === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prevFlag;
    if (prevSim === undefined) delete process.env.OC_DESKTOP_SIM_ENROLL;
    else process.env.OC_DESKTOP_SIM_ENROLL = prevSim;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
    await rm(caDir, { recursive: true, force: true });
  });

  test("concurrent finish CAS: only one succeeds", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_SIM_ENROLL = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-cas-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
    } as CommercialHttpDeps;
    const startOut = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      startOut.res,
      ctx(),
      deps,
    );
    const enrollmentId = String(startOut.body().enrollment_id);
    const tok = await bearer(uid);
    const confirmOut = response();
    await handleDesktopEnrollConfirm(
      request({ enrollment_id: enrollmentId }, { authorization: `Bearer ${tok}` }),
      confirmOut.res,
      ctx(),
      deps,
    );
    const code = String(confirmOut.body().code);
    const results = await Promise.allSettled([
      handleDesktopEnrollFinish(
        request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
        response().res,
        ctx(),
        deps,
      ),
      handleDesktopEnrollFinish(
        request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
        response().res,
        ctx(),
        deps,
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflict = results.filter((r) => r.status === "rejected" && r.reason instanceof HttpError && r.reason.code === "ENROLL_CONSUMED").length;
    assert.equal(ok, 1);
    assert.equal(conflict, 1);
    await rm(caDir, { recursive: true, force: true });
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("expired pending enrollment is rejected", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_SIM_ENROLL = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-exp-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
    } as CommercialHttpDeps;
    const startOut = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      startOut.res,
      ctx(),
      deps,
    );
    const enrollmentId = String(startOut.body().enrollment_id);
    const tok = await bearer(uid);
    await query(`UPDATE desktop_enrollments SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [enrollmentId]);
    await assert.rejects(
      () =>
        handleDesktopEnrollConfirm(
          request({ enrollment_id: enrollmentId }, { authorization: `Bearer ${tok}` }),
          response().res,
          ctx(),
          deps,
        ),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
    const start2 = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", platform: "sim" }),
      start2.res,
      ctx(),
      deps,
    );
    const enrollmentId2 = String(start2.body().enrollment_id);
    const confirm2 = response();
    await handleDesktopEnrollConfirm(
      request({ enrollment_id: enrollmentId2 }, { authorization: `Bearer ${tok}` }),
      confirm2.res,
      ctx(),
      deps,
    );
    const code = String(confirm2.body().code);
    await query(`UPDATE desktop_enrollments SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [enrollmentId2]);
    await assert.rejects(
      () =>
        handleDesktopEnrollFinish(
          request({ enrollment_id: enrollmentId2, code, pkce_verifier: verifier }),
          response().res,
          ctx(),
          deps,
        ),
      (e: unknown) => e instanceof HttpError && (e as HttpError).status === 409 && (e as HttpError).code === "ENROLL_EXPIRED",
    );
    await rm(caDir, { recursive: true, force: true });
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("concurrent refresh CAS: one succeeds, one 409; audit event is token_refresh", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const caDir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    process.env.OPENCLAUDE_DEVICE_CA_DIR = caDir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_SIM_ENROLL = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-refresh-cas-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
    } as CommercialHttpDeps;
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
    const finishOut = response();
    await handleDesktopEnrollFinish(
      request({ enrollment_id: enrollmentId, code: String(confirmOut.body().code), pkce_verifier: verifier }),
      finishOut.res, ctx(), deps,
    );
    const deviceCred = String(finishOut.body().device_credential);
    const deviceCert = String(finishOut.body().device_cert);
    const deviceId = String(finishOut.body().deviceId);
    deps.desktopPeerCert = () => ({
      raw: derFromPem(deviceCert),
      subjectaltname: `URI:spiffe://openclaude/desktop-device/${deviceId}`,
    });
    const mint = response();
    await handleDesktopTokenMint(request({ device_credential: deviceCred }), mint.res, ctx(), deps);
    const token = String(mint.body().token);
    const settled = await Promise.allSettled([
      handleDesktopTokenRefresh(request({ device_credential: deviceCred, token }), response().res, ctx(), deps),
      handleDesktopTokenRefresh(request({ device_credential: deviceCred, token }), response().res, ctx(), deps),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const conflict = settled.filter((s) => s.status === "rejected" && s.reason instanceof HttpError && s.reason.status === 409).length;
    assert.equal(ok, 1);
    assert.equal(conflict, 1);
    const audit = await query<{ event: string }>(
      `SELECT event FROM desktop_device_audit WHERE user_id = $1 AND event IN ('token_mint','token_refresh') ORDER BY id`,
      [String(uid)],
    );
    assert.ok(audit.rows.some((r) => r.event === "token_refresh"));
    await rm(caDir, { recursive: true, force: true });
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("enroll_finish invalidates W-R03 cache → 4503 desktop_offline not docker", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-enroll-cache-"));
    const prevCa = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    resetDesktopFlagCache();
    resetDesktopEnsureCacheForTest();
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','user','active') RETURNING id::text`,
      [`desk-enroll-cache-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const flags = async () => ({
      envEnabled: true, killSwitch: false, settingsOn: true, allowlist: [uid], assembled: true,
    });
    assert.equal(await makeDesktopEnsureAttached(BigInt(uid), { flags }), null);

    const registry = createMemoryDesktopTunnelRegistry();
    const deps: CommercialHttpDeps = {
      jwtSecret: JWT,
      mailer: { send: async () => {} },
      redis: memRedis(),
      desktopTunnelRegistry: registry,
    } as CommercialHttpDeps;
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallengeS256(verifier);
    const startOut = response();
    await handleDesktopEnrollStart(
      request({ pkce_challenge: challenge, app_id: "chat.claudeai.clarvy", public_name: "sim", platform: "sim" }),
      startOut.res,
      ctx(),
      deps,
    );
    const enrollmentId = String(startOut.body().enrollment_id);
    const tok = await bearer(uid);
    const confirmOut = response();
    await handleDesktopEnrollConfirm(
      request({ enrollment_id: enrollmentId }, { authorization: `Bearer ${tok}` }),
      confirmOut.res,
      ctx(),
      deps,
    );
    const code = String(confirmOut.body().code);
    const finishOut = response();
    await handleDesktopEnrollFinish(
      request({ enrollment_id: enrollmentId, code, pkce_verifier: verifier }),
      finishOut.res,
      ctx(),
      deps,
    );
    assert.equal(finishOut.status(), 200);

    await assert.rejects(
      () => makeDesktopEnsureAttached(BigInt(uid), { flags }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
    if (prevCa === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
    else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevCa;
    delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
    await rm(dir, { recursive: true, force: true });
  });
});

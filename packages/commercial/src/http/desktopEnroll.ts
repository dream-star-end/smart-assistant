/**
 * Desktop enrollment + token lifecycle (design v2 §3).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rootLogger } from "../logging/logger.js";
import type { Pool, PoolClient } from "pg";
import { pkceChallengeS256 } from "../connectors/pkce.js";
import { compareHash, hashSecret, parseContainerToken } from "../auth/containerIdentity.js";
import { verifyDesktopIdentity, type DesktopIdentityRepo, type DesktopIdentityTlsCtx } from "../auth/desktopIdentity.js";
import { verifyCommercialJwtSync } from "../auth/jwtSync.js";
import { query, tx } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { issueDeviceCertificate } from "../desktop/deviceCa.js";
import {
  DESKTOP_APP_ID,
  DESKTOP_ENROLL_TTL_MS,
  DESKTOP_PENDING_GLOBAL_CAP,
  DESKTOP_PENDING_IP_CAP,
  DESKTOP_TOKEN_TTL_SEC,
  getDesktopFlagSnapshot,
  isDesktopEntitled,
  isSimEnrollAllowed,
  type DesktopFlagSnapshot,
} from "../desktop/flags.js";
import { extractDesktopTlsContext } from "../desktop/tlsContext.js";
import { getDesktopTunnelRegistry, type DesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { OPENCLAUDE_CONTAINER_GATEWAY_PORT } from "@openclaude/protocol";
import { requireActiveAccountVerifyDb } from "./requireUser.js";
import { HttpError, readJsonBody, sendJson } from "./util.js";
import { enforceRateLimit, type CommercialHttpDeps, type RequestContext } from "./handlers.js";
import type { RateLimitConfig } from "../middleware/rateLimit.js";
import { getBearerToken } from "./authHelpers.js";

export const DESKTOP_RATE_LIMITS = {
  enrollStartIp: { scope: "desktop_enroll_start", windowSeconds: 600, max: 20 } satisfies RateLimitConfig,
  enrollConfirmIp: { scope: "desktop_enroll_confirm", windowSeconds: 600, max: 10 } satisfies RateLimitConfig,
  enrollConfirmUid: { scope: "desktop_enroll_confirm_uid", windowSeconds: 600, max: 5 } satisfies RateLimitConfig,
  enrollFinishIp: { scope: "desktop_enroll_finish", windowSeconds: 600, max: 10 } satisfies RateLimitConfig,
  tokenIp: { scope: "desktop_token", windowSeconds: 600, max: 30 } satisfies RateLimitConfig,
  tokenUid: { scope: "desktop_token_uid", windowSeconds: 600, max: 20 } satisfies RateLimitConfig,
  tokenDevice: { scope: "desktop_token_device", windowSeconds: 600, max: 10 } satisfies RateLimitConfig,
};

export function desktopTokenRequestContext(req: IncomingMessage): RequestContext {
  const ip = (req.socket?.remoteAddress ?? "0.0.0.0").replace(/^::ffff:/, "");
  return {
    requestId: randomUUID(),
    clientIp: ip,
    authBoundIp: ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    log: rootLogger.child({ subsys: "desktop-token" }),
  };
}

export function parseDeviceCredential(raw: string | undefined): { deviceId: string; secret: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new HttpError(401, "BAD_TOKEN_FORMAT", "missing device credential");
  }
  const trimmed = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  const m = /^oc-dv\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/i.exec(trimmed);
  if (!m) throw new HttpError(401, "BAD_TOKEN_FORMAT", "device credential does not match oc-dv.<uuid>.<secret>");
  return { deviceId: m[1]!.toLowerCase(), secret: m[2]!.toLowerCase() };
}

function isAllZero(buf: Buffer): boolean {
  return buf.every((b) => b === 0);
}

function randomSecretHex(): string {
  return randomBytes(32).toString("hex");
}

async function audit(
  client: PoolClient | typeof query,
  args: {
    event: string;
    userId: number;
    deviceId?: string | null;
    enrollmentId?: string | null;
    containerId?: number | null;
    ip?: string | null;
    userAgent?: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const sql = `INSERT INTO desktop_device_audit(device_id, enrollment_id, user_id, event, container_id, ip, user_agent, extra)
               VALUES ($1,$2,$3,$4,$5,$6::inet,$7,$8::jsonb)`;
  const params = [
    args.deviceId ?? null,
    args.enrollmentId ?? null,
    String(args.userId),
    args.event,
    args.containerId ?? null,
    args.ip ?? null,
    args.userAgent ?? null,
    JSON.stringify(args.extra ?? {}),
  ];
  if (typeof client === "function") {
    await query(sql, params);
  } else {
    await client.query(sql, params);
  }
}

export function createPgDesktopIdentityRepo(): DesktopIdentityRepo {
  return {
    async findActiveDesktopById(id, channel) {
      const r = await query<{
        id: string;
        user_id: string;
        secret_hash: Buffer | null;
        session_secret_expires_at: Date | null;
        session_secret_generation: number;
        issued_by_host_uuid: string | null;
        update_required: boolean;
        runtime_kind: string;
        state: string;
      }>(
        `SELECT id::text AS id, user_id::text AS user_id, secret_hash, session_secret_expires_at,
                COALESCE(session_secret_generation, 0)::int AS session_secret_generation,
                issued_by_host_uuid::text AS issued_by_host_uuid, update_required, runtime_kind, state
           FROM agent_containers
          WHERE id = $1 AND state = 'active' AND runtime_kind = 'desktop' AND runtime_channel = $2
          LIMIT 1`,
        [id, channel],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        user_id: Number(row.user_id),
        secret_hash: row.secret_hash,
        session_secret_expires_at: row.session_secret_expires_at,
        session_secret_generation: Number(row.session_secret_generation ?? 0),
        issued_by_host_uuid: row.issued_by_host_uuid,
        update_required: row.update_required,
        runtime_kind: row.runtime_kind,
        state: row.state,
      };
    },
    async findLiveDeviceByContainerId(containerId) {
      const r = await query<{
        id: string;
        user_id: string;
        container_id: string;
        tls_client_fp: Buffer;
        revoked_at: Date | null;
      }>(
        `SELECT id::text AS id, user_id::text AS user_id, container_id::text AS container_id,
                tls_client_fp, revoked_at
           FROM desktop_devices
          WHERE container_id = $1 AND revoked_at IS NULL
          LIMIT 1`,
        [containerId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        user_id: Number(row.user_id),
        container_id: Number(row.container_id),
        tls_client_fp: row.tls_client_fp,
        revoked_at: row.revoked_at,
      };
    },
    async recordDeviceAudit(event, args) {
      await audit(query, {
        event,
        userId: args.userId,
        deviceId: args.deviceId,
        containerId: args.containerId,
        extra: args.extra,
      });
    },
  };
}

async function requireAssembled(flags: DesktopFlagSnapshot): Promise<void> {
  if (!flags.assembled) {
    throw new HttpError(404, "NOT_FOUND", "not found");
  }
}

async function requireNotKilled(flags: DesktopFlagSnapshot): Promise<void> {
  if (flags.killSwitch) {
    throw new HttpError(503, "DESKTOP_KILLSWITCH", "desktop runtime temporarily unavailable");
  }
}

function publicOrigin(deps: CommercialHttpDeps): string {
  const base = deps.verifyEmailUrlBase ?? process.env.OPENCLAUDE_PUBLIC_ORIGIN ?? "";
  try {
    if (base) return new URL(base).origin;
  } catch { /* ignore */ }
  return "https://claudeai.chat";
}

export async function handleDesktopEnrollStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  await requireNotKilled(flags);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.enrollStartIp, ctx.clientIp);
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const pkce_challenge = typeof body.pkce_challenge === "string" ? body.pkce_challenge.trim() : "";
  const app_id = typeof body.app_id === "string" ? body.app_id.trim() : "";
  const public_name = typeof body.public_name === "string" ? body.public_name.slice(0, 128) : "";
  const platform = typeof body.platform === "string" ? body.platform : "";
  if (app_id !== DESKTOP_APP_ID) throw new HttpError(400, "INVALID_APP_ID", "invalid app_id");
  if (platform !== "windows" && platform !== "sim") throw new HttpError(400, "INVALID_PLATFORM", "invalid platform");
  if (!isSimEnrollAllowed(platform)) throw new HttpError(400, "INVALID_PLATFORM", "sim enroll disabled");
  if (pkce_challenge.length < 43 || pkce_challenge.length > 128) {
    throw new HttpError(400, "INVALID_PKCE", "invalid pkce_challenge");
  }
  const globalPending = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM desktop_enrollments WHERE consumed_at IS NULL`,
  );
  if (Number(globalPending.rows[0]?.n ?? "0") >= DESKTOP_PENDING_GLOBAL_CAP) {
    throw new HttpError(429, "ENROLL_CAPACITY", "too many pending enrollments");
  }
  const ipPending = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM desktop_enrollments WHERE consumed_at IS NULL AND client_ip = $1::inet`,
    [ctx.clientIp],
  );
  if (Number(ipPending.rows[0]?.n ?? "0") >= DESKTOP_PENDING_IP_CAP) {
    throw new HttpError(429, "ENROLL_CAPACITY", "too many pending enrollments from this IP");
  }
  const id = randomUUID();
  const expires = new Date(Date.now() + DESKTOP_ENROLL_TTL_MS);
  await query(
    `INSERT INTO desktop_enrollments(id, app_id, public_name, platform, pkce_challenge, expires_at, client_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7::inet,$8)`,
    [id, DESKTOP_APP_ID, public_name, platform, pkce_challenge, expires, ctx.clientIp, ctx.userAgent],
  );
  const auth_url = `${publicOrigin(deps)}/desktop/enroll?enrollment_id=${id}`;
  sendJson(res, 200, { enrollment_id: id, auth_url, expires_at: expires.toISOString() });
}

async function loadUser(deps: CommercialHttpDeps, req: IncomingMessage): Promise<{ uid: number; role: string }> {
  const token = getBearerToken(req);
  const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null;
  if (!claims) throw new HttpError(401, "UNAUTHORIZED", "login required");
  const pool = getPool();
  const verified = await requireActiveAccountVerifyDb(claims.sub, ["user", "admin"], pool);
  if (!verified) throw new HttpError(403, "DESKTOP_NOT_ENTITLED", "not entitled");
  return { uid: Number(verified.id), role: verified.role };
}

export async function handleDesktopEnrollConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  await requireNotKilled(flags);
  const user = await loadUser(deps, req);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.enrollConfirmIp, ctx.clientIp);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.enrollConfirmUid, `u:${user.uid}`);
  if (!isDesktopEntitled(user.uid, user.role, flags.allowlist)) {
    throw new HttpError(403, "DESKTOP_NOT_ENTITLED", "not entitled");
  }
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const enrollment_id = typeof body.enrollment_id === "string" ? body.enrollment_id : "";
  if (!enrollment_id) throw new HttpError(400, "INVALID_ENROLLMENT", "enrollment_id required");
  const live = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM desktop_devices WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.uid],
  );
  if (Number(live.rows[0]?.n ?? "0") > 0) {
    throw new HttpError(409, "DEVICE_LIMIT", "user already has a live desktop device");
  }
  const code = randomBytes(32).toString("hex");
  const codeHash = createHash("sha256").update(code, "utf8").digest();
  const upd = await query<{ id: string; platform: string }>(
    `UPDATE desktop_enrollments
        SET user_id = $2, code_hash = $3, updated_at = NOW()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()
        AND (user_id IS NULL OR user_id = $2)
      RETURNING id::text AS id, platform`,
    [enrollment_id, user.uid, codeHash],
  );
  if (upd.rowCount === 0) throw new HttpError(409, "ENROLL_INVALID", "enrollment not pending");
  await audit(query, {
    event: "enroll_confirm",
    userId: user.uid,
    enrollmentId: enrollment_id,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
  const platform = upd.rows[0]!.platform;
  const deep_link = `openclaude://enroll/callback?enrollment_id=${enrollment_id}&code=${code}`;
  sendJson(res, 200, {
    enrollment_id,
    code,
    deep_link: platform === "sim" ? null : deep_link,
  });
}

async function lookupIssuedByHost(): Promise<string | null> {
  const envId = process.env.COMPUTE_POOL_SELF_HOST_UUID?.trim();
  if (envId) return envId;
  const r = await query<{ id: string }>(`SELECT id::text AS id FROM compute_hosts WHERE name = 'self' LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

export async function handleDesktopEnrollFinish(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  await requireNotKilled(flags);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.enrollFinishIp, ctx.clientIp);
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const enrollment_id = typeof body.enrollment_id === "string" ? body.enrollment_id : "";
  const code = typeof body.code === "string" ? body.code : "";
  const pkce_verifier = typeof body.pkce_verifier === "string" ? body.pkce_verifier : "";
  if (!enrollment_id || !code || !pkce_verifier) {
    throw new HttpError(400, "INVALID_FINISH", "enrollment_id, code, pkce_verifier required");
  }
  const issuedBy = await lookupIssuedByHost();
  const result = await tx(async (client) => {
    const sel = await client.query<{
      id: string;
      pkce_challenge: string;
      code_hash: Buffer | null;
      user_id: string | null;
      consumed_at: Date | null;
      expires_at: Date;
      platform: string;
      public_name: string;
    }>(
      `SELECT id::text AS id, pkce_challenge, code_hash, user_id::text AS user_id,
              consumed_at, expires_at, platform, public_name
         FROM desktop_enrollments
        WHERE id = $1
        FOR UPDATE`,
      [enrollment_id],
    );
    const row = sel.rows[0];
    if (!row) throw new HttpError(404, "ENROLL_NOT_FOUND", "enrollment not found");
    if (row.consumed_at) throw new HttpError(409, "ENROLL_CONSUMED", "enrollment already consumed");
    if (row.expires_at.getTime() <= Date.now()) throw new HttpError(409, "ENROLL_EXPIRED", "enrollment expired");
    if (!row.user_id || !row.code_hash) throw new HttpError(409, "ENROLL_NOT_CONFIRMED", "enrollment not confirmed");
    const challenge = await pkceChallengeS256(pkce_verifier);
    if (challenge !== row.pkce_challenge) throw new HttpError(401, "PKCE_MISMATCH", "pkce verifier mismatch");
    const codeHash = createHash("sha256").update(code, "utf8").digest();
    if (!compareHash(codeHash, row.code_hash)) throw new HttpError(401, "CODE_MISMATCH", "authorization code mismatch");
    const uid = Number(row.user_id);
    const live = await client.query(
      `SELECT 1 FROM desktop_devices WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [uid],
    );
    if ((live.rowCount ?? 0) > 0) throw new HttpError(409, "DEVICE_LIMIT", "user already has a live desktop device");
    const deviceId = randomUUID();
    const credentialSecret = randomSecretHex();
    const credentialBytes = Buffer.from(credentialSecret, "hex");
    if (isAllZero(credentialBytes)) throw new HttpError(500, "INTERNAL", "credential generation failed");
    const credentialHash = hashSecret(credentialSecret);
    if (isAllZero(credentialHash)) throw new HttpError(500, "INTERNAL", "credential generation failed");
    const placeholderSecret = randomSecretHex();
    const issued = await issueDeviceCertificate(deviceId);
    const channel = getRuntimeChannel();
    const ins = await client.query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, issued_by_host_uuid, last_ws_activity, created_at, updated_at
       ) VALUES (
         $1, NULL, NULL, $2, 'active', $3, $4, $5, 'desktop', $6::uuid, NOW(), NOW(), NOW()
       ) RETURNING id::text AS id`,
      [
        uid,
        hashSecret(placeholderSecret),
        OPENCLAUDE_CONTAINER_GATEWAY_PORT,
        "desktop-gateway",
        channel,
        issuedBy && /^[0-9a-f-]{36}$/i.test(issuedBy) ? issuedBy : null,
      ],
    );
    const containerId = Number(ins.rows[0]!.id);
    await client.query(
      `INSERT INTO desktop_devices(
         id, user_id, container_id, enrollment_id, credential_hash, public_name, platform, app_id,
         tls_client_fp, cert_serial, cert_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        deviceId,
        uid,
        containerId,
        enrollment_id,
        credentialHash,
        row.public_name,
        row.platform,
        DESKTOP_APP_ID,
        issued.tlsClientFp,
        issued.serial,
        issued.certExpiresAt,
      ],
    );
    const cas = await client.query(
      `UPDATE desktop_enrollments
          SET consumed_at = NOW(), container_id = $2, device_id = $3::uuid, updated_at = NOW()
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [enrollment_id, containerId, deviceId],
    );
    if ((cas.rowCount ?? 0) === 0) throw new HttpError(409, "ENROLL_CONSUMED", "enrollment already consumed");
    await audit(client, {
      event: "enroll_finish",
      userId: uid,
      deviceId,
      enrollmentId: enrollment_id,
      containerId,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    return {
      deviceId,
      containerId,
      device_credential: `oc-dv.${deviceId}.${credentialSecret}`,
      device_cert: issued.certPem,
      device_key: issued.keyPem,
    };
  });
  sendJson(res, 200, result);
}

async function loadLiveDeviceByCredential(raw: string): Promise<{
  deviceId: string;
  userId: number;
  containerId: number;
  tlsClientFp: Buffer;
}> {
  const { deviceId, secret } = parseDeviceCredential(raw);
  const r = await query<{
    id: string;
    user_id: string;
    container_id: string;
    credential_hash: Buffer;
    tls_client_fp: Buffer;
    revoked_at: Date | null;
  }>(
    `SELECT id::text AS id, user_id::text AS user_id, container_id::text AS container_id,
            credential_hash, tls_client_fp, revoked_at
       FROM desktop_devices WHERE id = $1 LIMIT 1`,
    [deviceId],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at) throw new HttpError(401, "UNAUTHORIZED", "invalid device credential");
  if (!compareHash(hashSecret(secret), row.credential_hash)) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid device credential");
  }
  return {
    deviceId: row.id,
    userId: Number(row.user_id),
    containerId: Number(row.container_id),
    tlsClientFp: row.tls_client_fp,
  };
}

function requireTls(req: IncomingMessage, deps: CommercialHttpDeps, expectedFp: Buffer): DesktopIdentityTlsCtx {
  const tls = (deps as CommercialHttpDeps & { desktopPeerCert?: Parameters<typeof extractDesktopTlsContext>[1] })
    .desktopPeerCert
    ? extractDesktopTlsContext(req, { peerCert: (deps as { desktopPeerCert: NonNullable<Parameters<typeof extractDesktopTlsContext>[1]>["peerCert"] }).desktopPeerCert })
    : extractDesktopTlsContext(req);
  if (!tls) throw new HttpError(401, "UNAUTHORIZED", "device mTLS required");
  if (!compareHash(tls.deviceCertFp, expectedFp)) {
    throw new HttpError(401, "UNAUTHORIZED", "device mTLS required");
  }
  return tls;
}

export async function handleDesktopTokenMint(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  await requireNotKilled(flags);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenIp, ctx.clientIp);
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const cred = typeof body.device_credential === "string" ? body.device_credential : (req.headers.authorization ?? "");
  const device = await loadLiveDeviceByCredential(cred);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenUid, `u:${device.userId}`);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenDevice, `d:${device.deviceId}`);
  const tls = requireTls(req, deps, device.tlsClientFp);
  if (!tls.deviceSpiffe.endsWith(device.deviceId)) {
    await audit(query, {
      event: "token_device_mismatch",
      userId: device.userId,
      deviceId: device.deviceId,
      containerId: device.containerId,
      extra: { reason: "spiffe" },
    });
    throw new HttpError(401, "UNAUTHORIZED", "device mTLS required");
  }
  const token = await rotateContainerSecret(device.containerId, device.userId, device.deviceId, ctx, deps, "token_mint");
  sendJson(res, 200, token);
}

export async function handleDesktopTokenRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  await requireNotKilled(flags);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenIp, ctx.clientIp);
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const cred = typeof body.device_credential === "string" ? body.device_credential : "";
  const ocV3 = typeof body.token === "string" ? body.token : (req.headers.authorization ?? "");
  const device = await loadLiveDeviceByCredential(cred);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenUid, `u:${device.userId}`);
  await enforceRateLimit(deps, DESKTOP_RATE_LIMITS.tokenDevice, `d:${device.deviceId}`);
  requireTls(req, deps, device.tlsClientFp);
  const repo = createPgDesktopIdentityRepo();
  await verifyDesktopIdentity(repo, { tls: true, deviceCertFp: device.tlsClientFp, deviceSpiffe: `spiffe://openclaude/desktop-device/${device.deviceId}` }, ocV3);
  const presented = hashSecret(parseContainerToken(ocV3).secret);
  const token = await rotateContainerSecret(device.containerId, device.userId, device.deviceId, ctx, deps, "token_refresh", presented);
  sendJson(res, 200, token);
}

export type DesktopTokenRotateKind = "token_mint" | "token_refresh";

async function rotateContainerSecret(
  containerId: number,
  userId: number,
  deviceId: string,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  kind: DesktopTokenRotateKind = "token_mint",
  expectedSecretHash?: Buffer,
): Promise<{ token: string; expires_in: number; container_id: number; generation: number }> {
  const secret = randomSecretHex();
  const expires = new Date(Date.now() + DESKTOP_TOKEN_TTL_SEC * 1000);
  let fenceGeneration = 0;
  let newGeneration = 1;
  await tx(async (client) => {
    const locked = await client.query<{
      secret_hash: Buffer | null;
      session_secret_generation: number | null;
    }>(
      `SELECT secret_hash, COALESCE(session_secret_generation, 0)::int AS session_secret_generation
         FROM agent_containers
        WHERE id = $1 AND runtime_kind = 'desktop' AND state = 'active'
        FOR UPDATE`,
      [containerId],
    );
    const row = locked.rows[0];
    if (!row) throw new HttpError(401, "UNAUTHORIZED", "invalid device credential");
    if (expectedSecretHash && (!row.secret_hash || !compareHash(expectedSecretHash, row.secret_hash))) {
      throw new HttpError(409, "TOKEN_ROTATED", "token already rotated");
    }
    const oldGen = Number(row.session_secret_generation ?? 0);
    const upd = await client.query<{ session_secret_generation: number }>(
      `UPDATE agent_containers
          SET secret_hash = $2,
              session_secret_expires_at = $3,
              session_secret_generation = $4,
              updated_at = NOW()
        WHERE id = $1
          AND runtime_kind = 'desktop'
          AND state = 'active'
          AND COALESCE(session_secret_generation, 0) = $5
          AND ($6::bytea IS NULL OR secret_hash = $6)
        RETURNING session_secret_generation`,
      [containerId, hashSecret(secret), expires, oldGen + 1, oldGen, expectedSecretHash ?? null],
    );
    if ((upd.rowCount ?? 0) === 0) {
      throw new HttpError(409, "TOKEN_ROTATED", "token already rotated");
    }
    fenceGeneration = oldGen;
    newGeneration = Number(upd.rows[0]?.session_secret_generation ?? oldGen + 1);
    await client.query(`UPDATE desktop_devices SET last_token_at = NOW(), updated_at = NOW() WHERE id = $1`, [deviceId]);
    await audit(client, {
      event: kind,
      userId,
      deviceId,
      containerId,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });
  const registry: DesktopTunnelRegistry = (deps as CommercialHttpDeps & { desktopTunnelRegistry?: DesktopTunnelRegistry }).desktopTunnelRegistry
    ?? getDesktopTunnelRegistry();
  registry.drop(containerId, "token_rotated", fenceGeneration);
  return {
    token: `oc-v3.${containerId}.${secret}`,
    expires_in: DESKTOP_TOKEN_TTL_SEC,
    container_id: containerId,
    generation: newGeneration,
  };
}

export async function handleDesktopRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const flags = await getDesktopFlagSnapshot();
  await requireAssembled(flags);
  const user = await loadUser(deps, req);
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const deviceId = typeof body.device_id === "string" ? body.device_id : null;
  const row = await query<{
    id: string;
    user_id: string;
    container_id: string;
  }>(
    `SELECT id::text AS id, user_id::text AS user_id, container_id::text AS container_id
       FROM desktop_devices
      WHERE user_id = $1 AND revoked_at IS NULL
        AND ($2::uuid IS NULL OR id = $2::uuid)
      LIMIT 1`,
    [user.uid, deviceId],
  );
  if (!row.rows[0]) throw new HttpError(404, "NOT_FOUND", "no live device");
  const d = row.rows[0];
  if (user.role !== "admin" && Number(d.user_id) !== user.uid) {
    throw new HttpError(403, "FORBIDDEN", "not entitled");
  }
  await tx(async (client) => {
    await client.query(
      `UPDATE desktop_devices SET revoked_at = NOW(), revoke_reason = 'user_revoke', updated_at = NOW() WHERE id = $1`,
      [d.id],
    );
    await client.query(
      `UPDATE agent_containers SET state = 'vanished', updated_at = NOW()
        WHERE id = $1 AND runtime_kind = 'desktop'`,
      [d.container_id],
    );
    await audit(client, {
      event: "device_revoke",
      userId: Number(d.user_id),
      deviceId: d.id,
      containerId: Number(d.container_id),
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });
  const registry: DesktopTunnelRegistry = (deps as CommercialHttpDeps & { desktopTunnelRegistry?: DesktopTunnelRegistry }).desktopTunnelRegistry
    ?? getDesktopTunnelRegistry();
  registry.drop(Number(d.container_id), "revoked");
  sendJson(res, 200, { revoked: true, device_id: d.id });
}

export async function sweepExpiredEnrollments(pool: Pool = getPool()): Promise<number> {
  const flags = await getDesktopFlagSnapshot();
  if (!flags.envEnabled) return 0;
  const expired = await pool.query<{ id: string; user_id: string | null }>(
    `SELECT id::text AS id, user_id::text AS user_id
       FROM desktop_enrollments
      WHERE consumed_at IS NULL AND expires_at < NOW()
      LIMIT 500`,
  );
  for (const row of expired.rows) {
    if (row.user_id) {
      try {
        await audit(query, { event: "enroll_expire", userId: Number(row.user_id), enrollmentId: row.id });
      } catch { /* best-effort */ }
    }
    await pool.query(`DELETE FROM desktop_enrollments WHERE id = $1 AND consumed_at IS NULL`, [row.id]);
  }
  return expired.rows.length;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startDesktopEnrollmentSweep(opts?: { intervalMs?: number }): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 60_000;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    void sweepExpiredEnrollments().catch(() => {});
  }, intervalMs);
  sweepTimer.unref?.();
  return {
    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
  };
}


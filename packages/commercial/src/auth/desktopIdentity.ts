/**
 * Desktop identity: mTLS device cert + oc-v3 secret on runtime_kind='desktop'.
 * Does not modify verifyContainerIdentity.
 */

import type { IncomingMessage } from "node:http";
import {
  ContainerIdentityError,
  compareHash,
  hashSecret,
  parseContainerToken,
  type ContainerIdentity,
} from "./containerIdentity.js";
import {
  IdentityError,
  authorizeProxyIdentity,
  type IdentityStrategy,
  type SharedAuthorizeDeps,
} from "./proxyIdentity.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { DESKTOP_IDENTITY_PUBLIC_MESSAGE, getDesktopFlagSnapshot } from "../desktop/flags.js";
import { extractDeviceIdFromSpiffe } from "../desktop/deviceCa.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";

export { extractDeviceIdFromSpiffe } from "../desktop/deviceCa.js";

export type DesktopIdentityLogCode =
  | "BAD_TOKEN_FORMAT"
  | "UNKNOWN_CONTAINER"
  | "BAD_SECRET"
  | "EXPIRED"
  | "DEVICE_REVOKED"
  | "TLS_REQUIRED"
  | "FP_MISMATCH"
  | "SPIFFE_MISMATCH"
  | "KILLSWITCH"
  | "UPDATE_REQUIRED";

export class DesktopIdentityError extends ContainerIdentityError {
  readonly logCode: DesktopIdentityLogCode;
  readonly detail: string;
  constructor(logCode: DesktopIdentityLogCode, detail: string) {
    super(
      logCode === "BAD_TOKEN_FORMAT" ? "BAD_TOKEN_FORMAT" : "BAD_SECRET",
      DESKTOP_IDENTITY_PUBLIC_MESSAGE,
    );
    this.name = "DesktopIdentityError";
    this.logCode = logCode;
    this.detail = detail;
  }
}

export interface DesktopIdentityTlsCtx {
  tls: true;
  deviceCertFp: Buffer;
  deviceSpiffe: string;
}

export interface DesktopDeviceRow {
  id: string;
  user_id: number;
  container_id: number;
  tls_client_fp: Buffer;
  revoked_at: Date | null;
}

export interface DesktopContainerRow {
  id: number;
  user_id: number;
  secret_hash: Buffer | null;
  session_secret_expires_at: Date | null;
  issued_by_host_uuid: string | null;
  update_required: boolean;
  runtime_kind: string;
  state: string;
}

export interface DesktopIdentityRepo {
  findActiveDesktopById(id: number, channel: string): Promise<DesktopContainerRow | null>;
  findLiveDeviceByContainerId(containerId: number): Promise<DesktopDeviceRow | null>;
  recordDeviceAudit?(event: string, args: {
    deviceId?: string | null;
    userId: number;
    containerId?: number | null;
    extra?: Record<string, unknown>;
  }): Promise<void>;
}

export async function verifyDesktopIdentity(
  repo: DesktopIdentityRepo,
  ctx: DesktopIdentityTlsCtx,
  authorizationHeader: string | undefined,
): Promise<ContainerIdentity> {
  if (!ctx?.tls || !Buffer.isBuffer(ctx.deviceCertFp) || ctx.deviceCertFp.length !== 32) {
    throw new DesktopIdentityError("TLS_REQUIRED", "missing device cert fingerprint");
  }
  const flags = await getDesktopFlagSnapshot();
  if (flags.killSwitch) {
    throw new DesktopIdentityError("KILLSWITCH", "desktop kind kill switch");
  }
  const { containerId: claimedCid, secret } = parseContainerToken(authorizationHeader);
  const row = await repo.findActiveDesktopById(claimedCid, getRuntimeChannel());
  if (!row || row.runtime_kind !== "desktop" || row.state !== "active") {
    throw new DesktopIdentityError("UNKNOWN_CONTAINER", `no active desktop container ${claimedCid}`);
  }
  if (row.update_required) {
    throw new DesktopIdentityError("UPDATE_REQUIRED", `container ${row.id} update_required`);
  }
  if (!row.secret_hash) {
    throw new DesktopIdentityError("BAD_SECRET", `container ${row.id} has no secret_hash`);
  }
  if (row.session_secret_expires_at && row.session_secret_expires_at.getTime() <= Date.now()) {
    try {
      getDesktopTunnelRegistry().drop(row.id);
    } catch { /* registry optional */ }
    throw new DesktopIdentityError("EXPIRED", `container ${row.id} token expired`);
  }
  const candidate = hashSecret(secret);
  if (!compareHash(candidate, row.secret_hash)) {
    throw new DesktopIdentityError("BAD_SECRET", `secret mismatch for container ${row.id}`);
  }
  const device = await repo.findLiveDeviceByContainerId(row.id);
  if (!device || device.revoked_at) {
    throw new DesktopIdentityError("DEVICE_REVOKED", `no live device for container ${row.id}`);
  }
  if (device.user_id !== row.user_id || device.container_id !== row.id) {
    throw new DesktopIdentityError("DEVICE_REVOKED", "device/container user mismatch");
  }
  const spiffeId = extractDeviceIdFromSpiffe(ctx.deviceSpiffe);
  if (!spiffeId || spiffeId !== device.id.toLowerCase()) {
    await repo.recordDeviceAudit?.("token_device_mismatch", {
      deviceId: device.id,
      userId: row.user_id,
      containerId: row.id,
      extra: { reason: "spiffe" },
    });
    throw new DesktopIdentityError("SPIFFE_MISMATCH", "device SPIFFE uuid mismatch");
  }
  if (!compareHash(ctx.deviceCertFp, device.tls_client_fp)) {
    await repo.recordDeviceAudit?.("token_device_mismatch", {
      deviceId: device.id,
      userId: row.user_id,
      containerId: row.id,
      extra: { reason: "fp" },
    });
    throw new DesktopIdentityError("FP_MISMATCH", "tls_client_fp mismatch");
  }
  return {
    containerId: row.id,
    userId: row.user_id,
    boundIp: "",
    hostUuid: row.issued_by_host_uuid ?? "",
  };
}

export function makeDesktopIdentityStrategy(
  deps: SharedAuthorizeDeps & { repo: DesktopIdentityRepo; tlsFromReq: (req: IncomingMessage) => DesktopIdentityTlsCtx | null },
): IdentityStrategy {
  return {
    async resolve(req) {
      const tls = deps.tlsFromReq(req);
      if (!tls) {
        throw new DesktopIdentityError("TLS_REQUIRED", "no device mTLS context");
      }
      try {
        const identity = await verifyDesktopIdentity(deps.repo, tls, req.headers.authorization);
        return {
          uid: BigInt(identity.userId),
          containerId: BigInt(identity.containerId),
        };
      } catch (err) {
        if (err instanceof DesktopIdentityError) {
          throw new IdentityError(err.logCode, err.message);
        }
        if (err instanceof ContainerIdentityError) {
          throw new IdentityError(err.code, err.message);
        }
        throw err;
      }
    },
    async authorize(identity, _pricing, model, requiredEpoch) {
      await authorizeProxyIdentity(
        { pricing: deps.pricing, loadUserModelAuthz: deps.loadUserModelAuthz },
        identity,
        model,
        requiredEpoch,
      );
    },
  };
}

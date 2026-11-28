/**
 * V3/V5 container naming, bridge gateway IP resolution, resource limits,
 * and PostgreSQL advisory lock primitives.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero dynamic SQL.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { containerSubnetPrefixForChannel } from "../../containerNet.js";
import { getRuntimeChannel, type RuntimeChannel } from "../../runtimeChannel.js";
import { SupervisorError } from "../types.js";
import {
  DEFAULT_V3_CPUS,
  DEFAULT_V3_MEMORY_MB,
  DEFAULT_V3_PIDS_LIMIT,
  HOST_CAP_LOCK_NS,
  HOST_UUID_CANONICAL_RE,
  USER_LIFECYCLE_LOCK_NS,
  V3_ADMIN_PIDS_LIMIT,
  V3_IP_OCTET_MAX,
  V3_IP_OCTET_MIN,
  type V3VolumeRole,
} from "./types.js";

function ocSubnetPrefixForChannel(): string {
  return containerSubnetPrefixForChannel();
}

export function ocGatewayIpForChannel(): string {
  return `${containerSubnetPrefixForChannel()}.0.1`;
}

export function ocInternalProxyPortForChannel(): number {
  return getRuntimeChannel() === "v5" ? 18892 : 18791;
}

export function gatewayIpFromV3Cidr(cidr: string): string {
  const trimmed = cidr.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(trimmed);
  if (!m) {
    throw new SupervisorError(
      "InvalidArgument",
      `bridge_cidr ${cidr} not in expected v3 form X.Y.Z.0/24`,
    );
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255) {
    throw new SupervisorError(
      "InvalidArgument",
      `bridge_cidr ${cidr} octet out of range`,
    );
  }
  return `${a}.${b}.${c}.1`;
}

export function resolveHostGatewayIp(
  bridgeCidr: string | null | undefined,
  useRemote: boolean,
  hostId: string | undefined,
): string {
  if (typeof bridgeCidr === "string" && bridgeCidr.length > 0) {
    return gatewayIpFromV3Cidr(bridgeCidr);
  }
  if (!useRemote) {
    return ocGatewayIpForChannel();
  }
  throw new SupervisorError(
    "InvalidArgument",
    `remote host ${hostId} requires bridgeCidr; got ${bridgeCidr === null ? "null" : "undefined"}`,
  );
}

export interface RawResourceLimitEnv {
  memoryMb?: string;
  cpus?: string;
  pidsLimit?: string;
}

export function resolveV3ResourceLimitsFromEnv(
  rawEnv: RawResourceLimitEnv,
  opts?: { unlimited?: boolean },
): {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
} {
  if (opts?.unlimited) {
    return { memoryBytes: 0, nanoCpus: 0, pidsLimit: V3_ADMIN_PIDS_LIMIT };
  }
  const MIB = 1024 * 1024;
  const NANO_CPU = 1_000_000_000;

  const memEnv = Number(rawEnv.memoryMb);
  const memMbFloored = Number.isFinite(memEnv) ? Math.floor(memEnv) : Number.NaN;
  const memMb = memMbFloored >= 1 ? memMbFloored : DEFAULT_V3_MEMORY_MB;

  const cpuEnv = Number(rawEnv.cpus);
  const nanoCpusRaw = Number.isFinite(cpuEnv) ? Math.floor(cpuEnv * NANO_CPU) : Number.NaN;
  const nanoCpus = nanoCpusRaw >= 1 ? nanoCpusRaw : Math.floor(DEFAULT_V3_CPUS * NANO_CPU);

  const pidsEnv = Number(rawEnv.pidsLimit);
  const pidsFloored = Number.isFinite(pidsEnv) ? Math.floor(pidsEnv) : Number.NaN;
  const pidsLimit = pidsFloored >= 1 ? pidsFloored : DEFAULT_V3_PIDS_LIMIT;

  return { memoryBytes: memMb * MIB, nanoCpus, pidsLimit };
}

function uidToLockKey(uid: number): number {
  return uid | 0;
}

function hostIdToLockKey(hostUuid: string): number {
  let h = 0x811c_9dc5 | 0;
  for (let i = 0; i < hostUuid.length; i++) {
    h = (h ^ hostUuid.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x0100_0193) | 0;
  }
  return h;
}

export async function acquireUserLifecycleLock(
  client: PoolClient,
  uid: number,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, $2::int4)",
    [USER_LIFECYCLE_LOCK_NS, uidToLockKey(uid)],
  );
}

export async function tryAcquireUserLifecycleLock(
  client: PoolClient,
  uid: number,
): Promise<boolean> {
  const r = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS locked",
    [USER_LIFECYCLE_LOCK_NS, uidToLockKey(uid)],
  );
  return r.rows[0]?.locked === true;
}

export async function acquireHostCapLock(
  client: PoolClient,
  hostUuid: string,
): Promise<void> {
  if (!HOST_UUID_CANONICAL_RE.test(hostUuid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `host uuid must be PG canonical lowercase 36-char form, got: ${JSON.stringify(hostUuid)}`,
    );
  }
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, $2::int4)",
    [HOST_CAP_LOCK_NS, hostIdToLockKey(hostUuid)],
  );
}

export function v3ContainerNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-u${uid}`;
}

export function v3VolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-data-u${uid}`;
}

export function v3ProjectsVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-proj-u${uid}`;
}

export function v3CodexVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-codex-u${uid}`;
}

export function v3UserLocalVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-userlocal-u${uid}`;
}

export function v3UserConfigVolumeNameFor(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${getRuntimeChannel()}-userconfig-u${uid}`;
}

export function volumeNameForChannel(
  channel: RuntimeChannel,
  role: V3VolumeRole,
  uid: number,
): string {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  return `oc-${channel}-${role}-u${uid}`;
}

export function defaultPickRandomIp(): string {
  const third = Math.floor(Math.random() * 256);
  const fourth =
    V3_IP_OCTET_MIN + Math.floor(Math.random() * (V3_IP_OCTET_MAX - V3_IP_OCTET_MIN + 1));
  return `${ocSubnetPrefixForChannel()}.${third}.${fourth}`;
}

export function defaultRandomSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashSecretToBuffer(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

export async function lookupContainerUserRole(
  pool: Pool,
  uid: number,
): Promise<"user" | "admin"> {
  try {
    const r = await pool.query<{ role: string | null }>(
      "SELECT role FROM users WHERE id = $1::bigint LIMIT 1",
      [uid],
    );
    return r.rows[0]?.role === "admin" ? "admin" : "user";
  } catch {
    return "user";
  }
}

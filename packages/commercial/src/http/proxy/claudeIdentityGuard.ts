/**
 * OAuth Claude 出站前一致性门。架构不变（账号池 / 18991 / 官方 CC），
 * 只在 fetch Anthropic 之前核对设备、时区、出口 IP；不满足则 fail-closed。
 *
 * 降噪 ≠ 防封。关：OC_CLAUDE_EGRESS_IDENTITY_GUARD=0。
 */

import {
  countryForTimezone,
  liveClaudeCliUserAgent,
} from "../../account-pool/persona.js";

export type ClaudeIdentityFailureCode =
  | "device_mismatch"
  | "tz_mismatch"
  | "ip_drift"
  | "probe_failed";

export class ClaudeIdentityGuardError extends Error {
  readonly code: ClaudeIdentityFailureCode;
  readonly publicMessage: string;
  constructor(code: ClaudeIdentityFailureCode, detail: string) {
    super(`egress identity check failed: ${code}`);
    this.name = "ClaudeIdentityGuardError";
    this.code = code;
    this.publicMessage = `egress identity check failed: ${code}`;
    this.cause = detail;
  }
}

export type IpObservation = {
  ip: string;
  country: string | null;
  timezone: string | null;
};

export type ClaudeIdentityGuardInput = {
  accountId: bigint;
  pinnedUserId: string | null;
  personaTimezone: string | null | undefined;
  userAgent: string | undefined;
  xApp: string | undefined;
  metadataUserId: unknown;
  dispatcher?: unknown;
};

type GuardRuntime = {
  nowMs: () => number;
  probeExit: (dispatcher: unknown) => Promise<IpObservation>;
  pinnedIp: string | null;
  pinnedCountry: string | null;
  processTz: string | null;
  enabled: boolean;
};

const PROBE_TTL_MS = 60_000;
const PINNED_USER_ID_RE = /^[0-9a-f]{64}$/;

let lastIpByAccount = new Map<string, { ip: string; atMs: number }>();
let probeCache: { atMs: number; obs: IpObservation } | null = null;
let testRuntime: Partial<GuardRuntime> | null = null;

function envOn(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function runtime(): GuardRuntime {
  const enabled = process.env.OC_CLAUDE_EGRESS_IDENTITY_GUARD !== "0";
  return {
    nowMs: testRuntime?.nowMs ?? Date.now,
    probeExit: testRuntime?.probeExit ?? defaultProbeExit,
    pinnedIp: testRuntime?.pinnedIp ?? envOn("OC_CLAUDE_EGRESS_PINNED_IP"),
    pinnedCountry: testRuntime?.pinnedCountry ?? envOn("OC_CLAUDE_EGRESS_PINNED_COUNTRY"),
    processTz:
      testRuntime?.processTz ??
      envOn("OC_CLAUDE_CODE_TZ") ??
      envOn("OPENCLAUDE_CCB_TZ"),
    enabled: testRuntime?.enabled ?? enabled,
  };
}

export function setClaudeIdentityGuardRuntimeForTest(
  rt: Partial<GuardRuntime> | null,
): void {
  testRuntime = rt;
  if (rt === null) {
    lastIpByAccount = new Map();
    probeCache = null;
  }
}

export function resetClaudeIdentityGuardForTest(): void {
  lastIpByAccount = new Map();
  probeCache = null;
  testRuntime = null;
}

function extractDeviceId(metadataUserId: unknown): string | null {
  if (typeof metadataUserId !== "string" || !metadataUserId) return null;
  try {
    const parsed: unknown = JSON.parse(metadataUserId);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { device_id?: unknown }).device_id === "string"
    ) {
      return (parsed as { device_id: string }).device_id;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function defaultProbeExit(dispatcher: unknown): Promise<IpObservation> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4_000);
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      signal: ac.signal,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const res = await fetch("https://ipinfo.io/json", init);
    if (!res.ok) throw new Error(`ipinfo http ${res.status}`);
    const body = (await res.json()) as {
      ip?: unknown;
      country?: unknown;
      timezone?: unknown;
    };
    if (typeof body.ip !== "string" || body.ip.length === 0) {
      throw new Error("ipinfo missing ip");
    }
    return {
      ip: body.ip,
      country: typeof body.country === "string" ? body.country : null,
      timezone: typeof body.timezone === "string" ? body.timezone : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertDevice(input: ClaudeIdentityGuardInput): void {
  const expectedUa = liveClaudeCliUserAgent();
  if ((input.userAgent ?? "") !== expectedUa) {
    throw new ClaudeIdentityGuardError(
      "device_mismatch",
      `user-agent ${input.userAgent ?? "<missing>"} != ${expectedUa}`,
    );
  }
  if ((input.xApp ?? "") !== "cli") {
    throw new ClaudeIdentityGuardError(
      "device_mismatch",
      `x-app ${input.xApp ?? "<missing>"} != cli`,
    );
  }
  const pinned = input.pinnedUserId;
  if (typeof pinned !== "string" || !PINNED_USER_ID_RE.test(pinned)) {
    throw new ClaudeIdentityGuardError(
      "device_mismatch",
      "pinned_user_id missing or not 64-hex",
    );
  }
  const deviceId = extractDeviceId(input.metadataUserId);
  if (deviceId !== pinned) {
    throw new ClaudeIdentityGuardError(
      "device_mismatch",
      "metadata.user_id.device_id is not the account pin",
    );
  }
}

async function observeExit(
  rt: GuardRuntime,
  dispatcher: unknown,
): Promise<IpObservation> {
  const now = rt.nowMs();
  if (probeCache && now - probeCache.atMs < PROBE_TTL_MS) {
    return probeCache.obs;
  }
  try {
    const obs = await rt.probeExit(dispatcher);
    probeCache = { atMs: now, obs };
    return obs;
  } catch (err) {
    if (probeCache && now - probeCache.atMs < PROBE_TTL_MS) {
      return probeCache.obs;
    }
    throw new ClaudeIdentityGuardError(
      "probe_failed",
      err instanceof Error ? err.message : "exit probe failed",
    );
  }
}

function assertTzAndIp(
  input: ClaudeIdentityGuardInput,
  obs: IpObservation,
  rt: GuardRuntime,
): void {
  const tz = input.personaTimezone;
  if (!tz) {
    throw new ClaudeIdentityGuardError("tz_mismatch", "persona.timezone missing");
  }
  if (rt.processTz && rt.processTz !== tz) {
    throw new ClaudeIdentityGuardError(
      "tz_mismatch",
      `process TZ ${rt.processTz} != persona ${tz}`,
    );
  }
  if (obs.timezone && obs.timezone !== tz) {
    throw new ClaudeIdentityGuardError(
      "tz_mismatch",
      `exit TZ ${obs.timezone} != persona ${tz}`,
    );
  }
  const personaCountry = countryForTimezone(tz);
  const expectedCountry = rt.pinnedCountry ?? personaCountry;
  if (obs.country && expectedCountry && obs.country !== expectedCountry) {
    throw new ClaudeIdentityGuardError(
      "tz_mismatch",
      `exit country ${obs.country} != ${expectedCountry}`,
    );
  }
  if (rt.pinnedIp && obs.ip !== rt.pinnedIp) {
    throw new ClaudeIdentityGuardError(
      "ip_drift",
      `exit ip drifted from pinned ${rt.pinnedIp}`,
    );
  }
  const key = input.accountId.toString();
  const prev = lastIpByAccount.get(key);
  if (prev && prev.ip !== obs.ip) {
    throw new ClaudeIdentityGuardError(
      "ip_drift",
      `exit ip drifted from last seen ${prev.ip}`,
    );
  }
  lastIpByAccount.set(key, { ip: obs.ip, atMs: rt.nowMs() });
}

/** OAuth 路径在 applyUpstreamAuth 之后、fetch 之前调用。 */
export async function assertClaudeOAuthIdentity(
  input: ClaudeIdentityGuardInput,
): Promise<void> {
  const rt = runtime();
  if (!rt.enabled) return;
  assertDevice(input);
  const obs = await observeExit(rt, input.dispatcher);
  assertTzAndIp(input, obs, rt);
}

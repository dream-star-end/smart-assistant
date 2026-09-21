import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assertClaudeOAuthIdentity,
  ClaudeIdentityGuardError,
  resetClaudeIdentityGuardForTest,
  setClaudeIdentityGuardRuntimeForTest,
  type IpObservation,
} from "../http/proxy/claudeIdentityGuard.js";
import { liveClaudeCliUserAgent } from "../account-pool/persona.js";

const PIN = "a".repeat(64);
const JP: IpObservation = {
  ip: "125.103.212.118",
  country: "JP",
  timezone: "Asia/Tokyo",
};

function baseInput(over: Partial<Parameters<typeof assertClaudeOAuthIdentity>[0]> = {}) {
  return {
    accountId: 22n,
    pinnedUserId: PIN,
    personaTimezone: "Asia/Tokyo",
    userAgent: liveClaudeCliUserAgent(),
    xApp: "cli",
    metadataUserId: JSON.stringify({ device_id: PIN }),
    dispatcher: undefined,
    ...over,
  };
}

afterEach(() => resetClaudeIdentityGuardForTest());

describe("assertClaudeOAuthIdentity", () => {
  test("JP 出口 + 活体 UA + pin 一致 → 放行", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      pinnedIp: JP.ip,
      pinnedCountry: "JP",
      probeExit: async () => JP,
    });
    await assertClaudeOAuthIdentity(baseInput());
  });

  test("UA 与活体 CLI 不一致 → device_mismatch", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      probeExit: async () => JP,
    });
    await assert.rejects(
      () =>
        assertClaudeOAuthIdentity(baseInput({ userAgent: "undici/1.0.0" })),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "device_mismatch",
    );
  });

  test("device_id 未钉到账号 pin → device_mismatch", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      probeExit: async () => JP,
    });
    await assert.rejects(
      () =>
        assertClaudeOAuthIdentity(
          baseInput({
            metadataUserId: JSON.stringify({ device_id: "b".repeat(64) }),
          }),
        ),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "device_mismatch",
    );
  });

  test("persona 时区与出口时区不一致 → tz_mismatch", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      probeExit: async () => JP,
    });
    await assert.rejects(
      () =>
        assertClaudeOAuthIdentity(baseInput({ personaTimezone: "America/New_York" })),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "tz_mismatch",
    );
  });

  test("出口 IP 相对 env 钉漂移 → ip_drift", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      pinnedIp: JP.ip,
      probeExit: async () => ({ ...JP, ip: "1.2.3.4" }),
    });
    await assert.rejects(
      () => assertClaudeOAuthIdentity(baseInput()),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "ip_drift",
    );
  });

  test("同账号两次观测 IP 变化 → ip_drift", async () => {
    let n = 0;
    let now = 0;
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      nowMs: () => now,
      probeExit: async () => {
        n += 1;
        return n === 1 ? JP : { ...JP, ip: "9.9.9.9" };
      },
    });
    await assertClaudeOAuthIdentity(baseInput());
    now = 61_000;
    await assert.rejects(
      () => assertClaudeOAuthIdentity(baseInput()),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "ip_drift",
    );
  });

  test("probe 失败且无缓存 → probe_failed，不放行", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: true,
      processTz: "Asia/Tokyo",
      probeExit: async () => {
        throw new Error("network down");
      },
    });
    await assert.rejects(
      () => assertClaudeOAuthIdentity(baseInput()),
      (err: unknown) =>
        err instanceof ClaudeIdentityGuardError && err.code === "probe_failed",
    );
  });

  test("OC_CLAUDE_EGRESS_IDENTITY_GUARD=0 → 跳过", async () => {
    setClaudeIdentityGuardRuntimeForTest({
      enabled: false,
      probeExit: async () => {
        throw new Error("must not probe");
      },
    });
    await assertClaudeOAuthIdentity(
      baseInput({ userAgent: "wrong", personaTimezone: "America/New_York" }),
    );
  });
});

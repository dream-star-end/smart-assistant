import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { hashSecret } from "../auth/containerIdentity.js";
import {
  DesktopIdentityError,
  verifyDesktopIdentity,
  type DesktopIdentityRepo,
} from "../auth/desktopIdentity.js";
import { DESKTOP_IDENTITY_PUBLIC_MESSAGE, resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import { resetDesktopTunnelRegistryForTest } from "../ws/desktopTunnelRegistry.js";

const secret = "ab".repeat(32);
const fp = createHash("sha256").update("device-cert").digest();
const deviceId = "11111111-1111-4111-8111-111111111111";

function repo(overrides: Partial<{
  row: NonNullable<Awaited<ReturnType<DesktopIdentityRepo["findActiveDesktopById"]>>>;
  device: NonNullable<Awaited<ReturnType<DesktopIdentityRepo["findLiveDeviceByContainerId"]>>>;
  audits: Array<string>;
}> = {}): DesktopIdentityRepo {
  const row = overrides.row ?? {
    id: 42,
    user_id: 7,
    secret_hash: hashSecret(secret),
    session_secret_expires_at: new Date(Date.now() + 60_000),
    issued_by_host_uuid: null,
    update_required: false,
    runtime_kind: "desktop",
    state: "active",
  };
  const device = overrides.device ?? {
    id: deviceId,
    user_id: 7,
    container_id: 42,
    tls_client_fp: fp,
    revoked_at: null,
  };
  const audits = overrides.audits ?? [];
  return {
    async findActiveDesktopById(id) {
      return id === row.id ? row : null;
    },
    async findLiveDeviceByContainerId() {
      return device;
    },
    async recordDeviceAudit(event) {
      audits.push(event);
    },
  };
}

function tls(fpBuf = fp) {
  return { tls: true as const, deviceCertFp: fpBuf, deviceSpiffe: `spiffe://openclaude/desktop-device/${deviceId}` };
}

describe("verifyDesktopIdentity", () => {
  test("happy path", async () => {
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [7] }));
    const ident = await verifyDesktopIdentity(repo(), tls(), `Bearer oc-v3.42.${secret}`);
    assert.equal(ident.containerId, 42);
    assert.equal(ident.userId, 7);
    assert.equal(ident.boundIp, "");
    setDesktopSettingsLoader(null);
  });

  test("wrong secret and expiry share public message", async () => {
    const bad = await assert.rejects(
      () => verifyDesktopIdentity(repo(), tls(), `Bearer oc-v3.42.${"cd".repeat(32)}`),
      DesktopIdentityError,
    );
    try {
      await verifyDesktopIdentity(repo(), tls(), `Bearer oc-v3.42.${"cd".repeat(32)}`);
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.message, DESKTOP_IDENTITY_PUBLIC_MESSAGE);
      assert.equal(e.logCode, "BAD_SECRET");
    }
    const expiredRepo = repo({
      row: {
        id: 42, user_id: 7, secret_hash: hashSecret(secret),
        session_secret_expires_at: new Date(Date.now() - 1000),
        issued_by_host_uuid: null, update_required: false, runtime_kind: "desktop", state: "active",
      },
    });
    resetDesktopTunnelRegistryForTest();
    try {
      await verifyDesktopIdentity(expiredRepo, tls(), `Bearer oc-v3.42.${secret}`);
      assert.fail("expected expire");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.message, DESKTOP_IDENTITY_PUBLIC_MESSAGE);
      assert.equal(e.logCode, "EXPIRED");
    }
    void bad;
  });

  test("docker token against missing desktop row does not match", async () => {
    const empty: DesktopIdentityRepo = {
      async findActiveDesktopById() { return null; },
      async findLiveDeviceByContainerId() { return null; },
    };
    try {
      await verifyDesktopIdentity(empty, tls(), `Bearer oc-v3.42.${secret}`);
      assert.fail("expected miss");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.logCode, "UNKNOWN_CONTAINER");
    }
  });

  test("fp mismatch 401 + token_device_mismatch audit", async () => {
    const audits: string[] = [];
    const other = randomBytes(32);
    try {
      await verifyDesktopIdentity(repo({ audits }), tls(other), `Bearer oc-v3.42.${secret}`);
      assert.fail("expected fp mismatch");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.logCode, "FP_MISMATCH");
      assert.equal(e.message, DESKTOP_IDENTITY_PUBLIC_MESSAGE);
    }
    assert.deepEqual(audits, ["token_device_mismatch"]);
  });

  test("kill switch", async () => {
    const prev = process.env.OC_DESKTOP_KIND_KILLSWITCH;
    process.env.OC_DESKTOP_KIND_KILLSWITCH = "1";
    resetDesktopFlagCache();
    try {
      await verifyDesktopIdentity(repo(), tls(), `Bearer oc-v3.42.${secret}`);
      assert.fail("expected kill");
    } catch (e) {
      assert.ok(e instanceof DesktopIdentityError);
      assert.equal(e.logCode, "KILLSWITCH");
    }
    if (prev === undefined) delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
    else process.env.OC_DESKTOP_KIND_KILLSWITCH = prev;
    resetDesktopFlagCache();
  });
});

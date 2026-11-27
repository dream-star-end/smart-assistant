import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS,
  LOCAL_SWARM_CONCURRENCY_ENV,
  localSwarmConcurrencyContainerEnv,
} from "../agent-sandbox/localSwarmConcurrencyEnv.js";
import {
  FlavorIdentityError,
  type FlavorIdentity,
  type FlavorManifest,
} from "../flavor/assertFlavor.js";
import {
  COMMERCIAL_DEFAULT_ANTIGRAVITY_AUX_MAX_INFLIGHT_PER_ROUTE,
  COMMERCIAL_DEFAULT_ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE,
  antigravityRelayConcurrencyFromConfig,
} from "../http/antigravityRouteRuntime.js";

function okFlavor(flavor: "commercial" | "selfhost"): FlavorIdentity {
  const manifest: FlavorManifest = {
    schema: 1,
    flavor,
    sourceCommit: "0".repeat(40),
    builder: flavor === "commercial" ? "deploy-v5.sh" : "deploy-v5-selfhost.sh",
    expectedHosts: ["fixture"],
    expectedRoots: ["/srv/fixture"],
    expectedDbNames: ["openclaude_fixture"],
    guardGeneration: 1,
  };
  return { status: "ok", flavor, manifest, manifestPath: "/srv/fixture/flavor.manifest.json" };
}

describe("OCV5-913 commercial swarm concurrency / OOM guard", () => {
  test("localSwarmConcurrencyContainerEnv defaults commercial containers to 2 and fails closed on FlavorIdentityError", () => {
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({ env: {}, identity: () => okFlavor("commercial") }),
      [`${LOCAL_SWARM_CONCURRENCY_ENV}=${COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS}`],
    );
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({
        env: {},
        identity: () => {
          throw new FlavorIdentityError("invalid manifest");
        },
      }),
      [`${LOCAL_SWARM_CONCURRENCY_ENV}=${COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS}`],
    );
  });

  test("localSwarmConcurrencyContainerEnv leaves selfhost and manifestless test envs uncapped", () => {
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({ env: {}, identity: () => okFlavor("selfhost") }),
      [],
    );
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({
        env: {},
        identity: () => ({ status: "skipped", reason: "no-manifest" }),
      }),
      [],
    );
  });

  test("localSwarmConcurrencyContainerEnv honors explicit operator override and ignores invalid strings", () => {
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({
        env: { [LOCAL_SWARM_CONCURRENCY_ENV]: "4" },
        identity: () => okFlavor("commercial"),
      }),
      [`${LOCAL_SWARM_CONCURRENCY_ENV}=4`],
    );
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({
        env: { [LOCAL_SWARM_CONCURRENCY_ENV]: "0" },
        identity: () => okFlavor("commercial"),
      }),
      [`${LOCAL_SWARM_CONCURRENCY_ENV}=0`],
    );
    assert.deepEqual(
      localSwarmConcurrencyContainerEnv({
        env: { [LOCAL_SWARM_CONCURRENCY_ENV]: "not-a-cap" },
        identity: () => okFlavor("commercial"),
      }),
      [`${LOCAL_SWARM_CONCURRENCY_ENV}=${COMMERCIAL_DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS}`],
    );
  });

  test("antigravityRelayConcurrencyFromConfig caps commercial defaults at 12/24 unless explicitly overridden", () => {
    assert.deepEqual(antigravityRelayConcurrencyFromConfig({}), {});
    assert.deepEqual(antigravityRelayConcurrencyFromConfig({}, { isCommercial: false }), {});
    assert.deepEqual(antigravityRelayConcurrencyFromConfig({}, { isCommercial: true }), {
      maxInflightPerRoute: COMMERCIAL_DEFAULT_ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE,
      maxAuxInflightPerRoute: COMMERCIAL_DEFAULT_ANTIGRAVITY_AUX_MAX_INFLIGHT_PER_ROUTE,
    });
    assert.deepEqual(
      antigravityRelayConcurrencyFromConfig({}, { flavorIdentity: okFlavor("commercial") }),
      {
        maxInflightPerRoute: COMMERCIAL_DEFAULT_ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE,
        maxAuxInflightPerRoute: COMMERCIAL_DEFAULT_ANTIGRAVITY_AUX_MAX_INFLIGHT_PER_ROUTE,
      },
    );
    assert.deepEqual(
      antigravityRelayConcurrencyFromConfig({}, { flavorIdentity: okFlavor("selfhost") }),
      {},
    );
    assert.deepEqual(
      antigravityRelayConcurrencyFromConfig(
        { OC_ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE: 20 },
        { isCommercial: true },
      ),
      {
        maxInflightPerRoute: 20,
        maxAuxInflightPerRoute: COMMERCIAL_DEFAULT_ANTIGRAVITY_AUX_MAX_INFLIGHT_PER_ROUTE,
      },
    );
  });
});

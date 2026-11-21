import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FlavorIdentity, FlavorManifest } from "./assertFlavor.js";
import {
  isSelfhostFlavor,
  shouldStartCommercialScheduler,
} from "./commercialSchedulerPolicy.js";

function okFlavor(flavor: "selfhost" | "commercial"): FlavorIdentity {
  return {
    status: "ok",
    flavor,
    manifest: {
      schema: 1,
      flavor,
      sourceCommit: "0000000",
      builder: flavor === "selfhost" ? "deploy-v5-selfhost.sh" : "deploy-v5.sh",
      expectedHosts: [],
      expectedRoots: [],
      expectedDbNames: [],
      guardGeneration: 1,
    } as FlavorManifest,
    manifestPath: "/tmp/flavor.manifest.json",
  };
}

const SKIPPED: FlavorIdentity = { status: "skipped", reason: "no-manifest" };

describe("commercialSchedulerPolicy (OCV5-825)", () => {
  test("skips tutorialModeration, marketplaceAiReview, pendingOrdersExpirer in selfhost flavor by default", () => {
    const selfhost = okFlavor("selfhost");
    assert.equal(isSelfhostFlavor(selfhost), true);
    for (const name of ["tutorialModeration", "marketplaceAiReview", "pendingOrdersExpirer"] as const) {
      assert.equal(
        shouldStartCommercialScheduler(name, { flavorIdentity: selfhost, runtimeChannel: "v5", env: {} }),
        false,
        `selfhost must skip ${name}`,
      );
    }
  });

  test("preserves default commercial & manifest-less behavior untouched", () => {
    for (const identity of [okFlavor("commercial"), SKIPPED]) {
      assert.equal(isSelfhostFlavor(identity), false);
      assert.equal(
        shouldStartCommercialScheduler("tutorialModeration", { flavorIdentity: identity, runtimeChannel: "v5", env: {} }),
        true,
      );
      assert.equal(
        shouldStartCommercialScheduler("marketplaceAiReview", { flavorIdentity: identity, runtimeChannel: "v5", env: {} }),
        true,
      );
      assert.equal(
        shouldStartCommercialScheduler("pendingOrdersExpirer", { flavorIdentity: identity, runtimeChannel: "v5", env: {} }),
        true,
      );
      // v3 channel never runs v5-only moderation / marketplace aiReview
      assert.equal(
        shouldStartCommercialScheduler("tutorialModeration", { flavorIdentity: identity, runtimeChannel: "v3", env: {} }),
        false,
      );
      assert.equal(
        shouldStartCommercialScheduler("marketplaceAiReview", { flavorIdentity: identity, runtimeChannel: "v3", env: {} }),
        false,
      );
      // Explicit disable env flags still honored in commercial
      assert.equal(
        shouldStartCommercialScheduler("marketplaceAiReview", {
          flavorIdentity: identity,
          runtimeChannel: "v5",
          env: { OC_MARKETPLACE_AI_REVIEW_DISABLED: "1" },
        }),
        false,
      );
      assert.equal(
        shouldStartCommercialScheduler("pendingOrdersExpirer", {
          flavorIdentity: identity,
          runtimeChannel: "v5",
          env: { COMMERCIAL_PENDING_ORDERS_EXPIRER_DISABLED: "1" },
        }),
        false,
      );
    }
  });

  test("allows pendingOrdersExpirer in selfhost when payment is explicitly enabled, while still skipping moderation/aiReview", () => {
    const selfhost = okFlavor("selfhost");
    assert.equal(
      shouldStartCommercialScheduler("pendingOrdersExpirer", {
        flavorIdentity: selfhost,
        runtimeChannel: "v5",
        paymentEnabled: true,
        env: {},
      }),
      true,
    );
    assert.equal(
      shouldStartCommercialScheduler("tutorialModeration", {
        flavorIdentity: selfhost,
        runtimeChannel: "v5",
        paymentEnabled: true,
        env: {},
      }),
      false,
    );
    assert.equal(
      shouldStartCommercialScheduler("marketplaceAiReview", {
        flavorIdentity: selfhost,
        runtimeChannel: "v5",
        paymentEnabled: true,
        env: {},
      }),
      false,
    );
  });

  test("allows explicit opt-in override in selfhost via OC_SELFHOST_RUN_COMMERCIAL_SCHEDULERS=1", () => {
    const selfhost = okFlavor("selfhost");
    assert.equal(
      shouldStartCommercialScheduler("pendingOrdersExpirer", {
        flavorIdentity: selfhost,
        runtimeChannel: "v5",
        env: { OC_SELFHOST_RUN_COMMERCIAL_SCHEDULERS: "1" },
      }),
      true,
    );
  });
});

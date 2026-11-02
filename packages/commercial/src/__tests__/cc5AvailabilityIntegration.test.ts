import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canUseModel } from "../billing/authzModels.js";
import { configureModelAvailability } from "../billing/modelAvailability.js";
import { ModelCatalogSnapshot, type ModelCatalogEntry, type ModelCatalogPricing } from "../billing/modelCatalog.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import type { FlavorIdentity } from "../flavor/assertFlavor.js";

const profiles = ["selfhost-paused", "selfhost-restored", "commercial"] as const;
type Profile = typeof profiles[number];
const ids = ["grok-build", "cc5-remote-t1555u", "box-claude-sonnet-5"];

function verifyProfile(profile: Profile): void {
  const root = mkdtempSync(join(tmpdir(), "oc-cc5-availability-"));
  try {
    mkdirSync(join(root, "deploy/v5-selfhost"), { recursive: true });
    writeFileSync(join(root, "deploy/v5-selfhost/model-availability.json"), JSON.stringify({ grokEnabled: profile === "selfhost-restored" }));
    const flavor = profile === "commercial" ? "commercial" : "selfhost";
    const identity: Extract<FlavorIdentity, { status: "ok" }> = {
      status: "ok", flavor, manifestPath: join(root, "release-flavor.json"),
      manifest: { schema: 1, flavor, builder: flavor === "selfhost" ? "deploy-v5-selfhost.sh" : "deploy-v5.sh",
        sourceCommit: "a".repeat(40), expectedHosts: [], expectedRoots: [], expectedDbNames: [], guardGeneration: 1 },
    };
    configureModelAvailability(identity);
    const entries: ModelCatalogEntry[] = ids.map((modelId, i) => ({
      entryId: i + 1, modelId, engine: i === 0 ? "grok" : "ccb", providerId: i === 0 ? "grok" : "anthropic",
      upstreamModelId: null, contextWindow: 200_000, state: "active", lockVersion: 0, capabilitySchemaVersion: 1,
      capabilityProfile: { supportsVision: false, reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false } },
    }));
    const prices: ModelCatalogPricing[] = ids.map((modelId, i) => ({
      modelId, displayName: modelId, inputPerMtok: 100n, outputPerMtok: 200n, cacheReadPerMtok: 10n,
      cacheWritePerMtok: 20n, multiplier: "1.000", visibility: "public", sortOrder: i, defaultEffort: null,
    }));
    const rows: ModelPricing[] = prices.map((p) => ({
      model_id: p.modelId, display_name: p.displayName, input_per_mtok: p.inputPerMtok, output_per_mtok: p.outputPerMtok,
      cache_read_per_mtok: p.cacheReadPerMtok, cache_write_per_mtok: p.cacheWritePerMtok, multiplier: p.multiplier,
      enabled: true, visibility: "public", sort_order: p.sortOrder, default_effort: null,
      extra_system_prompt: null, updated_at: new Date(0),
    }));
    const expected = profile === "selfhost-paused" ? [ids[2]] : [ids[0], ids[2]];
    for (const enabled of ["0", "1"]) {
      // Retired task-model flags cannot override either deployment policy.
      process.env.OC_SELFHOST_CC5_T1555U_ENABLED = enabled;
      process.env.OC_SELFHOST_CC5_T1555U_TEST_UID = "99";
      const pricing = new PricingCache();
      pricing._setForTests(rows);
      const catalog = new ModelCatalogSnapshot({ entries, aliases: new Map([["old-grok", 1], ["old-cc5", 2]]),
        pricing: new Map(prices.map((p) => [p.modelId, p])), securityEpoch: 1n });
      assert.deepEqual(pricing.listPublic().map((p) => p.id), expected);
      for (const role of ["user", "admin"] as const) {
        const scope = { uid: 99, role, grantedModelIds: new Set(ids), userPlanTier: 10 };
        assert.deepEqual(pricing.listForUser(scope).map((p) => p.id), expected);
        assert.deepEqual(catalog.listForUser(scope).map((p) => p.modelId), expected);
        for (const modelId of ids) {
          assert.equal(canUseModel({ pricing }, { ...scope, modelId }), expected.includes(modelId));
          assert.equal(catalog.canUseModel(scope, modelId), expected.includes(modelId));
        }
        assert.equal(catalog.canUseModel(scope, "old-cc5"), false);
        assert.deepEqual(catalog.aliasesForUser(scope), profile === "selfhost-paused" ? {} : { "old-grok": ids[0] });
        assert.equal(catalog.listLockedForUser(scope).some((p) => p.modelId === ids[1]), false);
      }
      assert.equal(pricing.get(ids[2])?.input_per_mtok, 100n);
      assert.equal(pricing.get(ids[2])?.multiplier, "1.000");
      assert.equal(catalog.resolve(ids[2])?.engine, "ccb");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const childProfile = process.argv.find((arg) => arg.startsWith("--cc5-availability-profile="))?.split("=")[1];
if (childProfile) {
  assert.ok(profiles.includes(childProfile as Profile));
  verifyProfile(childProfile as Profile);
} else {
  for (const profile of profiles) {
    test(`merged availability and retired cc5 guards: ${profile}`, () => {
      // Deployment identity is boot-only; each real profile gets a fresh process.
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), `--cc5-availability-profile=${profile}`],
        { encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}

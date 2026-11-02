import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FlavorIdentity } from "../flavor/assertFlavor.js";
import { configureModelAvailability, modelAvailableForIdentity } from "../billing/modelAvailability.js";
import { ModelCatalogSnapshot, type ModelCatalogEntry, type ModelCatalogPricing } from "../billing/modelCatalog.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import { canUseModel } from "../billing/authzModels.js";

const root = mkdtempSync(join(tmpdir(), "ocv5-713-models-"));
mkdirSync(join(root, "deploy/v5-selfhost"), { recursive: true });
const policyFile = join(root, "deploy/v5-selfhost/model-availability.json");
function identity(flavor: "selfhost" | "commercial"): FlavorIdentity {
  return { status: "ok", flavor, manifestPath: join(root, "release-flavor.json"), manifest: {
    schema: 1, flavor, builder: flavor === "selfhost" ? "deploy-v5-selfhost.sh" : "deploy-v5.sh",
    sourceCommit: "a".repeat(40), expectedHosts: [], expectedRoots: [], expectedDbNames: [], guardGeneration: 1,
  } };
}
function configure(grokEnabled: boolean): void {
  writeFileSync(policyFile, JSON.stringify({ grokEnabled }));
  configureModelAvailability(identity("selfhost"));
}
const ids = ["grok-build", "grok-build-fast", "gpt-6-luna", "deepseek-v4-flash"];
const entries: ModelCatalogEntry[] = ids.map((modelId, i) => ({
  entryId: i + 1, modelId, engine: i < 2 ? "grok" : i === 2 ? "codex" : "ccb",
  providerId: i < 2 ? "grok" : i === 2 ? "codex" : "deepseek", upstreamModelId: null,
  contextWindow: 200_000, state: "active", lockVersion: 0, capabilitySchemaVersion: 1,
  capabilityProfile: { supportsVision: false, reasoning: { supported: [], codexModelDefault: null },
    ccb: { capabilityZero: false, supportsThinking: false } },
}));
const prices: ModelCatalogPricing[] = ids.map((modelId) => ({
  modelId, displayName: modelId, inputPerMtok: 100n, outputPerMtok: 100n, cacheReadPerMtok: 10n,
  cacheWritePerMtok: 0n, multiplier: "1.000", visibility: "public", sortOrder: 1, defaultEffort: null,
  ...(modelId === "grok-build-fast" ? { minPlanCode: "pro", minPlanTier: 5 } : {}),
}));
function snapshot(): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({ entries, aliases: new Map([["old-grok", 1], ["old-fast", 2]]),
    pricing: new Map(prices.map((p) => [p.modelId, p])), securityEpoch: 1n });
}
const scope = { uid: 99, role: "user" as const, grantedModelIds: new Set(ids), userPlanTier: 10 };

test("OCV5-713: verified selfhost only; non-Grok and commercial policy stay available", () => {
  for (const id of ids) {
    assert.equal(modelAvailableForIdentity(identity("commercial"), false, id), true);
    assert.equal(modelAvailableForIdentity({ status: "skipped", reason: "no-manifest" }, false, id), true);
    assert.equal(modelAvailableForIdentity(identity("selfhost"), true, id), true);
    assert.equal(modelAvailableForIdentity(identity("selfhost"), false, id), !id.startsWith("grok-build"));
  }
});

test("OCV5-713: both Grok entries and aliases are hidden and rejected despite admin/grants", () => {
  configure(false);
  const snap = snapshot();
  for (const user of [scope, { ...scope, uid: 0, grantedModelIds: new Set<string>() }, { ...scope, role: "admin" as const }]) {
    assert.deepEqual(snap.listForUser(user).map((m) => m.modelId).sort(), ids.slice(2).sort());
    assert.deepEqual(snap.aliasesForUser(user), {});
    for (const id of [...ids.slice(0, 2), "old-grok", "old-fast"]) {
      assert.equal(snap.canUseModel(user, id), false);
      assert.equal(snap.isRoutable(id), false);
      assert.equal(snap.resolve(id), null);
      assert.equal(snap.billingPricingFor(id), null);
    }
  }
  assert.deepEqual(snap.listLockedForUser({ ...scope, userPlanTier: 0 }), []);
  for (const id of ids.slice(2)) assert.ok(snap.resolve(id));
  assert.deepEqual(snap.activeModelIds(), ids.slice(2).sort());
});

test("OCV5-713: legacy lists and explicit chat authorization reject paused Grok", () => {
  configure(false);
  const pricing = new PricingCache();
  const rows: ModelPricing[] = ids.map((model_id) => ({ model_id, display_name: model_id,
    input_per_mtok: 100n, output_per_mtok: 100n, cache_read_per_mtok: 10n, cache_write_per_mtok: 0n,
    multiplier: "1.000", enabled: true, sort_order: 1, visibility: "public", extra_system_prompt: null,
    default_effort: null, updated_at: new Date(0) }));
  pricing._setForTests(rows);
  assert.deepEqual(pricing.listPublic().map((m) => m.id), ids.slice(2));
  assert.deepEqual(pricing.listForUser(scope).map((m) => m.id), ids.slice(2));
  for (const modelId of ids) {
    assert.equal(pricing.get(modelId)?.enabled, !modelId.startsWith("grok-build"));
    assert.equal(canUseModel({ pricing }, { ...scope, role: "admin", modelId }), !modelId.startsWith("grok-build"));
  }
});

test("OCV5-713: changing the one versioned switch restores catalog and execution revisions", () => {
  configure(false);
  const paused = snapshot();
  configure(true);
  const restored = snapshot();
  assert.deepEqual(restored.activeModelIds(), [...ids].sort());
  assert.ok(restored.resolve("old-grok"));
  assert.ok(restored.resolve("old-fast"));
  assert.equal(restored.canUseModel(scope, "old-grok"), true);
  assert.deepEqual(restored.aliasesForUser(scope), { "old-grok": "grok-build", "old-fast": "grok-build-fast" });
  assert.notEqual(paused.executionRevision, restored.executionRevision);
  assert.notEqual(paused.projectionRevisionFor(scope), restored.projectionRevisionFor(scope));
  // A snapshot stays immutable; a fresh official release supplies a new policy.
  assert.equal(paused.resolve("grok-build"), null);
  configure(false);
  assert.equal(snapshot().executionRevision, paused.executionRevision);
});

test("OCV5-713: missing or malformed release policy refuses startup", () => {
  for (const value of [null, {}, { grokEnabled: "false" }]) {
    writeFileSync(policyFile, JSON.stringify(value));
    assert.throws(() => configureModelAvailability(identity("selfhost")), /boolean grokEnabled/);
  }
  assert.throws(() => configureModelAvailability({ ...identity("selfhost"), manifestPath: "/nonexistent/flavor.json" }), /ENOENT/);
  configure(false);
});

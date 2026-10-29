import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBridgeAgentResolver, loadBridgeModelChecker } from "../ws/bridgeExecutionContext.js";
import type { AgentModelResolver } from "../ws/agentModelAuthority.js";
import type { UserChatBridgeDeps } from "../ws/userChatBridge.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function deps(extra: Partial<UserChatBridgeDeps> = {}): UserChatBridgeDeps {
  return { jwtSecret: "execution-context-test", resolveContainerEndpoint: async () => ({ host: "unused", port: 0 }), ...extra };
}
function authority(epoch: () => bigint): NonNullable<UserChatBridgeDeps["modelAuthority"]> {
  return { catalog: { peek: () => ({ securityEpoch: epoch() }) } } as unknown as NonNullable<UserChatBridgeDeps["modelAuthority"]>;
}

test("checker stamps before reading grants and reloads after an epoch change during the read", async () => {
  let epoch = 3n;
  const loads: Array<bigint | undefined> = [];
  const checker = await loadBridgeModelChecker(deps({
    modelAuthority: authority(() => epoch),
    loadAllowedModelChecker: async (uid, requiredEpoch) => {
      assert.equal(uid, 42n);
      loads.push(requiredEpoch);
      epoch = 4n;
      return () => requiredEpoch === 3n;
    },
  }), 42n);
  assert.ok(checker);
  assert.equal(checker.epoch(), 3n, "an epoch observed after the grants read cannot stamp that snapshot");
  assert.equal(checker.isAllowed("model"), true);
  await checker.reloadAtLeast(4n);
  assert.equal(checker.epoch(), 4n);
  assert.equal(checker.isAllowed("model"), false);
  assert.deepEqual(loads, [3n, 4n]);
});

test("checker refresh keeps last good grants while a mandatory epoch reload rejects on failure", async () => {
  let fail = false;
  const checker = await loadBridgeModelChecker(deps({
    modelAuthority: authority(() => 1n),
    loadAllowedModelChecker: async () => {
      if (fail) throw new Error("grants unavailable");
      return () => true;
    },
  }), 42n);
  assert.ok(checker);
  fail = true;
  await checker.refresh();
  assert.equal(checker.epoch(), 1n);
  assert.equal(checker.isAllowed("model"), true);
  await assert.rejects(checker.reloadAtLeast(2n), /grants unavailable/);
  assert.equal(checker.epoch(), 1n);
});

test("a late refresh cannot replace a newer revoked snapshot; strict reload does not join older work", async () => {
  let epoch = 1n;
  const older = deferred<(model: string) => boolean>();
  const loads: Array<bigint | undefined> = [];
  const checker = await loadBridgeModelChecker(deps({
    modelAuthority: authority(() => epoch),
    loadAllowedModelChecker: async (_uid, requiredEpoch) => {
      loads.push(requiredEpoch);
      if (requiredEpoch === 2n) return older.promise;
      return () => requiredEpoch === 1n;
    },
  }), 42n);
  assert.ok(checker);
  epoch = 2n;
  const refresh = checker.refresh();
  await checker.reloadAtLeast(3n);
  assert.equal(checker.epoch(), 3n);
  assert.equal(checker.isAllowed("revoked"), false);
  older.resolve(() => true);
  await refresh;
  assert.equal(checker.epoch(), 3n);
  assert.equal(checker.isAllowed("revoked"), false);
  assert.deepEqual(loads, [1n, 2n, 3n]);
});

test("concurrent mandatory reloads share a load that already targets the required epoch", async () => {
  const reload = deferred<(model: string) => boolean>();
  let calls = 0;
  const checker = await loadBridgeModelChecker(deps({
    modelAuthority: authority(() => 1n),
    loadAllowedModelChecker: async (_uid, requiredEpoch) => {
      calls++;
      return requiredEpoch === 2n ? reload.promise : () => true;
    },
  }), 42n);
  assert.ok(checker);
  const one = checker.reloadAtLeast(2n);
  const two = checker.reloadAtLeast(2n);
  assert.equal(calls, 2, "one initial load and one shared mandatory reload");
  reload.resolve(() => false);
  await Promise.all([one, two]);
  assert.equal(checker.epoch(), 2n);
  assert.equal(checker.isAllowed("revoked"), false);
});

test("checker initial loader failures propagate and a disabled loader retains the legacy null handle", async () => {
  await assert.rejects(loadBridgeModelChecker(deps({
    loadAllowedModelChecker: async () => { throw new Error("initial grants unavailable"); },
  }), 42n), /initial grants unavailable/);
  assert.equal(await loadBridgeModelChecker(deps(), 42n), null);
});

test("agent resolver uses the actual connection revision on every load and preserves identity refusal", async () => {
  const seen: Array<{ uid: bigint; bundleRev?: string }> = [];
  const denied = new Error("registered identity unavailable");
  const resolver: AgentModelResolver = Object.assign((agentId: string) => agentId === "main" ? "running-rev-model" : null, {
    isRuntimeDenied: (agentId: string) => agentId === "registered",
    isIdentityRegistered: (agentId: string) => agentId === "registered",
    authorizeExecution: async (agentId: string) => {
      if (agentId === "registered") throw denied;
      return { identity: { requestedId: agentId, executionAgentId: agentId, status: "no-registration" as const }, model: "running-rev-model" };
    },
  });
  const agents = await loadBridgeAgentResolver(deps({
    loadAgentModelResolver: async (uid, options) => { seen.push({ uid, ...options }); return resolver; },
  }), 42n, "running-bundle-older-than-desired");
  assert.ok(agents);
  assert.equal(agents.resolve("main"), "running-rev-model");
  assert.equal(agents.isRuntimeDenied("registered"), true);
  assert.equal(agents.isIdentityRegistered("registered"), true);
  await assert.rejects(agents.authorizeExecution("registered"), error => error === denied);
  await agents.refresh();
  assert.deepEqual(seen, [
    { uid: 42n, bundleRev: "running-bundle-older-than-desired" },
    { uid: 42n, bundleRev: "running-bundle-older-than-desired" },
  ]);
});

test("agent initial load fails closed; refresh failure keeps the previous connection snapshot", async () => {
  let fail = false;
  const source = deps({
    loadAgentModelResolver: async () => {
      if (fail) throw new Error("seed revision unavailable");
      return () => "running-model";
    },
  });
  const agents = await loadBridgeAgentResolver(source, 42n, "actual-rev");
  assert.ok(agents);
  fail = true;
  await agents.refresh();
  assert.equal(agents.resolve("main"), "running-model");
  await assert.rejects(loadBridgeAgentResolver(source, 42n, "actual-rev"), /seed revision unavailable/);
  assert.equal(await loadBridgeAgentResolver(deps(), 42n), null);
});

test("desktop resolver retains the existing missing-revision contract", async () => {
  const seen: Array<{ bundleRev?: string }> = [];
  const agents = await loadBridgeAgentResolver(deps({
    loadAgentModelResolver: async (_uid, options) => { seen.push(options); return () => "desktop-model"; },
  }), 42n);
  assert.ok(agents);
  await agents.refresh();
  assert.deepEqual(seen, [{}, {}]);
});

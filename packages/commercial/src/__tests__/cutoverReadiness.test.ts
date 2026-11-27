import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createCutoverInFlightTracker,
  CUTOVER_FENCE_PATH,
  CUTOVER_FENCING_ERROR_CODE,
  CUTOVER_READINESS_PATH,
  DEPLOY_REFRESH_DESIRED_PATH,
  DRAIN_WS_PATH,
  handleCutoverControlRequest,
  rejectIfCutoverFencing,
  type CutoverControlDeps,
} from "../deploy/cutoverReadiness.js";
import type { DesiredSnapshot } from "../deploy/deployState.js";
import { ContainerLinkControls } from "../ws/containerLinkControls.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function httpJson(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("cutoverInFlightTracker tracks counts idempotently across finish/close/manual release", () => {
  const tracker = createCutoverInFlightTracker();
  const fakeRes = new EventEmitter();
  const r1 = tracker.begin("externalApi", fakeRes as never);
  const r2 = tracker.begin("cursorExternal");
  const r3 = tracker.begin("muse");
  tracker.setChatgptProxyTunnelsGetter(() => 2);

  assert.deepEqual(tracker.snapshot(), {
    activeExternalApi: 1,
    activeCursorExternal: 1,
    activeChatgptProxy: 2,
    activeMuse: 1,
    nonSurvivableInFlight: 5,
    fencing: false,
  });

  // Emitting both finish + close + manual release decrements exactly once
  fakeRes.emit("finish");
  fakeRes.emit("close");
  r1();
  r2();
  r2();
  r3();
  tracker.setChatgptProxyTunnelsGetter(() => 0);

  assert.deepEqual(tracker.snapshot(), {
    activeExternalApi: 0,
    activeCursorExternal: 0,
    activeChatgptProxy: 0,
    activeMuse: 0,
    nonSurvivableInFlight: 0,
    fencing: false,
  });
});

test("cutover control endpoints enforce x-oc-egress-secret auth and serve readiness/refresh/drain", async () => {
  const tracker = createCutoverInFlightTracker();
  let snap: DesiredSnapshot = {
    activeSlot: "A",
    desiredLeaderSlot: "A",
    desiredControlSlot: "A",
    phase: "stable",
    generation: 1,
  };
  let refreshCount = 0;
  let drainedCalls = 0;
  let containerLinkOn = false;
  let secret: string | undefined = "test-secret-123";

  const deps: CutoverControlDeps = {
    slot: "B",
    get secret() {
      return secret;
    },
    verifySecret: (a, b) => a === b,
    getLeadership: () => ({ state: "standby", slot: "B", generation: 1, leasePid: null }),
    getControlListener: () => ({
      status: () => ({ privateBound: true, vipBound: false, vipDesired: false }),
      isVipOwner: () => false,
    }),
    desiredWatch: {
      current: () => snap,
      refreshNow: async () => {
        refreshCount += 1;
        snap = { ...snap, activeSlot: "B", desiredLeaderSlot: "B", desiredControlSlot: "B" };
        return snap;
      },
    },
    tracker,
    getActiveBrowserWs: () => 3,
    drainBrowserWebSockets: () => {
      drainedCalls += 1;
      return 3;
    },
    getContainerLinkEnabled: () => containerLinkOn,
  };

  const server = createServer((req, res) => {
    if (!handleCutoverControlRequest(req, res, deps)) {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const port = await listen(server);

  try {
    // Missing secret header -> 401
    const unauth = await httpJson(port, "GET", CUTOVER_READINESS_PATH);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.json.error, "UNAUTHORIZED");

    // Wrong method -> 405
    const wrongMethod = await httpJson(port, "POST", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(wrongMethod.status, 405);

    // Readiness with live in-flight request
    const rel = tracker.begin("muse");
    const ready1 = await httpJson(port, "GET", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(ready1.status, 200);
    assert.deepEqual(ready1.json, {
      ok: true,
      slot: "B",
      role: "standby",
      vipOwner: false,
      fencing: false,
      containerLinkEnabled: false,
      activeExternalApi: 0,
      activeCursorExternal: 0,
      activeChatgptProxy: 0,
      activeMuse: 1,
      activeBrowserWs: 3,
      nonSurvivableInFlight: 1,
      remoteRelayExternal: false,
      remoteRelayHealthy: false,
      remoteRelayDisabled: false,
      remoteRelaySlot: null,
      remoteRelayInstanceId: null,
      remoteRelayActiveCount: 0,
    });

    // B05: containerLinkEnabled reflects real runtime truth (false vs true)
    containerLinkOn = true;
    const readyClTrue = await httpJson(port, "GET", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(readyClTrue.status, 200);
    assert.equal(readyClTrue.json.containerLinkEnabled, true);
    containerLinkOn = false;

    // B04: POST /internal/v5/cutover-fence toggles fencing, rejects new entries with 503 Retry-After: 1,
    // while existing in-flight request still drains cleanly to 0.
    const badFence = await httpJson(
      port,
      "POST",
      CUTOVER_FENCE_PATH,
      { "x-oc-egress-secret": "test-secret-123", "content-type": "application/json" },
      JSON.stringify({ enabled: "yes" }),
    );
    assert.equal(badFence.status, 400);

    const fenceOn = await httpJson(
      port,
      "POST",
      CUTOVER_FENCE_PATH,
      { "x-oc-egress-secret": "test-secret-123", "content-type": "application/json" },
      JSON.stringify({ enabled: true }),
    );
    assert.equal(fenceOn.status, 200);
    assert.deepEqual(fenceOn.json, { ok: true, slot: "B", fencing: true });

    const readyFenced = await httpJson(port, "GET", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(readyFenced.json.fencing, true);
    assert.equal(readyFenced.json.nonSurvivableInFlight, 1);

    // Simulate new entry hitting rejectIfCutoverFencing while fenced
    const fakeResHeaders: Record<string, string> = {};
    let fakeBody = "";
    const fakeRes = {
      headersSent: false,
      destroyed: false,
      statusCode: 200,
      setHeader(k: string, v: string) { fakeResHeaders[k.toLowerCase()] = v; },
      end(chunk?: string) { fakeBody = chunk ?? ""; },
    };
    assert.equal(rejectIfCutoverFencing(fakeRes as never, tracker), true);
    assert.equal(fakeRes.statusCode, 503);
    assert.equal(fakeResHeaders["retry-after"], "1");
    assert.deepEqual(JSON.parse(fakeBody), { ok: false, error: CUTOVER_FENCING_ERROR_CODE });

    // Existing in-flight request finishes cleanly while fenced
    rel();
    const readyDrained = await httpJson(port, "GET", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(readyDrained.json.fencing, true);
    assert.equal(readyDrained.json.nonSurvivableInFlight, 0);

    const fenceOff = await httpJson(
      port,
      "POST",
      CUTOVER_FENCE_PATH,
      { "x-oc-egress-secret": "test-secret-123", "content-type": "application/json" },
      JSON.stringify({ enabled: false }),
    );
    assert.equal(fenceOff.status, 200);
    assert.deepEqual(fenceOff.json, { ok: true, slot: "B", fencing: false });

    // POST /internal/v5/deploy/refresh-desired
    const refreshed = await httpJson(port, "POST", DEPLOY_REFRESH_DESIRED_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshCount, 1);
    assert.deepEqual(refreshed.json, {
      ok: true,
      slot: "B",
      activeSlot: "B",
      desiredLeaderSlot: "B",
      desiredControlSlot: "B",
      role: "standby",
      vipOwner: false,
    });

    // POST /internal/v5/drain-ws
    const drained = await httpJson(port, "POST", DRAIN_WS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(drained.status, 200);
    assert.equal(drainedCalls, 1);
    assert.deepEqual(drained.json, { ok: true, slot: "B", closedCount: 3 });

    // Unset server secret -> 503
    secret = undefined;
    const unset = await httpJson(port, "GET", CUTOVER_READINESS_PATH, {
      "x-oc-egress-secret": "test-secret-123",
    });
    assert.equal(unset.status, 503);
    assert.equal(unset.json.error, "EGRESS_SECRET_UNSET");
  } finally {
    await close(server);
  }
});

test("ContainerLinkControls stays idle while paused (standby) and scans immediately on setActive(true)", async () => {
  let queries = 0;
  const fakePool = {
    query: async () => {
      queries += 1;
      return { rows: [] };
    },
  };
  const controls = new ContainerLinkControls({
    pool: fakePool as never,
    channel: "v5",
    links: {} as never,
    legacy: new Map(),
    paused: true,
  });

  try {
    await controls.scan();
    assert.equal(queries, 0, "standby paused controls must not query PG");

    controls.setActive(true);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(queries >= 1, "activating controls must trigger immediate scan");

    const beforePause = queries;
    controls.setActive(false);
    await controls.scan();
    assert.equal(queries, beforePause, "pausing again must suppress subsequent scans");
  } finally {
    await controls.stop();
  }
});

test("cutover-readiness reports live external remote-relay fields and fails closed on unhealthy/error probe", async () => {
  type ProbeFn = NonNullable<CutoverControlDeps["probeRemoteRelayReadiness"]>;
  let currentProbe: ProbeFn = async () => ({
    external: true,
    healthy: true,
    slot: "A",
    instanceId: "rr-inst-a-1",
    activeCount: 4,
  });

  const deps: CutoverControlDeps = {
    slot: "A",
    secret: "relay-secret-xyz",
    verifySecret: (a, b) => a === b,
    getLeadership: () => ({ state: "leader", slot: "A", generation: 2, leasePid: process.pid }),
    getControlListener: () => ({
      status: () => ({ privateBound: true, vipBound: true, vipDesired: true }),
      isVipOwner: () => true,
    }),
    tracker: createCutoverInFlightTracker(),
    probeRemoteRelayReadiness: () => currentProbe(),
  };

  const server = createServer((req, res) => {
    if (!handleCutoverControlRequest(req, res, deps)) {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const port = await listen(server);
  const auth = { "x-oc-egress-secret": "relay-secret-xyz" };

  try {
    // 1. Healthy external remote-relay
    const healthy = await httpJson(port, "GET", CUTOVER_READINESS_PATH, auth);
    assert.equal(healthy.status, 200);
    assert.equal(healthy.json.remoteRelayExternal, true);
    assert.equal(healthy.json.remoteRelayHealthy, true);
    assert.equal(healthy.json.remoteRelayDisabled, false);
    assert.equal(healthy.json.remoteRelaySlot, "A");
    assert.equal(healthy.json.remoteRelayInstanceId, "rr-inst-a-1");
    assert.equal(healthy.json.remoteRelayActiveCount, 4);

    // 2. Unhealthy / draining external remote-relay
    currentProbe = async () => ({
      external: true,
      healthy: false,
      disabled: false,
      slot: "A",
      instanceId: "rr-inst-a-1",
      activeCount: 2,
    });
    const draining = await httpJson(port, "GET", CUTOVER_READINESS_PATH, auth);
    assert.equal(draining.status, 200);
    assert.equal(draining.json.remoteRelayExternal, true);
    assert.equal(draining.json.remoteRelayHealthy, false);
    assert.equal(draining.json.remoteRelayDisabled, false);
    assert.equal(draining.json.remoteRelaySlot, "A");
    assert.equal(draining.json.remoteRelayInstanceId, "rr-inst-a-1");
    assert.equal(draining.json.remoteRelayActiveCount, 2);

    // 2b. B6: Intentionally disabled external remote-relay -> healthy=false, disabled=true (never fakes healthy)
    currentProbe = async () => ({
      external: true,
      healthy: false,
      disabled: true,
      slot: "A",
      instanceId: "rr-inst-a-disabled",
      activeCount: 0,
    });
    const disabledRes = await httpJson(port, "GET", CUTOVER_READINESS_PATH, auth);
    assert.equal(disabledRes.status, 200);
    assert.equal(disabledRes.json.remoteRelayExternal, true);
    assert.equal(disabledRes.json.remoteRelayHealthy, false);
    assert.equal(disabledRes.json.remoteRelayDisabled, true);
    assert.equal(disabledRes.json.remoteRelaySlot, "A");
    assert.equal(disabledRes.json.remoteRelayInstanceId, "rr-inst-a-disabled");
    assert.equal(disabledRes.json.remoteRelayActiveCount, 0);

    // 3. Empty instanceId fails closed even if probe claimed healthy
    currentProbe = async () => ({
      external: true,
      healthy: true,
      slot: "B",
      instanceId: "",
      activeCount: 0,
    });
    const noId = await httpJson(port, "GET", CUTOVER_READINESS_PATH, auth);
    assert.equal(noId.status, 200);
    assert.equal(noId.json.remoteRelayExternal, true);
    assert.equal(noId.json.remoteRelayHealthy, false);
    assert.equal(noId.json.remoteRelayDisabled, false);
    assert.equal(noId.json.remoteRelayInstanceId, null);

    // 4. Probe throws/times out -> fail-closed 200 with healthy=false
    currentProbe = async () => {
      throw new Error("ENOENT: socket vanished");
    };
    const failed = await httpJson(port, "GET", CUTOVER_READINESS_PATH, auth);
    assert.equal(failed.status, 200);
    assert.equal(failed.json.remoteRelayExternal, false);
    assert.equal(failed.json.remoteRelayHealthy, false);
    assert.equal(failed.json.remoteRelayDisabled, false);
    assert.equal(failed.json.remoteRelaySlot, null);
    assert.equal(failed.json.remoteRelayInstanceId, null);
    assert.equal(failed.json.remoteRelayActiveCount, 0);
  } finally {
    await close(server);
  }
});

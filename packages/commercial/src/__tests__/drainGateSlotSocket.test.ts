import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_REMOTE_V4_DRAIN_SOCKET,
  RemoteReleaseDrainCoordinator,
  resolveRemoteV4DrainSocketPath,
  startRemoteReleaseDrainSocketServer,
} from "../account-pool/remotePool/drainGate.js";

function unixGetJson(socketPath: string, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("resolveRemoteV4DrainSocketPath honors OC_REMOTE_V4_DRAIN_SOCKET and preserves legacy default", () => {
  assert.equal(resolveRemoteV4DrainSocketPath({}), DEFAULT_REMOTE_V4_DRAIN_SOCKET);
  assert.equal(
    resolveRemoteV4DrainSocketPath({ OC_REMOTE_V4_DRAIN_SOCKET: "  " }),
    DEFAULT_REMOTE_V4_DRAIN_SOCKET,
  );
  assert.equal(
    resolveRemoteV4DrainSocketPath({ OC_REMOTE_V4_DRAIN_SOCKET: "none" }),
    DEFAULT_REMOTE_V4_DRAIN_SOCKET,
  );
  assert.equal(
    resolveRemoteV4DrainSocketPath({
      OC_REMOTE_V4_DRAIN_SOCKET: "/run/openclaude-v5-selfhost/remote-v4-drain-B.sock",
    }),
    "/run/openclaude-v5-selfhost/remote-v4-drain-B.sock",
  );
});

test("dual-slot drain sockets coexist without overwriting each other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-drain-slot-"));
  const sockA = join(dir, "remote-v4-drain-A.sock");
  const sockB = join(dir, "remote-v4-drain-B.sock");
  const fakePool = () =>
    ({
      query: async () => ({ rows: [{ cnt: "0" }] }),
    }) as never;

  const gateA = new RemoteReleaseDrainCoordinator();
  gateA.registerRelay("lane-a", { idle: false });
  const gateB = new RemoteReleaseDrainCoordinator();

  const handleA = startRemoteReleaseDrainSocketServer(gateA, { pool: fakePool, socketPath: sockA });
  const handleB = startRemoteReleaseDrainSocketServer(gateB, { pool: fakePool, socketPath: sockB });

  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(existsSync(sockA), "slot A drain socket must survive slot B startup");
    assert.ok(existsSync(sockB), "slot B drain socket must exist");

    const statusA = await unixGetJson(sockA, "/status");
    const statusB = await unixGetJson(sockB, "/status");
    assert.equal(statusA.activeRelayCount, 1, "slot A retains its active relay view");
    assert.equal(statusB.activeRelayCount, 0, "slot B independently reports 0 active relays");
  } finally {
    await handleA.close();
    await handleB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

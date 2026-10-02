/** Isolated Unix-socket Redis proof: a later ordinary reservation cannot
 * shorten an earlier four-hour Box lock on the same user's shared keys. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import IORedis from "ioredis";
import { wrapIoredisForPreCheck } from "../billing/preCheck.js";

const hasRedisServer = spawnSync("redis-server", ["--version"],
  { stdio: "ignore" }).status === 0;

if ((process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1") && !hasRedisServer) {
  throw new Error("Redis TTL proof requires the real redis-server binary in CI");
}

test("Box 14700s lock survives later 300s reservation on same Redis key",
  { skip: !hasRedisServer }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-box-reserve-"));
  const socket = path.join(directory, "redis.sock");
  const server = spawn("redis-server", ["--save", "", "--appendonly", "no",
    "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700"],
  { stdio: "ignore" });
  let redis: IORedis | undefined;
  try {
    const until = Date.now() + 3000;
    while (!existsSync(socket) && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(socket), "isolated Redis failed to start");
    redis = new IORedis({ path: socket, maxRetriesPerRequest: 1 });
    await redis.ping();
    const precheck = wrapIoredisForPreCheck(redis);
    const uid = "900000009";
    const long = await precheck.atomicReserve({ userId: uid,
      requestId: "box-paid", balance: 100n, maxCost: 80n,
      ttlSeconds: 14_700 });
    assert.equal(long.ok, true);
    const key = `precheck:u:{${uid}}:locks`;
    const before = await redis.ttl(key);
    assert.ok(before >= 29_390, `long lock key TTL too short: ${before}`);
    const short = await precheck.atomicReserve({ userId: uid,
      requestId: "ordinary", balance: 100n, maxCost: 10n,
      ttlSeconds: 300 });
    assert.equal(short.ok, true);
    const after = await redis.ttl(key);
    assert.ok(after >= before - 2,
      `ordinary request shortened Box reservation backing TTL: ${before} -> ${after}`);
    assert.equal(await redis.hget(`precheck:u:{${uid}}:amounts`, "box-paid"), "80");
    assert.ok(Number(await redis.zscore(key, "box-paid")) > Date.now() + 14_000_000);
  } finally {
    if (redis) await redis.quit().catch(() => redis!.disconnect());
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null) { resolve(); return; }
      server.once("exit", () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});

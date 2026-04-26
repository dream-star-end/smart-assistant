/**
 * computeHostsDiskMonitor 单测。
 *
 * 覆盖:
 *   - parseDfOutput / decideSeverity 纯函数
 *   - DI sshRunFn 路径:1 高水位 → 1 enqueue;2 host 都低 → 0 enqueue;
 *     1 host SSH throw → 不阻塞其他 host,不 enqueue 错误告警
 *   - inFlight guard:连发 _runOnce 不并发执行
 *
 * 不测的:
 *   - 真 SSH(归 E2E,在 boheyun-1 上 stage 高水位文件验)
 *   - 真 DB:用 opts._deps 注入 fake listAllHosts / safeEnqueueAlert / query / decryptSshPassword
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseDfOutput,
  decideSeverity,
  startComputeHostDiskMonitor,
} from "../compute-pool/computeHostsDiskMonitor.js";
import type { SshExecResult, SshTarget } from "../compute-pool/sshExec.js";

// ──────────────────────────────────────────────────────────────

describe("parseDfOutput", () => {
  test("normal", () => {
    assert.equal(parseDfOutput("83%"), 83);
    assert.equal(parseDfOutput("83%\n"), 83);
    assert.equal(parseDfOutput("  100%  \n"), 100);
    assert.equal(parseDfOutput("0%"), 0);
  });
  test("rejects non-percent", () => {
    assert.equal(parseDfOutput(""), null);
    assert.equal(parseDfOutput("83"), null);
    assert.equal(parseDfOutput("/dev/sda1"), null);
  });
  test("rejects NaN / out of range", () => {
    assert.equal(parseDfOutput("abc%"), null);
    assert.equal(parseDfOutput("-1%"), null);
    assert.equal(parseDfOutput("101%"), null);
  });
});

describe("decideSeverity", () => {
  test("no alert below warn", () => {
    assert.equal(decideSeverity(70, 85, 95), null);
    assert.equal(decideSeverity(84, 85, 95), null);
  });
  test("warning at warn threshold (>=)", () => {
    assert.equal(decideSeverity(85, 85, 95), "warning");
    assert.equal(decideSeverity(94, 85, 95), "warning");
  });
  test("critical at crit threshold (>=)", () => {
    assert.equal(decideSeverity(95, 85, 95), "critical");
    assert.equal(decideSeverity(100, 85, 95), "critical");
  });
});

// ──────────────────────────────────────────────────────────────
// 集成 fake:DI 注入,验 enqueue 副作用
// ──────────────────────────────────────────────────────────────

interface TestDeps {
  enqueued: Array<Record<string, unknown>>;
  hosts: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
}

function makeDeps(): TestDeps {
  return { enqueued: [], hosts: [], settings: {} };
}

function makeRow(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "h-1",
    name: "host-1",
    host: "1.2.3.4",
    ssh_port: 22,
    ssh_user: "root",
    ssh_password_nonce: Buffer.alloc(12),
    ssh_password_ct: Buffer.from("ct"),
    status: "ready",
    ...over,
  };
}

function buildOpts(
  deps: TestDeps,
  sshRunFn: (target: SshTarget) => Promise<SshExecResult>,
) {
  return {
    sshRunFn: sshRunFn as never,
    _deps: {
      listAllHosts: (async () => deps.hosts) as never,
      decryptSshPassword: (() => Buffer.from("dummy-pw")) as never,
      enqueueAlert: (async (event: Record<string, unknown>) => {
        deps.enqueued.push(event);
      }) as never,
      query: (async (sql: string, params?: unknown[]) => {
        if (sql.includes("system_settings") && params?.[0]) {
          const key = params[0] as string;
          if (key in deps.settings) {
            return { rows: [{ value: deps.settings[key] }] };
          }
        }
        return { rows: [] };
      }) as never,
    },
  };
}

function fakeSsh(perHost: Record<string, () => Promise<SshExecResult>>) {
  return async (target: SshTarget): Promise<SshExecResult> => {
    const fn = perHost[target.host];
    if (!fn) throw new Error(`no fake configured for host ${target.host}`);
    return fn();
  };
}

describe("startComputeHostDiskMonitor — integration", () => {
  test("high host fires 1 enqueue with severity=warning", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "1.1.1.1": async () => ({ code: 0, stdout: "87%\n", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    assert.equal(deps.enqueued[0].event_type, "health.compute_host_disk_high");
    assert.equal(deps.enqueued[0].severity, "warning");
    const payload = deps.enqueued[0].payload as Record<string, unknown>;
    assert.equal(payload.host_id, "h-1");
    assert.equal(payload.host_name, "host-1");
    assert.equal(payload.used_pct, 87);
  });

  test("critical at 96% with default thresholds", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-2", name: "host-2", host: "2.2.2.2" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "2.2.2.2": async () => ({ code: 0, stdout: "96%", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    assert.equal(deps.enqueued[0].severity, "critical");
  });

  test("both hosts low → 0 enqueue", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-a", name: "host-a", host: "10.0.0.1" }),
      makeRow({ id: "h-b", name: "host-b", host: "10.0.0.2" }),
    ];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "10.0.0.1": async () => ({ code: 0, stdout: "55%\n", stderr: "" }),
          "10.0.0.2": async () => ({ code: 0, stdout: "60%\n", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 0);
  });

  test("one SSH throws → other host still processed, no error enqueue", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-x", name: "host-x", host: "10.0.0.10" }),
      makeRow({ id: "h-y", name: "host-y", host: "10.0.0.20" }),
    ];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "10.0.0.10": async () => {
            throw new Error("ssh dial timeout");
          },
          "10.0.0.20": async () => ({ code: 0, stdout: "92%", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    const payload = deps.enqueued[0].payload as Record<string, unknown>;
    assert.equal(payload.host_id, "h-y");
    assert.equal(payload.used_pct, 92);
  });

  test("self host is skipped", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-self", name: "self", host: "127.0.0.1" }),
      makeRow({ id: "h-r", name: "host-r", host: "5.5.5.5" }),
    ];
    let selfCalled = false;
    const handle = startComputeHostDiskMonitor(
      buildOpts(deps, async (target: SshTarget) => {
        if (target.host === "127.0.0.1") {
          selfCalled = true;
          return { code: 0, stdout: "99%", stderr: "" };
        }
        return { code: 0, stdout: "50%", stderr: "" };
      }),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(selfCalled, false, "self host must not be SSH-checked");
    assert.equal(deps.enqueued.length, 0);
  });

  test("non-ready host is skipped", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-d", name: "host-down", host: "9.9.9.9", status: "draining" }),
    ];
    let called = false;
    const handle = startComputeHostDiskMonitor(
      buildOpts(deps, async () => {
        called = true;
        return { code: 0, stdout: "99%", stderr: "" };
      }),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(called, false);
    assert.equal(deps.enqueued.length, 0);
  });

  test("custom thresholds via system_settings honored", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    deps.settings = {
      alerts_disk_high_warn_pct: 50,
      alerts_disk_high_critical_pct: 60,
    };
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "1.1.1.1": async () => ({ code: 0, stdout: "55%", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    assert.equal(deps.enqueued[0].severity, "warning");
  });

  test("dedupe_key includes host_id + severity + hour bucket", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "1.1.1.1": async () => ({ code: 0, stdout: "97%", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    const dedupe = deps.enqueued[0].dedupe_key as string;
    assert.match(dedupe, /^health\.compute_host_disk_high:h-1:critical:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  test("runOnce awaits enqueueAlert (deferred enqueue case)", async () => {
    // 回归测试:旧实现用 safeEnqueueAlert(fire-and-forget),runOnce() resolve
    // 时 INSERT 还没落 DB,SIGTERM / process.exit 会丢告警。改 awaited 后,
    // 即使 enqueue 异步延后 50ms,_runOnce() 也必须等到它完成。
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-a", name: "host-a", host: "1.1.1.1" }),
      makeRow({ id: "h-b", name: "host-b", host: "2.2.2.2" }),
    ];
    const slowEnqueue = async (event: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 50));
      deps.enqueued.push(event);
    };
    const opts = buildOpts(
      deps,
      fakeSsh({
        "1.1.1.1": async () => ({ code: 0, stdout: "97%", stderr: "" }),
        "2.2.2.2": async () => ({ code: 0, stdout: "98%", stderr: "" }),
      }),
    );
    (opts._deps as Record<string, unknown>).enqueueAlert = slowEnqueue;
    const handle = startComputeHostDiskMonitor(opts);

    await handle._runOnce();
    // 关键断言:_runOnce 返回时两个 enqueue 都已经完成,而不是只 fire 没 await
    assert.equal(deps.enqueued.length, 2, "runOnce should await all enqueue promises");
    await handle.stop();
  });

  test("enqueue throw is caught per host (no propagation)", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-a", name: "host-a", host: "1.1.1.1" }),
      makeRow({ id: "h-b", name: "host-b", host: "2.2.2.2" }),
    ];
    let warnCount = 0;
    const opts = buildOpts(
      deps,
      fakeSsh({
        "1.1.1.1": async () => ({ code: 0, stdout: "97%", stderr: "" }),
        "2.2.2.2": async () => ({ code: 0, stdout: "98%", stderr: "" }),
      }),
    );
    let calls = 0;
    (opts._deps as Record<string, unknown>).enqueueAlert = async (event: Record<string, unknown>) => {
      calls++;
      if (calls === 1) throw new Error("simulated FK race");
      deps.enqueued.push(event);
    };
    const fakeLogger: Record<string, unknown> = {
      warn: () => { warnCount++; },
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => fakeLogger,
    };
    (opts as Record<string, unknown>).logger = fakeLogger;
    const handle = startComputeHostDiskMonitor(opts);
    // 两 host 中一个 enqueue throw,另一个仍要进 enqueued —— 断 throw 被 catch
    await assert.doesNotReject(() => handle._runOnce());
    assert.equal(deps.enqueued.length, 1, "second host should still be enqueued");
    assert.ok(warnCount >= 1, "enqueue failure should be logged via warn");
    await handle.stop();
  });

  test("inFlight guard: parallel _runOnce shares same promise", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    let callCount = 0;
    const handle = startComputeHostDiskMonitor(
      buildOpts(deps, async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { code: 0, stdout: "50%", stderr: "" };
      }),
    );
    const p1 = handle._runOnce();
    const p2 = handle._runOnce();
    await Promise.all([p1, p2]);
    await handle.stop();

    assert.equal(callCount, 1, "inFlight guard should prevent re-entry");
  });
});

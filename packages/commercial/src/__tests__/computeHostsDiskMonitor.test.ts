/**
 * computeHostsDiskMonitor (0045 起 = metrics monitor) 单测。
 *
 * 覆盖:
 *   - parseDfOutput / parseMetricsOutput / decideSeverity 纯函数
 *   - DI sshRunFn / localExecFn 路径:
 *       - 1 高水位 → 1 enqueue + 1 update
 *       - 2 host 都低 → 0 enqueue 但仍 2 update
 *       - 1 host SSH throw → 不阻塞其他 host
 *       - self host 走 localExec 而非 SSH
 *   - parse 失败 → 跳过 update + alert(all-or-nothing)
 *   - inFlight guard:连发 _runOnce 不并发执行
 *
 * 不测:
 *   - 真 SSH(归 E2E,在 boheyun-1 上 stage 高水位文件验)
 *   - 真 DB:用 opts._deps 注入 fake listAllHosts / safeEnqueueAlert / query / updateMetrics / decryptSshPassword
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDfOutput,
  parseMetricsOutput,
  decideSeverity,
  startComputeHostDiskMonitor,
  startComputeHostMetricsMonitor,
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

describe("parseMetricsOutput", () => {
  test("normal 4-line output", () => {
    const r = parseMetricsOutput("83%\n42\n0.21\n4\n");
    assert.deepEqual(r, { diskPct: 83, memPct: 42, load1: 0.21, cpuCount: 4 });
  });
  test("CRLF tolerance", () => {
    const r = parseMetricsOutput("83%\r\n42\r\n0.21\r\n4\r\n");
    assert.deepEqual(r, { diskPct: 83, memPct: 42, load1: 0.21, cpuCount: 4 });
  });
  test("blank-line tolerance (free 容器空首行场景)", () => {
    const r = parseMetricsOutput("\n83%\n42\n0.21\n4\n");
    assert.deepEqual(r, { diskPct: 83, memPct: 42, load1: 0.21, cpuCount: 4 });
  });
  test("load1 rounded to 2 decimals", () => {
    const r = parseMetricsOutput("50%\n30\n1.23456\n8\n");
    assert.equal(r?.load1, 1.23);
  });
  test("memPct=100 ok (free 整数舍入边界)", () => {
    const r = parseMetricsOutput("90%\n100\n0.5\n2\n");
    assert.equal(r?.memPct, 100);
  });
  test("rejects too few lines (all-or-nothing)", () => {
    assert.equal(parseMetricsOutput("83%\n42\n0.21"), null);
    assert.equal(parseMetricsOutput(""), null);
  });
  test("rejects bad disk row (no %)", () => {
    assert.equal(parseMetricsOutput("83\n42\n0.21\n4"), null);
  });
  test("rejects bad memPct (>100)", () => {
    assert.equal(parseMetricsOutput("83%\n101\n0.21\n4"), null);
  });
  test("rejects bad load1 (NaN / negative)", () => {
    assert.equal(parseMetricsOutput("83%\n42\nabc\n4"), null);
    assert.equal(parseMetricsOutput("83%\n42\n-0.5\n4"), null);
  });
  test("rejects bad cpu_count (zero / non-integer)", () => {
    assert.equal(parseMetricsOutput("83%\n42\n0.21\n0"), null);
    assert.equal(parseMetricsOutput("83%\n42\n0.21\n2.5"), null);
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

describe("startComputeHostMetricsMonitor alias", () => {
  test("is the same function as startComputeHostDiskMonitor", () => {
    assert.equal(startComputeHostMetricsMonitor, startComputeHostDiskMonitor);
  });
});

// ──────────────────────────────────────────────────────────────
// 集成 fake:DI 注入,验 enqueue + update 副作用
// ──────────────────────────────────────────────────────────────

interface TestDeps {
  enqueued: Array<Record<string, unknown>>;
  updated: Array<{ hostId: string; sample: Record<string, unknown> }>;
  hosts: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
}

function makeDeps(): TestDeps {
  return { enqueued: [], updated: [], hosts: [], settings: {} };
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

/** 给 disk_pct=N 生成 4 行命令 stdout。 */
function fourLine(diskPct: number, memPct = 30, load1 = "0.10", cpuCount = 2): string {
  return `${diskPct}%\n${memPct}\n${load1}\n${cpuCount}\n`;
}

function buildOpts(
  deps: TestDeps,
  sshRunFn: (target: SshTarget) => Promise<SshExecResult>,
  localExecFn?: (cmd: string, t: number) => Promise<{ stdout: string }>,
) {
  return {
    sshRunFn: sshRunFn as never,
    localExecFn: (localExecFn ?? (async () => {
      throw new Error("localExec not configured for this test");
    })) as never,
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
      updateMetrics: (async (hostId: string, sample: Record<string, unknown>) => {
        deps.updated.push({ hostId, sample });
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
  test("high host fires 1 enqueue with severity=warning + 1 update", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "1.1.1.1": async () => ({ code: 0, stdout: fourLine(87), stderr: "" }),
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

    assert.equal(deps.updated.length, 1);
    assert.equal(deps.updated[0].hostId, "h-1");
    assert.equal((deps.updated[0].sample as Record<string, unknown>).diskPct, 87);
  });

  test("critical at 96% with default thresholds", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-2", name: "host-2", host: "2.2.2.2" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "2.2.2.2": async () => ({ code: 0, stdout: fourLine(96), stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    assert.equal(deps.enqueued[0].severity, "critical");
    assert.equal(deps.updated.length, 1);
  });

  test("both hosts low → 0 enqueue but 2 update", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-a", name: "host-a", host: "10.0.0.1" }),
      makeRow({ id: "h-b", name: "host-b", host: "10.0.0.2" }),
    ];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          "10.0.0.1": async () => ({ code: 0, stdout: fourLine(55), stderr: "" }),
          "10.0.0.2": async () => ({ code: 0, stdout: fourLine(60), stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 0);
    assert.equal(deps.updated.length, 2);
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
          "10.0.0.20": async () => ({ code: 0, stdout: fourLine(92), stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1);
    assert.equal((deps.enqueued[0].payload as Record<string, unknown>).host_id, "h-y");
    assert.equal(deps.updated.length, 1, "throwing host should not be updated");
    assert.equal(deps.updated[0].hostId, "h-y");
  });

  test("self host uses localExec, not SSH (0045 起 self 纳入)", async () => {
    const deps = makeDeps();
    deps.hosts = [
      makeRow({ id: "h-self", name: "self", host: "127.0.0.1" }),
      makeRow({ id: "h-r", name: "host-r", host: "5.5.5.5" }),
    ];
    let sshCalledForSelf = false;
    let localCalled = false;
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        async (target: SshTarget) => {
          if (target.host === "127.0.0.1") sshCalledForSelf = true;
          return { code: 0, stdout: fourLine(50), stderr: "" };
        },
        async () => {
          localCalled = true;
          return { stdout: fourLine(33, 50, "0.5", 8) };
        },
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(sshCalledForSelf, false, "self must not be SSH-checked");
    assert.equal(localCalled, true, "self must go through localExec");
    // self update + remote update = 2
    assert.equal(deps.updated.length, 2);
    const selfUpd = deps.updated.find((u) => u.hostId === "h-self");
    assert.ok(selfUpd, "self should be updated");
    assert.equal((selfUpd!.sample as Record<string, unknown>).diskPct, 33);
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
        return { code: 0, stdout: fourLine(99), stderr: "" };
      }),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(called, false);
    assert.equal(deps.enqueued.length, 0);
    assert.equal(deps.updated.length, 0);
  });

  test("parse failure → no update no alert (all-or-nothing)", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    const handle = startComputeHostDiskMonitor(
      buildOpts(
        deps,
        fakeSsh({
          // 缺第 4 行 (nproc),解析失败
          "1.1.1.1": async () => ({ code: 0, stdout: "97%\n55\n1.2\n", stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 0, "parse fail should suppress alert");
    assert.equal(deps.updated.length, 0, "parse fail should suppress update");
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
          "1.1.1.1": async () => ({ code: 0, stdout: fourLine(55), stderr: "" }),
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
          "1.1.1.1": async () => ({ code: 0, stdout: fourLine(97), stderr: "" }),
        }),
      ),
    );
    await handle._runOnce();
    await handle.stop();

    const dedupe = deps.enqueued[0].dedupe_key as string;
    assert.match(dedupe, /^health\.compute_host_disk_high:h-1:critical:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  test("update throw is caught (alert still fires)", async () => {
    // 回归:UPDATE compute_hosts 失败不能阻断告警链路。
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    const opts = buildOpts(
      deps,
      fakeSsh({
        "1.1.1.1": async () => ({ code: 0, stdout: fourLine(97), stderr: "" }),
      }),
    );
    (opts._deps as Record<string, unknown>).updateMetrics = async () => {
      throw new Error("DB transient failure");
    };
    const handle = startComputeHostDiskMonitor(opts);
    await handle._runOnce();
    await handle.stop();

    assert.equal(deps.enqueued.length, 1, "alert must fire even if update DB fails");
  });

  test("inFlight guard: parallel _runOnce shares same promise", async () => {
    const deps = makeDeps();
    deps.hosts = [makeRow({ id: "h-1", name: "host-1", host: "1.1.1.1" })];
    let callCount = 0;
    const handle = startComputeHostDiskMonitor(
      buildOpts(deps, async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { code: 0, stdout: fourLine(50), stderr: "" };
      }),
    );
    const p1 = handle._runOnce();
    const p2 = handle._runOnce();
    await Promise.all([p1, p2]);
    await handle.stop();

    assert.equal(callCount, 1, "inFlight guard should prevent re-entry");
  });
});

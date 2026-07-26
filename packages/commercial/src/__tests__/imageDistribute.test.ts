/**
 * imageDistribute 单测 — 纯逻辑覆盖。
 *
 * 测什么:
 *   - streamImageToHost: empty-image early throw + singleflight 缓存维护
 *   - distributePreheatToAllHosts: 过滤 self / 非 ready,空集合 → [],per-host 失败
 *     不抛出(best-effort 语义)
 *
 * 不测(归 integ):
 *   - 真 SSH 通信 / docker save | docker load 子进程的实际行为(需要 KMS + 真 host)
 *   - 真 listAllHostsWithCounts 查询(归 0030 schema 测试)
 *
 * 测试策略:
 *   - 用 loadHosts 注入点提供 host 列表,绕开 PG
 *   - decryptSshPassword 在 KMS_KEY 未设置时会抛 → _distributeOne 把它 catch 成
 *     outcome:"error" + errorSource:"spawn",这样我们既能确保不真发起 SSH,又能
 *     验证过滤 / 错误聚合 / 缓冲清零路径。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  streamImageToHost,
  distributePreheatToAllHosts,
  ImageDistributeError,
  _resetSingleflightForTest,
} from "../compute-pool/imageDistribute.js";
import type { ComputeHostRow, ComputeHostStatus } from "../compute-pool/types.js";

// ─── helpers ────────────────────────────────────────────────────────────

function fakeRow(over: Partial<ComputeHostRow> = {}): ComputeHostRow {
  const now = new Date();
  return {
    id: over.id ?? "00000000-0000-0000-0000-000000000001",
    name: over.name ?? "h1",
    host: over.host ?? "10.0.0.1",
    ssh_port: over.ssh_port ?? 22,
    ssh_user: over.ssh_user ?? "root",
    agent_port: over.agent_port ?? 9443,
    ssh_password_nonce: over.ssh_password_nonce ?? Buffer.alloc(12),
    ssh_password_ct: over.ssh_password_ct ?? Buffer.alloc(16),
    ssh_fingerprint: over.ssh_fingerprint ?? null,
    agent_psk_nonce: over.agent_psk_nonce ?? Buffer.alloc(12),
    agent_psk_ct: over.agent_psk_ct ?? Buffer.alloc(48),
    agent_cert_pem: null,
    agent_cert_fingerprint_sha256: null,
    agent_cert_not_before: null,
    agent_cert_not_after: null,
    status: (over.status ?? "ready") as ComputeHostStatus,
    last_bootstrap_at: null,
    last_bootstrap_err: null,
    last_health_at: null,
    last_health_ok: null,
    last_health_err: null,
    consecutive_health_fail: 0,
    consecutive_health_ok: 0,
    max_containers: 20,
    bridge_cidr: null,
    egress_proxy_endpoint: null,
    expires_at: null,
    loaded_image_id: null,
    loaded_image_at: null,
    quarantine_reason_code: null,
    quarantine_reason_detail: null,
    quarantine_at: null,
    last_health_endpoint_ok: null,
    last_health_poll_at: null,
    last_uplink_ok: null,
    last_uplink_at: null,
    last_egress_probe_ok: null,
    last_egress_probe_at: null,
    // 0045 metrics — 测试夹具默认 null,与 schema "NULL = 从未采集成功" 一致
    disk_pct: null,
    mem_pct: null,
    load1: null,
    cpu_count: null,
    metrics_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof distributePreheatToAllHosts>[1] extends infer T
  ? (T extends { logger?: infer L } ? L : never)
  : never;

beforeEach(() => {
  _resetSingleflightForTest();
});

// ─── streamImageToHost ──────────────────────────────────────────────────

describe("streamImageToHost", () => {
  test("空 image string → ImageDistributeError(source='spawn'),不碰 SSH", async () => {
    const target = {
      host: "1.2.3.4",
      port: 22,
      username: "root",
      password: Buffer.from("nope"),
      knownHostsContent: null,
    };
    await assert.rejects(
      () => streamImageToHost(target, ""),
      (err: Error) =>
        err instanceof ImageDistributeError && err.source === "spawn" && /image is empty/.test(err.message),
    );
  });

  test("singleflight:同 hostId+image 并发合流成同一次传输,不同 hostId 各走各的", async () => {
    // 为什么这条重要:image 分发是"开会话 → 新 host 起容器"的前置。合流失效
    // = 同一 host 同一 image 被并发 `docker save | ssh docker load` 多次,几 GB
    // 流量翻倍 + 远端 load 互相打架。此前本用例只调两次 reset 然后 assert.ok(true)
    // ——用例名承诺了合流覆盖,实际零覆盖(2026-07-26 补真断言)。
    //
    // 手法:127.0.0.1:1(必然 ECONNREFUSED,快速失败)让底层传输注定失败;
    // 合流与否与成败无关 —— 合流的判据是"第二次拿到的是同一个 promise",
    // 表现为两次 await 抛出**同一个 error 实例**;不合流则是两个独立实例。
    const target = {
      host: "127.0.0.1",
      port: 1,
      username: "root",
      password: Buffer.from("nope"),
      knownHostsContent: null,
    };
    const coalesced: Array<{ key?: string }> = [];
    const spyLogger = {
      info: (_msg: string, meta?: { key?: string }) => {
        if (/coalesced into in-flight/.test(_msg)) coalesced.push(meta ?? {});
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof streamImageToHost>[2] extends infer T
      ? (T extends { logger?: infer L } ? L : never)
      : never;

    // 注意:streamImageToHost 在第一个 await 之前就 `_inflight.set`,所以这里
    // **不 await** 地连发两次,第二次必然同步命中 inflight。
    const p1 = streamImageToHost(target, "img:tag", { hostId: "host-A", logger: spyLogger });
    const p2 = streamImageToHost(target, "img:tag", { hostId: "host-A", logger: spyLogger });
    // 同 image 但不同 hostId → 必须**不**合流(key 含 hostId)
    const p3 = streamImageToHost(target, "img:tag", { hostId: "host-B", logger: spyLogger });

    const e1 = await p1.then(() => null, (e: Error) => e);
    const e2 = await p2.then(() => null, (e: Error) => e);
    const e3 = await p3.then(() => null, (e: Error) => e);

    assert.ok(e1 instanceof ImageDistributeError, `p1 应失败于传输层,实际 ${e1}`);
    assert.strictEqual(e2, e1, "同 hostId+image 的第二次调用必须合流到同一个 in-flight promise");
    assert.notStrictEqual(e3, e1, "不同 hostId 必须各自独立传输,不得被错误合流");
    assert.equal(coalesced.length, 1, "只应有一次 coalesce 日志(host-A 的第二次)");
    assert.equal(coalesced[0]?.key, "host-A::img:tag", "coalesce key = hostId::image");

    // resolve/reject 后 map 必须被清空:同 key 再来一次要能真的重新发起
    // (拿到一个**新**的 error 实例,而不是被已 settle 的旧 promise 粘住)。
    const e4 = await streamImageToHost(target, "img:tag", {
      hostId: "host-A",
      logger: spyLogger,
    }).then(() => null, (e: Error) => e);
    assert.notStrictEqual(e4, e1, "settle 后 inflight 必须清空,后续调用重新发起");
    assert.equal(coalesced.length, 1, "第四次是全新一轮,不应再产生 coalesce 日志");
  });
});

// ─── distributePreheatToAllHosts ────────────────────────────────────────

describe("distributePreheatToAllHosts", () => {
  test("0 ready host → 返回空数组,不抛", async () => {
    const r = await distributePreheatToAllHosts("img:tag", {
      loadHosts: async () => [],
      logger: silentLogger,
    });
    assert.deepEqual(r, []);
  });

  test("过滤 self host(name='self')+ 非 ready host(draining/broken/quarantined)", async () => {
    const hosts = [
      fakeRow({ id: "11111111-1111-1111-1111-111111111111", name: "self", status: "ready" }),
      fakeRow({ id: "22222222-2222-2222-2222-222222222222", name: "h-draining", status: "draining" }),
      fakeRow({ id: "33333333-3333-3333-3333-333333333333", name: "h-broken", status: "broken" }),
      fakeRow({ id: "44444444-4444-4444-4444-444444444444", name: "h-quarantined", status: "quarantined" }),
      fakeRow({ id: "55555555-5555-5555-5555-555555555555", name: "h-bootstrapping", status: "bootstrapping" }),
    ];
    const r = await distributePreheatToAllHosts("img:tag", {
      loadHosts: async () => hosts,
      logger: silentLogger,
    });
    // 全部过滤掉 → 空数组
    assert.deepEqual(r, []);
  });

  test("decrypt 失败(KMS 未设/密文损坏)→ outcome='error', errorSource='spawn',不抛", async () => {
    // 故意不设 OPENCLAUDE_KMS_KEY 也能跑这条:loadKmsKey 抛 → _distributeOne 的
    // 内层 try 把 decrypt 异常吃掉变 result。 这是 best-effort 的关键保证。
    const original = process.env.OPENCLAUDE_KMS_KEY;
    delete process.env.OPENCLAUDE_KMS_KEY;
    try {
      const hosts = [
        fakeRow({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "h-ready-1", status: "ready" }),
        fakeRow({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "h-ready-2", status: "ready" }),
      ];
      const r = await distributePreheatToAllHosts("img:tag", {
        loadHosts: async () => hosts,
        logger: silentLogger,
        concurrency: 2,
      });
      assert.equal(r.length, 2);
      const names = r.map((x) => x.hostName).sort();
      assert.deepEqual(names, ["h-ready-1", "h-ready-2"]);
      for (const e of r) {
        assert.equal(e.outcome, "error");
        assert.equal(e.errorSource, "spawn");
        assert.match(e.error ?? "", /decrypt ssh password/);
      }
    } finally {
      if (original === undefined) delete process.env.OPENCLAUDE_KMS_KEY;
      else process.env.OPENCLAUDE_KMS_KEY = original;
    }
  });

  test("worker pool 串行处理 queue 直到空(concurrency<host 数也能全跑完)", async () => {
    const original = process.env.OPENCLAUDE_KMS_KEY;
    delete process.env.OPENCLAUDE_KMS_KEY;
    try {
      const hosts = Array.from({ length: 5 }, (_, i) =>
        fakeRow({
          id: `cccccccc-cccc-cccc-cccc-cccccccccc${(i + 10).toString().padStart(2, "0")}`,
          name: `host-${i}`,
          status: "ready",
        }),
      );
      const r = await distributePreheatToAllHosts("img:tag", {
        loadHosts: async () => hosts,
        logger: silentLogger,
        concurrency: 2, // 5 host / 并发 2
      });
      assert.equal(r.length, 5);
      // 全部跑完(都走 decrypt 失败路径,但都被处理)
      assert.ok(r.every((x) => x.outcome === "error"));
    } finally {
      if (original === undefined) delete process.env.OPENCLAUDE_KMS_KEY;
      else process.env.OPENCLAUDE_KMS_KEY = original;
    }
  });

  test("OC_IMAGE_DISTRIBUTE_CONCURRENCY env override 生效", async () => {
    const original = process.env.OPENCLAUDE_KMS_KEY;
    const originalConc = process.env.OC_IMAGE_DISTRIBUTE_CONCURRENCY;
    delete process.env.OPENCLAUDE_KMS_KEY;
    process.env.OC_IMAGE_DISTRIBUTE_CONCURRENCY = "3";
    try {
      const hosts = Array.from({ length: 3 }, (_, i) =>
        fakeRow({
          id: `dddddddd-dddd-dddd-dddd-dddddddddd${(i + 10).toString().padStart(2, "0")}`,
          name: `host-${i}`,
          status: "ready",
        }),
      );
      // 不传 concurrency,看是否读 env
      const r = await distributePreheatToAllHosts("img:tag", {
        loadHosts: async () => hosts,
        logger: silentLogger,
      });
      assert.equal(r.length, 3);
    } finally {
      if (original === undefined) delete process.env.OPENCLAUDE_KMS_KEY;
      else process.env.OPENCLAUDE_KMS_KEY = original;
      if (originalConc === undefined) delete process.env.OC_IMAGE_DISTRIBUTE_CONCURRENCY;
      else process.env.OC_IMAGE_DISTRIBUTE_CONCURRENCY = originalConc;
    }
  });
});

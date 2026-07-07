/**
 * Unit tests for master 侧 cronWake:due tick(冷却/上限/active 跳过)+ 派生索引读写 SQL +
 * computeMinNextFire(cron 解析复用 gateway cronMatches,不写第二套)。
 * Run: npx tsx --test packages/commercial/src/__tests__/cronWake.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeMinNextFire,
  cronYamlPathForUser,
  findDueCronWakeUsers,
  listV5UserIds,
  startCronWakeScheduler,
  upsertCronWakeIndex,
  type CronWakeRunner,
  type DueCronWakeUser,
} from "../agent-sandbox/cronWake.js";

// ─── fake PG runner ──────────────────────────────────────────────────

function makeRunner(
  handler: (sql: string, params?: readonly unknown[]) => { rows: any[]; rowCount: number | null },
): CronWakeRunner & { calls: Array<{ sql: string; params?: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      return handler(sql, params) as any;
    },
  };
}

// ─── due tick 逻辑 ───────────────────────────────────────────────────

describe("cronWake due tick", () => {
  function baseDeps(overrides: Record<string, unknown> = {}) {
    const woken: string[] = [];
    const activeUids = new Set<string>();
    let clock = 1_000_000;
    let due: DueCronWakeUser[] = [];
    const deps = {
      findDueUsers: async () => due,
      isContainerActive: async (uid: bigint) => activeUids.has(uid.toString()),
      wakeContainer: async (uid: bigint) => {
        woken.push(uid.toString());
      },
      runRescan: async () => ({ scanned: 0, upserted: 0, errors: 0 }),
      now: () => clock,
      runRescanOnStart: false,
      cooldownMs: 10_000,
      maxPerTick: 2,
      ...overrides,
    };
    return {
      deps,
      woken,
      activeUids,
      setDue: (u: DueCronWakeUser[]) => {
        due = u;
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const U = (id: number): DueCronWakeUser => ({ userId: BigInt(id), nextFireAt: new Date() });

  test("wakes up to maxPerTick, skips the rest", async () => {
    const h = baseDeps();
    h.setDue([U(1), U(2), U(3)]);
    const sched = startCronWakeScheduler(h.deps as any);
    try {
      const r = await sched.runNow();
      assert.equal(r.due, 3);
      assert.equal(r.woken, 2);
      assert.deepEqual(h.woken, ["1", "2"]);
    } finally {
      sched.stop();
    }
  });

  test("active containers are skipped (no wake needed)", async () => {
    const h = baseDeps();
    h.activeUids.add("1");
    h.setDue([U(1), U(2)]);
    const sched = startCronWakeScheduler(h.deps as any);
    try {
      const r = await sched.runNow();
      assert.equal(r.skippedActive, 1);
      assert.equal(r.woken, 1);
      assert.deepEqual(h.woken, ["2"]);
    } finally {
      sched.stop();
    }
  });

  test("per-uid cooldown suppresses re-wake until window elapses", async () => {
    const h = baseDeps();
    h.setDue([U(1)]);
    const sched = startCronWakeScheduler(h.deps as any);
    try {
      let r = await sched.runNow();
      assert.equal(r.woken, 1);

      // 冷却窗内再 tick → 跳过。
      h.advance(5_000);
      r = await sched.runNow();
      assert.equal(r.woken, 0);
      assert.equal(r.skippedCooldown, 1);

      // 超过冷却窗 → 再次唤醒。
      h.advance(6_000);
      r = await sched.runNow();
      assert.equal(r.woken, 1);
      assert.deepEqual(h.woken, ["1", "1"]);
    } finally {
      sched.stop();
    }
  });

  test("isContainerActive error → skip this tick (no mass wake, no crash)", async () => {
    const h = baseDeps({
      isContainerActive: async () => {
        throw new Error("db blip");
      },
    });
    h.setDue([U(1), U(2)]);
    const sched = startCronWakeScheduler(h.deps as any);
    try {
      const r = await sched.runNow();
      assert.equal(r.woken, 0);
    } finally {
      sched.stop();
    }
  });
});

// ─── computeMinNextFire(cron 解析)────────────────────────────────────

describe("computeMinNextFire", () => {
  const FROM = new Date("2026-07-07T10:30:20.000Z");

  test("every-minute job → next minute boundary (TZ-independent)", () => {
    const yaml = "jobs:\n  - id: a\n    schedule: '* * * * *'\n    agent: main\n    enabled: true\n";
    const r = computeMinNextFire(yaml, FROM);
    assert.equal(r.jobsEnabled, 1);
    assert.equal(r.nextFireAt?.toISOString(), "2026-07-07T10:31:00.000Z");
  });

  test("min over multiple enabled jobs; disabled excluded", () => {
    const yaml =
      "jobs:\n" +
      "  - id: a\n    schedule: '* * * * *'\n    agent: main\n    enabled: true\n" +
      "  - id: b\n    schedule: '*/5 * * * *'\n    agent: main\n    enabled: true\n" +
      "  - id: c\n    schedule: '* * * * *'\n    agent: main\n    enabled: false\n";
    const r = computeMinNextFire(yaml, FROM);
    assert.equal(r.jobsEnabled, 2); // c 被排除
    // 每分钟的 job 更早 → min = next minute
    assert.equal(r.nextFireAt?.toISOString(), "2026-07-07T10:31:00.000Z");
  });

  test("no jobs / empty → null, 0", () => {
    assert.deepEqual(computeMinNextFire("jobs: []\n", FROM), { nextFireAt: null, jobsEnabled: 0 });
    assert.deepEqual(computeMinNextFire("", FROM), { nextFireAt: null, jobsEnabled: 0 });
  });

  test("wall-clock schedule interpreted as Asia/Shanghai regardless of process TZ", () => {
    // "每天 9 点"(北京)= 01:00 UTC。FROM=10:30:20Z(北京 18:30)→ 下一次 = 次日 01:00Z。
    // 锁定 shanghaiWallView 语义:master 现网跑 UTC,rescan 复算必须与容器(TZ=沪)一致。
    const yaml = "jobs:\n  - id: d\n    schedule: '0 9 * * *'\n    agent: main\n    enabled: true\n";
    const r = computeMinNextFire(yaml, FROM);
    assert.equal(r.nextFireAt?.toISOString(), "2026-07-08T01:00:00.000Z");
  });

  test("system seed jobs (v3 migrated volumes) excluded from wake index", () => {
    // 系统自省 seed 不参与唤醒(不烧离线用户积分);用户任务照常计入。
    const seeds =
      "jobs:\n" +
      "  - id: daily-reflection\n    schedule: '17 3 * * *'\n    agent: main\n    enabled: true\n" +
      "  - id: heartbeat\n    schedule: '13 */4 * * *'\n    agent: main\n    enabled: true\n    heartbeat: true\n" +
      "  - id: skill-check\n    schedule: '47 */6 * * *'\n    agent: main\n    enabled: true\n" +
      "  - id: weekly-curation\n    schedule: '31 4 * * 0'\n    agent: main\n    enabled: true\n";
    assert.deepEqual(computeMinNextFire(seeds, FROM), { nextFireAt: null, jobsEnabled: 0 });
    const withUser =
      seeds + "  - id: remind-abc-def\n    schedule: '* * * * *'\n    agent: main\n    enabled: true\n";
    const r = computeMinNextFire(withUser, FROM);
    assert.equal(r.jobsEnabled, 1); // 只计用户任务
    assert.equal(r.nextFireAt?.toISOString(), "2026-07-07T10:31:00.000Z");
  });

  test("invalid schedule counted enabled but never fires → nextFireAt null", () => {
    const yaml = "jobs:\n  - id: a\n    schedule: '99 99 * * *'\n    agent: main\n    enabled: true\n";
    const r = computeMinNextFire(yaml, FROM);
    assert.equal(r.jobsEnabled, 1);
    assert.equal(r.nextFireAt, null);
  });

  test("malformed yaml → treated as no tasks", () => {
    const r = computeMinNextFire("::: not yaml : [", FROM);
    assert.equal(r.jobsEnabled, 0);
    assert.equal(r.nextFireAt, null);
  });
});

// ─── 派生索引读写 SQL ────────────────────────────────────────────────

describe("cron_wake_index queries", () => {
  test("upsertCronWakeIndex issues INSERT ... ON CONFLICT with ISO/int params", async () => {
    const runner = makeRunner(() => ({ rows: [], rowCount: 0 }));
    const when = new Date("2026-07-07T12:00:00.000Z");
    await upsertCronWakeIndex(runner, {
      userId: 42n,
      runtimeChannel: "v5",
      nextFireAt: when,
      jobsEnabled: 3,
    });
    assert.equal(runner.calls.length, 1);
    assert.match(runner.calls[0].sql, /INSERT INTO cron_wake_index/);
    assert.match(runner.calls[0].sql, /ON CONFLICT \(user_id, runtime_channel\)/);
    assert.deepEqual(runner.calls[0].params, ["42", "v5", "2026-07-07T12:00:00.000Z", 3]);
  });

  test("upsert with null nextFireAt / negative jobsEnabled clamps", async () => {
    const runner = makeRunner(() => ({ rows: [], rowCount: 0 }));
    await upsertCronWakeIndex(runner, {
      userId: 7,
      runtimeChannel: "v5",
      nextFireAt: null,
      jobsEnabled: -5,
    });
    assert.deepEqual(runner.calls[0].params, ["7", "v5", null, 0]);
  });

  test("findDueCronWakeUsers maps rows → {bigint, Date} and passes channel/horizon/limit", async () => {
    const d = new Date("2026-07-07T09:00:00.000Z");
    const runner = makeRunner(() => ({
      rows: [
        { user_id: "10", next_fire_at: d },
        { user_id: "9007199254740993", next_fire_at: d },
      ],
      rowCount: 2,
    }));
    const due = await findDueCronWakeUsers(runner, {
      runtimeChannel: "v5",
      horizonSec: 90,
      scanLimit: 50,
    });
    assert.equal(runner.calls[0].params?.[0], "v5");
    assert.equal(runner.calls[0].params?.[1], 90);
    assert.equal(runner.calls[0].params?.[2], 50);
    assert.equal(due[0].userId, 10n);
    // bigint 保真:超过 Number.MAX_SAFE_INTEGER 的 uid 不丢精度
    assert.equal(due[1].userId, 9007199254740993n);
    assert.equal(due[0].nextFireAt.getTime(), d.getTime());
  });

  test("listV5UserIds filters v5_migrated_at IS NOT NULL + active, maps bigint", async () => {
    const runner = makeRunner((sql) => {
      assert.match(sql, /v5_migrated_at IS NOT NULL/);
      assert.match(sql, /status = 'active'/);
      return { rows: [{ id: "1" }, { id: "2" }], rowCount: 2 };
    });
    const ids = await listV5UserIds(runner);
    assert.deepEqual(ids, [1n, 2n]);
  });
});

// ─── 卷路径 ──────────────────────────────────────────────────────────

describe("cronYamlPathForUser", () => {
  test("channel-scoped self-host volume path", () => {
    assert.equal(
      cronYamlPathForUser(42, "v5"),
      "/var/lib/docker/volumes/oc-v5-data-u42/_data/cron.yaml",
    );
    assert.equal(
      cronYamlPathForUser(7n, "v3", "/base"),
      "/base/oc-v3-data-u7/_data/cron.yaml",
    );
  });
});

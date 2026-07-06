/**
 * provider 健康度判定 scheduler 状态机单测(0108)。
 * 覆盖:auto 降级(写 provider_ops + 告警)/ forced 模式跳过(不写不告警)/ auto 恢复 /
 *      写命中 0 行(forced race)不告警。全注入 DI,不依赖 PG。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QueryResult } from "pg";
import { startProviderHealthScheduler } from "./providerHealthScheduler.js";
import { EVENTS } from "./alertEvents.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLog; } } as never;
const NOW = 2_000_000_000_000;

type SampleRow = { ok: boolean; kind: string; at: Date };
type OpsRow = { health_status: string | null; health_mode: string };

interface Harness {
  opsRows: OpsRow[];
  samples: SampleRow[];
  latency: { ok: boolean }[];
  /** provider_ops 写(INSERT/UPDATE)返回的 rowCount。 */
  writeRowCount: number;
  writes: Array<{ sql: string; params: unknown[] }>;
  enqueued: Array<{ event_type: string; severity: string }>;
  /** 种子 firing 状态(恢复场景须先处于 firing=true 才有 true→false 转移)。 */
  initialFiring?: boolean;
}

function makeDeps(h: Harness) {
  const firing = new Map<string, boolean>();
  if (h.initialFiring) firing.set("provider_health:deepseek", true);
  const query = (async (sql: string, params: unknown[] = []) => {
    const s = sql.trim();
    if (s.startsWith("INSERT INTO provider_ops") || s.startsWith("UPDATE provider_ops")) {
      h.writes.push({ sql: s, params });
      return { rows: [], rowCount: h.writeRowCount } as unknown as QueryResult;
    }
    if (s.includes("FROM provider_ops")) return { rows: h.opsRows, rowCount: h.opsRows.length } as unknown as QueryResult;
    if (s.includes("FROM provider_health_samples")) return { rows: h.samples, rowCount: h.samples.length } as unknown as QueryResult;
    if (s.includes("FROM provider_latency_samples")) return { rows: h.latency, rowCount: h.latency.length } as unknown as QueryResult;
    if (s.startsWith("DELETE")) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  }) as never;
  const enqueueAlert = (async (ev: { event_type: string; severity: string }) => {
    h.enqueued.push({ event_type: ev.event_type, severity: ev.severity });
    return { enqueued: true } as never;
  }) as never;
  const transitionRuleState = (async (rule_id: string, f: boolean) => {
    const prev = firing.get(rule_id) ?? false;
    firing.set(rule_id, f);
    return { transitioned: prev !== f, previous: prev };
  }) as never;
  return {
    query,
    enqueueAlert,
    transitionRuleState,
    now: () => NOW,
    logger: silentLog,
    providerIds: ["deepseek"],
  };
}

async function runOneTick(h: Harness): Promise<void> {
  const handle = startProviderHealthScheduler({ intervalMs: 3_600_000, _deps: makeDeps(h) });
  await handle.runNow();
  handle.stop();
}

function failSamples(n: number, kind = "upstream_5xx"): SampleRow[] {
  return Array.from({ length: n }, (_, i) => ({ ok: false, kind, at: new Date(NOW - i * 1000) }));
}
function okSamples(n: number): SampleRow[] {
  return Array.from({ length: n }, (_, i) => ({ ok: true, kind: "final", at: new Date(NOW - i * 1000) }));
}

describe("providerHealthScheduler — auto 降级", () => {
  test("失败率达阈值 → 写 provider_ops degraded + 告警 PROVIDER_DEGRADED", async () => {
    const h: Harness = {
      opsRows: [], // 无行 → currentStatus null(视作 healthy)
      samples: failSamples(10),
      latency: [],
      writeRowCount: 1,
      writes: [],
      enqueued: [],
    };
    await runOneTick(h);
    const degWrite = h.writes.find((w) => w.sql.includes("'degraded'"));
    assert.ok(degWrite, "应写 provider_ops degraded");
    assert.equal(h.enqueued.filter((e) => e.event_type === EVENTS.PROVIDER_DEGRADED).length, 1);
    assert.equal(h.enqueued[0]?.severity, "critical");
  });
});

describe("providerHealthScheduler — forced 模式优先", () => {
  test("health_mode=forced_degraded → 不评估、不写、不告警", async () => {
    const h: Harness = {
      opsRows: [{ health_status: "healthy", health_mode: "forced_degraded" }],
      samples: failSamples(10),
      latency: [],
      writeRowCount: 1,
      writes: [],
      enqueued: [],
    };
    await runOneTick(h);
    assert.equal(h.writes.length, 0);
    assert.equal(h.enqueued.length, 0);
  });

  test("health_mode=forced_healthy → 即便全失败也不自动降级", async () => {
    const h: Harness = {
      opsRows: [{ health_status: "degraded", health_mode: "forced_healthy" }],
      samples: failSamples(10),
      latency: [],
      writeRowCount: 1,
      writes: [],
      enqueued: [],
    };
    await runOneTick(h);
    assert.equal(h.writes.length, 0);
    assert.equal(h.enqueued.length, 0);
  });
});

describe("providerHealthScheduler — auto 恢复", () => {
  test("已 degraded 且恢复窗成功 → 写 healthy + 告警 PROVIDER_RECOVERED", async () => {
    const h: Harness = {
      opsRows: [{ health_status: "degraded", health_mode: "auto" }],
      samples: okSamples(10),
      latency: [],
      writeRowCount: 1,
      writes: [],
      enqueued: [],
      initialFiring: true, // 之前已因降级 firing,恢复才有 true→false 转移
    };
    await runOneTick(h);
    const healWrite = h.writes.find((w) => w.sql.includes("'healthy'"));
    assert.ok(healWrite, "应写 provider_ops healthy");
    assert.equal(h.enqueued.filter((e) => e.event_type === EVENTS.PROVIDER_RECOVERED).length, 1);
    assert.equal(h.enqueued[0]?.severity, "info");
  });
});

describe("providerHealthScheduler — 写命中 0 行(forced race)", () => {
  test("降级写 rowCount=0(被强制模式抢先)→ 不告警", async () => {
    const h: Harness = {
      opsRows: [],
      samples: failSamples(10),
      latency: [],
      writeRowCount: 0, // ON CONFLICT WHERE health_mode='auto' 未命中
      writes: [],
      enqueued: [],
    };
    await runOneTick(h);
    assert.equal(h.enqueued.length, 0);
  });
});

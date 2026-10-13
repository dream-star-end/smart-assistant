/**
 * OCV5-397 慢退避行为。走 startRecoveryProber 的真实 timer / runOnStart / runNow,
 * 用 node:test 的假时钟推进时间,不发网络、不写 PG、不换 key、不充值。
 * 手动 runNow 不拿来冒充 24h 自动调度。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  startRecoveryProber,
  type RecoveryProbeRequest,
  type RecoveryProbeResult,
} from "./recoveryProber.js";
import type { StaticProviderKeys } from "@openclaude/protocol";

const MIN = 60_000;
const FIVE = 5 * MIN;
const FIFTEEN = 15 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MINIMAX_KEY = "sk-minimax-ocv5-397";
const ARK_KEY = "sk-ark-ocv5-397-key";
const ROTATED_KEY = "sk-minimax-rotated-397x";

type Deps = NonNullable<Parameters<typeof startRecoveryProber>[0]["_deps"]>;
type QueryFn = Deps["query"];

interface OpsRow {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
}

interface Call {
  t: number;
  id: string;
}

interface LogEvent {
  level: "info" | "warn";
  msg: string;
  extra?: Record<string, unknown>;
}

const state: { rows: OpsRow[]; keys: StaticProviderKeys } = {
  rows: [],
  keys: { minimax: MINIMAX_KEY, ark: ARK_KEY },
};
const calls: Call[] = [];
const recorded: Array<{ providerId: string; model: string }> = [];
const events: LogEvent[] = [];
const handles: Array<NonNullable<ReturnType<typeof startRecoveryProber>>> = [];
let unexpected = 0;

const log = {
  info: (msg: string, extra?: Record<string, unknown>) => {
    events.push({ level: "info", msg, extra });
  },
  warn: (msg: string, extra?: Record<string, unknown>) => {
    events.push({ level: "warn", msg, extra });
  },
};

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function degraded(providerId: string, healthMode = "auto", healthStatus = "degraded"): OpsRow {
  return { provider_id: providerId, health_status: healthStatus, health_mode: healthMode };
}

function result(
  statusCode: number | null,
  ok = false,
  error: RecoveryProbeResult["error"] = null,
  model = "probe-model",
): RecoveryProbeResult {
  return { ok, statusCode, error, model };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function advance(intervalMs: number, steps: number): Promise<number> {
  let ticks = 0;
  for (let i = 0; i < steps; i++) {
    mock.timers.tick(intervalMs);
    ticks += 1;
    await settle();
  }
  return ticks;
}

function start(probe: RecoveryProbeRequest) {
  const handle = startRecoveryProber({
    staticProviderKeys: state.keys,
    log,
    _deps: {
      query: (async () => ({ rows: state.rows })) as unknown as QueryFn,
      probeRequest: probe,
      recordSuccess: (providerId, model) => recorded.push({ providerId, model }),
    },
  });
  assert.ok(handle);
  handles.push(handle);
  return handle;
}

function track(specId: string): RecoveryProbeRequest {
  return async (spec) => {
    calls.push({ t: Date.now(), id: spec.id });
    assert.equal(spec.id, specId);
    return result(402);
  };
}

function sequence(specId: string, results: RecoveryProbeResult[]): RecoveryProbeRequest {
  return async (spec) => {
    calls.push({ t: Date.now(), id: spec.id });
    assert.equal(spec.id, specId);
    const next = results.shift();
    if (!next) {
      unexpected += 1;
      return result(599, false, "unexpected-extra-probe");
    }
    return next;
  }
}

function failureLogs(): LogEvent[] {
  return events.filter((event) => event.msg === "recovery_probe_failed");
}

function blob(): string {
  return JSON.stringify(events);
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval", "Date", "setTimeout"] });
  assert.equal(Date.now(), 0);
  state.rows = [degraded("minimax")];
  state.keys = { minimax: MINIMAX_KEY, ark: ARK_KEY };
  unexpected = 0;
});

afterEach(() => {
  for (const handle of handles) handle.stop();
  handles.length = 0;
  mock.timers.reset();
  calls.length = 0;
  recorded.length = 0;
  events.length = 0;
  Reflect.deleteProperty(process.env, "OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED");
  Reflect.deleteProperty(process.env, "OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS");
});

describe("recovery prober slow backoff", { concurrency: false }, () => {
  test("402 自动调度:5/15/60 分钟,24h 的 tick、探针、成功样本分开计数", async () => {
    start(track("minimax"));
    await settle();
    let timerTicks = 0;
    while (Date.now() < DAY) {
      timerTicks += await advance(MIN, 1);
    }
    const times = calls.map((call) => call.t);
    const expected: number[] = [];
    let cursor = 0;
    let consecutive = 0;
    while (cursor <= DAY) {
      expected.push(cursor);
      consecutive += 1;
      const step = consecutive <= 1 ? FIVE : consecutive === 2 ? FIFTEEN : HOUR;
      const next = cursor + step;
      if (next > DAY) break;
      cursor = next;
    }
    assert.deepEqual(expected.slice(0, 4), [0, FIVE, 20 * MIN, 80 * MIN]);
    assert.equal(expected.length, 26);
    assert.equal(expected[expected.length - 1], 1400 * MIN);
    assert.deepEqual(times, expected);
    assert.equal(timerTicks, 1440);
    assert.equal(calls.length, 26);
    assert.equal(recorded.length, 0);
    assert.ok(calls.length < 100, "稳态必须远低于每分钟一次的 1440");
    for (let i = 3; i < times.length; i++) assert.equal(times[i] - times[i - 1], HOUR);
    const failed = failureLogs();
    assert.equal(failed.length, 26);
    assert.equal(failed[0]?.extra?.consecutive, 1);
    assert.equal(failed[0]?.extra?.backoffMs, FIVE);
    assert.equal(failed[0]?.extra?.suppressedTicks, 0);
    assert.equal(failed[1]?.extra?.consecutive, 2);
    assert.equal(failed[1]?.extra?.backoffMs, FIFTEEN);
    assert.equal(failed[1]?.extra?.suppressedTicks, 4);
    assert.equal(failed[1]?.extra?.nextProbeAt, 20 * MIN);
    assert.equal(failed[2]?.extra?.consecutive, 3);
    assert.equal(failed[2]?.extra?.backoffMs, HOUR);
    assert.equal(failed[2]?.extra?.suppressedTicks, 14);
    assert.equal(failed[3]?.extra?.failureClass, "slow");
    assert.equal(failed[3]?.extra?.backoffMs, HOUR);
    console.log(
      JSON.stringify({
        case: "24h-402",
        timerTicks,
        probes: calls.length,
        successSamples: recorded.length,
        firstProbeMin: times.slice(0, 4).map((t) => t / MIN),
        lastProbeMin: times[times.length - 1] / MIN,
      }),
    );
  });

  test("401/403/400/404 与 402 同一把梯子,且一次终态只发一次探针", async () => {
    for (const status of [401, 403, 400, 404]) {
      for (const handle of handles) handle.stop();
      handles.length = 0;
      calls.length = 0;
      events.length = 0;
      mock.timers.reset();
      mock.timers.enable({ apis: ["setInterval", "Date", "setTimeout"] });
      state.rows = [degraded("minimax")];
      start(async (spec) => {
        calls.push({ t: Date.now(), id: spec.id });
        return result(status);
      });
      await settle();
      await advance(MIN, 4);
      assert.equal(calls.length, 1, `${status} 在 4 分钟内不得再探`);
      await advance(MIN, 1);
      assert.deepEqual(
        calls.map((call) => call.t),
        [0, FIVE],
        `${status} 第二次应落在 5 分钟`,
      );
      await advance(MIN, 15);
      assert.deepEqual(calls.map((call) => call.t), [0, FIVE, 20 * MIN]);
      const failed = failureLogs();
      assert.equal(failed[0]?.extra?.failureClass, "slow");
      assert.equal(failed[0]?.extra?.status, status);
      assert.equal(failed[1]?.extra?.consecutive, 2);
      assert.equal(failed[1]?.extra?.backoffMs, FIFTEEN);
      assert.equal(failed[2]?.extra?.consecutive, 3);
      assert.equal(failed[2]?.extra?.backoffMs, HOUR);
      assert.equal(recorded.length, 0);
    }
  });

  test("429/408/5xx/网络/未知 保持原周期并清掉慢类连续计数", async () => {
    const transients: RecoveryProbeResult[] = [
      result(429),
      result(408),
      result(500),
      result(503),
      result(418, false, "teapot"),
      result(null, false, "ECONNRESET"),
    ];
    for (const transient of transients) {
      for (const handle of handles) handle.stop();
      handles.length = 0;
      calls.length = 0;
      events.length = 0;
      recorded.length = 0;
      unexpected = 0;
      mock.timers.reset();
      mock.timers.enable({ apis: ["setInterval", "Date", "setTimeout"] });
      const label = `${transient.statusCode ?? "network"}:${transient.error ?? ""}`;
      const script = [
        result(402),
        result(402),
        transient,
        result(402),
      ];
      start(sequence("minimax", script));
      await settle();
      await advance(MIN, 21);
      assert.equal(unexpected, 0, label);
      assert.deepEqual(
        calls.map((call) => call.t),
        [0, FIVE, 20 * MIN, 21 * MIN],
        label,
      );
      const failed = failureLogs();
      assert.equal(failed[2]?.extra?.failureClass, "transient", label);
      assert.equal(failed[2]?.extra?.consecutive, 0, label);
      assert.equal(failed[2]?.extra?.backoffMs, MIN, label);
      assert.equal(failed[3]?.extra?.failureClass, "slow", label);
      assert.equal(failed[3]?.extra?.consecutive, 1, label);
      assert.equal(failed[3]?.extra?.backoffMs, FIVE, label);
      assert.equal(failed[3]?.extra?.nextProbeAt, 21 * MIN + FIVE, label);
      assert.equal(recorded.length, 0, label);
    }
  });

  test("换成另一种慢状态时连续计数从 1 重新开始", async () => {
    start(sequence("minimax", [result(402), result(401), result(401)]));
    await settle();
    await advance(MIN, 10);
    assert.equal(unexpected, 0);
    assert.deepEqual(
      calls.map((call) => call.t),
      [0, FIVE, 10 * MIN],
    );
    const failed = failureLogs();
    assert.equal(failed[1]?.extra?.status, 401);
    assert.equal(failed[1]?.extra?.consecutive, 1);
    assert.equal(failed[1]?.extra?.backoffMs, FIVE);
    assert.equal(failed[2]?.extra?.consecutive, 2);
    assert.equal(failed[2]?.extra?.backoffMs, FIFTEEN);
    assert.notEqual(calls[2]?.t, 20 * MIN);
  });

  test("慢请求跨过 tick 时从实际返回时刻计算 nextProbeAt,返回后不立刻补探", async () => {
    let release: (value: RecoveryProbeResult) => void = () => {};
    start(async (spec) => {
      calls.push({ t: Date.now(), id: spec.id });
      if (calls.length === 1) {
        return await new Promise<RecoveryProbeResult>((resolve) => {
          release = resolve;
        });
      }
      return result(402);
    });
    await settle();
    assert.equal(calls.length, 1);
    await advance(MIN, 10);
    assert.equal(calls.length, 1);
    assert.equal(Date.now(), 10 * MIN);
    release(result(402));
    await settle();
    assert.equal(calls.length, 1);
    const first = failureLogs()[0];
    assert.equal(first?.extra?.at, 10 * MIN);
    assert.equal(first?.extra?.nextProbeAt, 15 * MIN);
    assert.equal(first?.extra?.backoffMs, FIVE);
    await advance(MIN, 4);
    assert.equal(calls.length, 1);
    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.t, 15 * MIN);
  });

  test("两个 provider 各自计时,正常的那个不被慢的那个拖住", async () => {
    state.rows = [degraded("minimax"), degraded("ark")];
    start(async (spec) => {
      calls.push({ t: Date.now(), id: spec.id });
      if (spec.id === "ark") return result(200, true, null, "ark-model");
      return result(402, false, null, "minimax-model");
    });
    await settle();
    await advance(MIN, 30);
    const mini = calls.filter((call) => call.id === "minimax").map((call) => call.t);
    const ark = calls.filter((call) => call.id === "ark").map((call) => call.t);
    assert.deepEqual(mini, [0, FIVE, 20 * MIN]);
    assert.equal(ark.length, 31);
    assert.deepEqual(ark.slice(0, 3), [0, MIN, 2 * MIN]);
    assert.equal(ark[ark.length - 1], 30 * MIN);
    assert.equal(recorded.length, 31);
    assert.deepEqual(
      recorded.map((item) => item.providerId),
      Array.from({ length: 31 }, () => "ark"),
    );
    assert.equal(recorded.filter((item) => item.providerId === "minimax").length, 0);
  });

  test("配置 interval 大于 5 和 15 分钟时,慢退避不得短于 interval", async () => {
    process.env.OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS = String(20 * MIN);
    start(track("minimax"));
    await settle();
    await advance(20 * MIN, 2);
    assert.deepEqual(
      calls.map((call) => call.t),
      [0, 20 * MIN, 40 * MIN],
    );
    await advance(20 * MIN, 2);
    assert.equal(calls.length, 3);
    await advance(20 * MIN, 1);
    assert.deepEqual(calls.map((call) => call.t), [0, 20 * MIN, 40 * MIN, 100 * MIN]);
    const failed = failureLogs();
    assert.equal(failed[0]?.extra?.backoffMs, 20 * MIN);
    assert.equal(failed[1]?.extra?.backoffMs, 20 * MIN);
    assert.equal(failed[1]?.extra?.consecutive, 2);
    assert.equal(failed[2]?.extra?.backoffMs, HOUR);
    assert.equal(failed[2]?.extra?.nextProbeAt, 100 * MIN);
    assert.equal(failed[3]?.extra?.backoffMs, HOUR);
  });

  test("只有真正成功才写样本并回到原周期,失败不写样本", async () => {
    start(
      sequence("minimax", [
        result(402),
        result(200, true, null, "recovered-model"),
        result(200, true, null, "recovered-model"),
        result(401),
      ]),
    );
    await settle();
    await advance(MIN, 4);
    assert.equal(calls.length, 1);
    assert.equal(recorded.length, 0);
    await advance(MIN, 1);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0], { providerId: "minimax", model: "recovered-model" });
    const ok = events.filter((event) => event.msg === "recovery_probe_ok");
    assert.equal(ok[0]?.extra?.suppressedTicks, 4);
    assert.equal(ok[0]?.extra?.nextProbeAt, FIVE + MIN);
    assert.equal(ok[0]?.extra?.at, FIVE);
    await advance(MIN, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.t, 6 * MIN);
    assert.equal(recorded.length, 2);
    await advance(MIN, 1);
    assert.equal(calls[3]?.t, 7 * MIN);
    assert.equal(failureLogs().at(-1)?.extra?.consecutive, 1);
    assert.equal(failureLogs().at(-1)?.extra?.backoffMs, FIVE);
    assert.equal(recorded.length, 2);
  });

  test("runNow 只绕过时间,不绕过许可,并复用在飞 Promise", async () => {
    let release: (value: RecoveryProbeResult) => void = () => {};
    const handle = start(async (spec) => {
      calls.push({ t: Date.now(), id: spec.id });
      if (calls.length === 1) {
        return await new Promise<RecoveryProbeResult>((resolve) => {
          release = resolve;
        });
      }
      return result(402);
    });
    const first = handle.runNow();
    const second = handle.runNow();
    assert.equal(first, second);
    await advance(MIN, 1);
    assert.equal(calls.length, 1);
    release(result(402));
    await first;
    assert.equal(calls.length, 1);
    await advance(MIN, 1);
    assert.equal(calls.length, 1);
    await handle.runNow();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.t, 2 * MIN);
    assert.equal(failureLogs()[1]?.extra?.consecutive, 2);
    assert.equal(failureLogs()[1]?.extra?.nextProbeAt, 2 * MIN + FIFTEEN);

    state.rows = [degraded("minimax", "forced_degraded")];
    await handle.runNow();
    assert.equal(calls.length, 2);
    state.rows = [degraded("minimax", "auto", "healthy")];
    await handle.runNow();
    assert.equal(calls.length, 2);
    state.keys.minimax = undefined;
    state.rows = [degraded("minimax")];
    await handle.runNow();
    assert.equal(calls.length, 2);
    state.rows = [degraded("not-a-static-provider")];
    state.keys.minimax = MINIMAX_KEY;
    await handle.runNow();
    assert.equal(calls.length, 2);
    state.rows = [degraded("minimax")];
    await handle.runNow();
    assert.equal(calls.length, 3);
  });

  test("key 值变化、已观测的 healthy/forced/缺 key/删行都会清退避,下次资格恢复即探", async () => {
    const handle = start(track("minimax"));
    await settle();
    await advance(MIN, 1);
    assert.equal(calls.length, 1);

    state.keys.minimax = ROTATED_KEY;
    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.t, 2 * MIN);
    assert.equal(failureLogs().at(-1)?.extra?.consecutive, 1);
    assert.equal(blob().includes(MINIMAX_KEY), false);
    assert.equal(blob().includes(ROTATED_KEY), false);

    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    state.rows = [degraded("minimax", "auto", "healthy")];
    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    state.rows = [degraded("minimax")];
    await advance(MIN, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.t, 5 * MIN);

    state.rows = [degraded("minimax", "forced_healthy")];
    await advance(MIN, 1);
    state.rows = [degraded("minimax")];
    await handle.runNow();
    assert.equal(calls.length, 4);

    state.keys.minimax = undefined;
    await advance(MIN, 1);
    assert.equal(calls.length, 4);
    state.keys.minimax = MINIMAX_KEY;
    await advance(MIN, 1);
    assert.equal(calls.length, 5);

    state.rows = [];
    await advance(MIN, 1);
    assert.equal(calls.length, 5);
    state.rows = [degraded("minimax")];
    await advance(MIN, 1);
    assert.equal(calls.length, 6);
  });

  test("新的 start 不继承上一个句柄的退避", async () => {
    const first = start(track("minimax"));
    await settle();
    assert.equal(calls.length, 1);
    first.stop();
    start(track("minimax"));
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.t, 0);
  });

  test("stop 之后 timer 不再发探针", async () => {
    const handle = start(track("minimax"));
    await settle();
    handle.stop();
    await advance(MIN, 30);
    assert.equal(calls.length, 1);
    await handle.runNow();
    assert.equal(calls.length, 1);
  });

  test("skip 不逐 tick 打日志;失败日志汇总次数与时间,递归内容不含 key/指纹/正文", async () => {
    const hash = digest(MINIMAX_KEY);
    const prefix = hash.slice(0, 16);
    const tail = hash.slice(16);
    const secretError = {
      reason: "quota",
      detail: `refused ${MINIMAX_KEY}`,
      nested: {
        note: `fp ${hash} short ${prefix}`,
        body: JSON.stringify({ messages: [{ content: "ping", key: MINIMAX_KEY }] }),
      },
    } as unknown as string;
    start(async (spec) => {
      calls.push({ t: Date.now(), id: spec.id });
      return result(402, false, secretError, `model-${MINIMAX_KEY}`);
    });
    await settle();
    const afterFirst = events.length;
    assert.equal(failureLogs().length, 1);
    await advance(MIN, 4);
    assert.equal(calls.length, 1);
    assert.equal(events.length, afterFirst);
    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    const failed = failureLogs();
    assert.equal(failed.length, 2);
    assert.equal(failed[1]?.extra?.suppressedTicks, 4);
    assert.equal(failed[1]?.extra?.at, FIVE);
    assert.equal(failed[1]?.extra?.nextProbeAt, 20 * MIN);
    assert.equal(failed[1]?.extra?.consecutive, 2);
    const text = blob();
    assert.equal(text.includes(MINIMAX_KEY), false);
    assert.equal(text.includes(ARK_KEY), false);
    assert.equal(text.includes(hash), false);
    assert.equal(text.includes(prefix), false);
    assert.equal(text.includes(tail), false);
    assert.equal(text.includes("ping"), false);
    assert.equal(text.includes("quota"), true);
    assert.equal(text.includes("[redacted]"), true);
    assert.equal(recorded.length, 0);
  });

  test("query 失败不发探针、不写样本,异常文本里的 key 与指纹被抹掉", async () => {
    const hash = digest(MINIMAX_KEY);
    const handle = startRecoveryProber({
      staticProviderKeys: state.keys,
      log,
      _deps: {
        query: (() =>
          Promise.reject(new Error(`pg ${MINIMAX_KEY} fp ${hash} short ${hash.slice(0, 16)}`))) as unknown as QueryFn,
        probeRequest: async () => {
          calls.push({ t: Date.now(), id: "should-not" });
          return result(200, true);
        },
        recordSuccess: () => recorded.push({ providerId: "x", model: "y" }),
      },
    });
    assert.ok(handle);
    handles.push(handle);
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(recorded.length, 0);
    assert.equal(events.some((event) => event.msg === "recovery_prober_tick_failed"), true);
    const text = blob();
    assert.equal(text.includes(MINIMAX_KEY), false);
    assert.equal(text.includes(hash), false);
    assert.equal(text.includes(hash.slice(0, 16)), false);
    assert.equal(text.includes(hash.slice(16)), false);
  });

  test("探针抛错仍走 tick_failed,不写成功样本,下一拍按原周期而不是 5 分钟", async () => {
    const hash = digest(MINIMAX_KEY);
    let n = 0;
    start(async (spec) => {
      calls.push({ t: Date.now(), id: spec.id });
      n += 1;
      if (n === 1) throw new Error(`socket ${MINIMAX_KEY} fp ${hash} short ${hash.slice(0, 16)}`);
      return result(200, true, null, "after-throw");
    });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(recorded.length, 0);
    assert.equal(events.some((event) => event.msg === "recovery_prober_tick_failed"), true);
    assert.equal(blob().includes(MINIMAX_KEY), false);
    assert.equal(blob().includes(hash), false);
    await advance(MIN, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.t, MIN);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.model, "after-throw");
  });
});

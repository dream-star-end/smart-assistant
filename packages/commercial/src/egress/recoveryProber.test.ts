/**
 * 降级探活恢复器单测。
 * 覆盖:只探 auto+degraded 的静态 provider / forced 两态与健康态都不探 / 缺 key 跳过 /
 *      非静态 provider 跳过 / 成功才写样本、失败只告警 / tick 异常只 warn 不冒泡 /
 *      DISABLED=1 不启动 / runOnStart 启动即积累证据。
 * 不发真实网络(probeRequest 注入)、不写真实 PG(query/recordSuccess 注入)。
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  startRecoveryProber,
  type RecoveryProbeRequest,
  type RecoveryProbeResult,
} from "./recoveryProber.js";
import type { StaticProviderKeys } from "@openclaude/protocol";

const logState = { infos: [] as string[], warns: [] as string[] };
const fakeLog = {
  info: (msg: string) => logState.infos.push(msg),
  warn: (msg: string) => logState.warns.push(msg),
};

const keys: StaticProviderKeys = {
  opencodego: "sk-opencodego",
  ark: "sk-ark",
};

const recorded: Array<{ providerId: string; model: string }> = [];

function okResult(model: string): RecoveryProbeResult {
  return { ok: true, statusCode: 200, error: null, model };
}
function failResult(model: string, statusCode: number | null = 429): RecoveryProbeResult {
  return { ok: false, statusCode, error: "boom", model };
}

type Deps = NonNullable<Parameters<typeof startRecoveryProber>[0]["_deps"]>;
type QueryFn = Deps["query"];

interface OpsRow {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
}

function run(rows: OpsRow[], probe: RecoveryProbeRequest) {
  return startRecoveryProber({
    staticProviderKeys: keys,
    log: fakeLog,
    _deps: {
      query: (async () => ({ rows })) as unknown as QueryFn,
      probeRequest: probe,
      recordSuccess: (providerId, model) => recorded.push({ providerId, model }),
    },
  });
}

afterEach(() => {
  recorded.length = 0;
  logState.infos = [];
  logState.warns = [];
  Reflect.deleteProperty(process.env, "OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED");
  Reflect.deleteProperty(process.env, "OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS");
});

describe("startRecoveryProber — 探活对象筛选", () => {
  test("只探 auto+degraded 的静态 provider;forced 两态与健康态都不探", async () => {
    const probed: string[] = [];
    const h = run(
      [
        { provider_id: "opencodego", health_status: "degraded", health_mode: "auto" },
        { provider_id: "ark", health_status: "degraded", health_mode: "auto" },
        { provider_id: "zai", health_status: "degraded", health_mode: "forced_healthy" },
        { provider_id: "kimi", health_status: "healthy", health_mode: "auto" },
        { provider_id: "minimax", health_status: "degraded", health_mode: "forced_degraded" },
        { provider_id: "not-a-static-provider", health_status: "degraded", health_mode: "auto" },
      ],
      async (spec) => {
        probed.push(spec.id);
        return okResult("m");
      },
    );
    assert.ok(h);
    await h.runNow();
    assert.deepEqual(probed.sort(), ["ark", "opencodego"]);
    h.stop();
  });

  test("缺 key 的 degraded provider 跳过(无法探活,保持降级)", async () => {
    const probed: string[] = [];
    const h = run(
      [{ provider_id: "zai", health_status: "degraded", health_mode: "auto" }], // keys 无 zai
      async (spec) => {
        probed.push(spec.id);
        return okResult("m");
      },
    );
    assert.ok(h);
    await h.runNow();
    assert.equal(probed.length, 0);
    h.stop();
  });
});

describe("startRecoveryProber — 样本写入(只写成功)", () => {
  test("探活成功 → 写成功样本;失败 → 不写样本只告警", async () => {
    const h = run(
      [
        { provider_id: "opencodego", health_status: "degraded", health_mode: "auto" },
        { provider_id: "ark", health_status: "degraded", health_mode: "auto" },
      ],
      async (spec) =>
        spec.id === "opencodego" ? okResult("deepseek-v4-flash") : failResult("glm-5.2"),
    );
    assert.ok(h);
    await h.runNow();
    assert.deepEqual(recorded, [{ providerId: "opencodego", model: "deepseek-v4-flash" }]);
    assert.ok(logState.warns.includes("recovery_probe_failed"));
    h.stop();
  });

  test("tick 内 query 抛错 → 只 warn 不冒泡", async () => {
    const h = startRecoveryProber({
      staticProviderKeys: keys,
      log: fakeLog,
      _deps: {
        query: (() => Promise.reject(new Error("pg down"))) as unknown as QueryFn,
        probeRequest: async () => {
          throw new Error("should not probe");
        },
        recordSuccess: () => {
          throw new Error("should not record");
        },
      },
    });
    assert.ok(h);
    await h.runNow(); // 不 reject 即通过
    assert.ok(logState.warns.includes("recovery_prober_tick_failed"));
    h.stop();
  });
});

describe("startRecoveryProber — 开关与启动", () => {
  test("DISABLED=1 → 返回 null 不启动", () => {
    process.env.OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED = "1";
    const h = startRecoveryProber({ staticProviderKeys: keys, log: fakeLog });
    assert.equal(h, null);
    assert.ok(logState.infos.includes("recovery_prober_disabled"));
  });

  test("runOnStart:启动即跑一轮(部署后降级 provider 立即开始积累恢复证据)", async () => {
    const probed: string[] = [];
    const h = run(
      [{ provider_id: "opencodego", health_status: "degraded", health_mode: "auto" }],
      async (spec) => {
        probed.push(spec.id);
        return okResult("deepseek-v4-flash");
      },
    );
    assert.ok(h);
    await new Promise((r) => setImmediate(r));
    assert.equal(probed.length, 1);
    h.stop();
  });
});

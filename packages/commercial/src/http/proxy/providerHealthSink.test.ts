/**
 * provider 健康度信号 sink 单测(0108)。
 * 覆盖:只治理静态 provider(非静态丢弃)/ 失败全记 + final 抽样(注入 random)/
 *      写失败静默(注入 throwing query,断言不抛 + buffer 清空)/ 多行 INSERT。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  recordProviderHealthSample,
  flushProviderHealthSamples,
  _setProviderHealthSinkDepsForTest,
  _drainBufferForTest,
  _bufferLenForTest,
} from "./providerHealthSink.js";

const STATIC_MODEL = "deepseek-v4-pro"; // → provider 'deepseek'
const NON_STATIC_MODEL = "claude-opus-4-6"; // → undefined(OAuth,归 account-pool)

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLog; } } as never;

beforeEach(() => {
  _drainBufferForTest();
  _setProviderHealthSinkDepsForTest({ random: () => 0, logger: silentLog }); // random<0.1 → final 恒采样
});

describe("recordProviderHealthSample — provider 过滤 + 采样", () => {
  test("非静态 provider(OAuth/claude)直接丢弃", () => {
    recordProviderHealthSample(NON_STATIC_MODEL, "upstream_5xx");
    recordProviderHealthSample(NON_STATIC_MODEL, "final");
    assert.equal(_bufferLenForTest(), 0);
  });

  test("失败样本全记(不抽样)", () => {
    _setProviderHealthSinkDepsForTest({ random: () => 0.99, logger: silentLog }); // 即便 random 高,失败也记
    recordProviderHealthSample(STATIC_MODEL, "upstream_5xx");
    recordProviderHealthSample(STATIC_MODEL, "partial");
    recordProviderHealthSample(STATIC_MODEL, "timeout");
    const buf = _drainBufferForTest();
    assert.equal(buf.length, 3);
    assert.ok(buf.every((b) => b.provider_id === "deepseek" && b.ok === false));
  });

  test("final 抽样:random<rate 记,random>=rate 丢", () => {
    _setProviderHealthSinkDepsForTest({ random: () => 0.05, logger: silentLog }); // < 0.1 → 记
    recordProviderHealthSample(STATIC_MODEL, "final");
    assert.equal(_bufferLenForTest(), 1);
    assert.equal(_drainBufferForTest()[0]?.ok, true);

    _setProviderHealthSinkDepsForTest({ random: () => 0.5, logger: silentLog }); // >= 0.1 → 丢
    recordProviderHealthSample(STATIC_MODEL, "final");
    assert.equal(_bufferLenForTest(), 0);
  });

  test("aborted 记 ok=false(judgement 侧再排除)", () => {
    recordProviderHealthSample(STATIC_MODEL, "aborted");
    const buf = _drainBufferForTest();
    assert.equal(buf.length, 1);
    assert.equal(buf[0]?.kind, "aborted");
    assert.equal(buf[0]?.ok, false);
  });
});

describe("flushProviderHealthSamples — 批量 + 静默", () => {
  test("多行 INSERT:一次 flush 拼所有行,参数展平", async () => {
    let captured: { sql: string; params: unknown[] } | null = null;
    _setProviderHealthSinkDepsForTest({
      random: () => 0,
      logger: silentLog,
      query: async (sql, params) => {
        captured = { sql, params };
        return { rows: [], rowCount: params.length / 5 } as never;
      },
    });
    recordProviderHealthSample(STATIC_MODEL, "upstream_5xx");
    recordProviderHealthSample(STATIC_MODEL, "partial");
    await flushProviderHealthSamples();
    const cap = captured as { sql: string; params: unknown[] } | null;
    assert.ok(cap, "query should be called");
    assert.match(cap.sql, /INSERT INTO provider_health_samples/);
    assert.equal(cap.params.length, 10); // 2 行 × 5 列
    assert.equal(_bufferLenForTest(), 0);
  });

  test("写失败静默:不抛,丢该批(不无限积压)", async () => {
    _setProviderHealthSinkDepsForTest({
      random: () => 0,
      logger: silentLog,
      query: async () => {
        throw new Error("PG down");
      },
    });
    recordProviderHealthSample(STATIC_MODEL, "upstream_5xx");
    await assert.doesNotReject(flushProviderHealthSamples());
    assert.equal(_bufferLenForTest(), 0); // 失败批被丢弃,不回填
  });
});

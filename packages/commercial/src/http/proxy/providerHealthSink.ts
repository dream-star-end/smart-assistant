/**
 * provider 健康度 —— 信号层采样写入(roadmap P3.2)。
 *
 * 在流 settle/finalizer(core.ts runUpstreamRoundTrip)处按 provider 记一条健康样本:
 *   - 失败(partial / aborted / 上游 5xx / 超时)全记;成功(final)抽样 1/10(env 可调)——
 *     控写放大。
 *   - **只治理静态 provider**(findRouteProviderForModel 命中):OAuth/claude 由 account-pool
 *     健康体系(ACCOUNT_POOL_ALL_DOWN)追踪,不在此重复,亦规避最热路径写放大;
 *     codex/gpt-5.5 走独立 relay,不经本 finalizer。
 *   - 进程:v5 拓扑下 proxy settle 样本由 egress 写；master 的 lossless-tape finalize
 *     另用同一 sink 补 gateway 已证明的 idle-timeout 样本。二者各有进程内 buffer、都直写
 *     PG，不走 cost-event 通道（健康样本无钱包/广播语义）。部署改运行逻辑时须同时评估
 *     master 与 egress 轴。
 *
 * 纪律(信号层绝不影响在飞流):record 是同步 fire-and-forget(只入内存 buffer + 排定
 * flush,不 await、不 throw);实际 INSERT 在 unref 定时器里批量执行,写失败静默丢批只 warn。
 */

import { findRouteProviderForModel } from "@openclaude/protocol";
import { query as _query, type QueryRunner } from "../../db/queries.js";
import { rootLogger, type Logger } from "../../logging/logger.js";
import { getPool } from "../../db/index.js";

export type HealthSampleKind =
  | "final"
  | "partial"
  | "aborted"
  | "upstream_5xx"
  | "timeout"
  | "reject_config";

const MAX_BUFFER = 5_000;
const MAX_BATCH = 200;
const FLUSH_INTERVAL_MS = 3_000;

interface Buffered {
  provider_id: string;
  ok: boolean;
  kind: HealthSampleKind;
  model: string;
  at: Date;
}

const buffer: Buffered[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

// ── DI seam(测试用;生产走默认)──────────────────────────────────────
let queryImpl: (sql: string, params: unknown[]) => Promise<unknown> = (sql, params) =>
  _query(sql, params, getPool() as unknown as QueryRunner);
let randomImpl: () => number = Math.random;
let log: Logger = rootLogger.child({ subsys: "providerHealthSink" });

function successSampleRate(): number {
  const raw = Number(process.env.OC_PROVIDER_HEALTH_SUCCESS_SAMPLE_RATE);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 0.1;
  return raw;
}

/**
 * 记录一条 provider 健康样本(同步 fire-and-forget,永不 throw)。
 * kind='final' → ok=true 且按 successSampleRate 抽样;其余 → ok=false 全记。
 * model 非静态 provider(OAuth/未知)→ 直接丢弃。
 */
export function recordProviderHealthSample(model: string, kind: HealthSampleKind): void {
  try {
    const spec = findRouteProviderForModel(model);
    if (!spec) return; // 只治理静态 provider
    if (kind === "final" && randomImpl() >= successSampleRate()) return;
    if (buffer.length >= MAX_BUFFER) buffer.shift(); // 防内存失控:丢最老
    buffer.push({ provider_id: spec.id, ok: kind === "final", kind, model, at: new Date() });
    scheduleFlush();
  } catch {
    /* 信号层绝不影响在飞流 */
  }
}

/**
 * 探活成功样本独立入口(recoveryProber 专用):降级期间零真实流量,恢复条件永远拿不到
 * 成功样本(死锁)。探活 2xx 即一条 kind='final' 真实成功样本(model 带 `probe:` 前缀
 * 区分人工流量),master scheduler 既有恢复数学直接可判恢复。只写成功:失败不写样本
 * (缺成功样本=不恢复,判定等价;失败细节在 egress 日志 recovery_probe_failed)。
 * 走独立 INSERT 不进 traffic buffer,不抽样(探活自身已限频);同步 fire-and-forget,
 * 永不 throw,绝不影响在飞流。
 */
export function recordProviderProbeSuccess(providerId: string, model: string): void {
  try {
    void queryImpl(
      `INSERT INTO provider_health_samples (provider_id, ok, kind, model) VALUES ($1, true, 'final', $2)`,
      [providerId, `probe:${model}`],
    ).catch((err: unknown) => {
      log.warn("provider_probe_sample_insert_failed", {
        provider: providerId,
        err: String((err as Error)?.message ?? err),
      });
    });
  } catch {
    /* 信号层绝不影响在飞流 */
  }
}

function scheduleFlush(): void {
  if (buffer.length >= MAX_BATCH) {
    void flushProviderHealthSamples();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushProviderHealthSamples();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** 批量落盘(多行 INSERT)。写失败:丢该批只 warn(不回填,避免无限积压)。 */
export async function flushProviderHealthSamples(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, MAX_BATCH);
      try {
        const values: unknown[] = [];
        const tuples = batch
          .map((b, i) => {
            const o = i * 5;
            values.push(b.provider_id, b.ok, b.kind, b.model, b.at);
            return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`;
          })
          .join(",");
        await queryImpl(
          `INSERT INTO provider_health_samples (provider_id, ok, kind, model, at) VALUES ${tuples}`,
          values,
        );
      } catch (err) {
        log.warn("provider_health_flush_failed", {
          dropped: batch.length,
          err: String((err as Error)?.message ?? err),
        });
      }
    }
  } finally {
    flushing = false;
  }
}

/** 优雅停机/测试:清 timer 并 flush 一次。 */
export async function stopProviderHealthSink(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushProviderHealthSamples();
}

// ── 测试辅助 ─────────────────────────────────────────────────────────
export function _setProviderHealthSinkDepsForTest(deps: {
  query?: (sql: string, params: unknown[]) => Promise<unknown>;
  random?: () => number;
  logger?: Logger;
}): void {
  if (deps.query) queryImpl = deps.query;
  if (deps.random) randomImpl = deps.random;
  if (deps.logger) log = deps.logger;
}
export function _drainBufferForTest(): Buffered[] {
  return buffer.splice(0, buffer.length);
}
export function _bufferLenForTest(): number {
  return buffer.length;
}

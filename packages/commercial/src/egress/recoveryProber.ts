/**
 * provider 健康度 —— 降级探活恢复器(egress,根治死锁)。
 *
 * 死锁实发(2026-08-23 opencodego):auto 降级 → 前端禁选 → 零真实流量 →
 * provider_health_samples 无新样本 → 恢复条件「recover 窗口有成功样本」永不满足 →
 * 上游早已恢复也永久 degraded(设计死角)。本恢复器在 provider 处于
 * health_mode='auto' 且 health_status='degraded' 期间,周期性发**真实最小推理请求**
 * (1 轮 "ping",max_tokens=512 给思考模型留头部):
 *   - 探活 2xx → 写一条 kind='final' 成功样本(model 带 `probe:` 前缀区分人工流量)
 *     → scheduler 既有恢复数学直接接管(默认 60s 周期 + 5min 恢复窗 → 上游恢复后
 *     最迟约 5-6 分钟自动转 healthy);
 *   - 探活非 2xx / 网络错误 → **不写样本**(缺成功样本 = 不恢复,判定与写失败样本
 *     完全等价)。401/402 也不会被本器标成健康。
 *
 * 确定性终态(HTTP 401/402/403,以及 defaultProbeRequest 已用尽候选后的 400/404)
 * 按 provider 做进程内慢退避:连续同一状态 5min → 15min → 60min,不短于已配置
 * interval(interval 本身夹在 [15s, 1h])。只有这类结果才用时间门。429/408/5xx、
 * 网络错误和未知状态保持原周期,并清掉慢类连续计数和时间阻塞;换成另一种慢类状态
 * 也从 5min 重新计数。慢类的 nextProbeAt 从这次结果实际返回的时刻起算。成功或
 * 瞬态不再把「结束时刻 + interval」当成阻塞:下一拍仍由既有 timer 与 in-flight
 * 决定,日志里的 nextProbeAt 是下一档 timer,短耗时不会把 60s 周期拖成 120s。
 * 退避是进程内状态,重启后的首轮探活照常发;这不是跨重启持久隔离。
 *
 * timer 与启动首轮遵守退避。只有显式 runNow() 绕过时间,仍遵守 auto+degraded、
 * 已知静态 provider 与 key 过滤,并与在飞 tick 共用同一个 Promise。
 *
 * 与 latencyProber 的口径**故意不同**:后者是 transport 语义(GET,任何 HTTP 响应都算
 * ok),不能用于恢复判定 —— 否则 ark 型 429 容量错误会被 transport 探活误判恢复,造成
 * 降级/恢复振荡。恢复必须由真实推理成功背书。
 *
 * 只写成功样本还有两个工程红利:
 *   ① 零迁移:provider_health_samples.kind 的 CHECK 约束不含新字面量也成立;
 *   ② 零编号风险:不新增迁移就不与任何在途迁移支(0246-0250)产生 apply 顺序纠缠。
 *
 * 纪律(对齐 latencyProber):
 * - 只在 degraded+auto 期间探测(forced 模式尊重管理员;转 healthy 即停)→ 稳态零成本。
 *   慢退避期间不发探活网络、不写成功样本、不逐 tick 打印 skip。
 * - 出口策略与真实流量同源:STATIC_PROVIDER_META.egress direct → directEgressDispatcher
 *   直连,否则全局代理 —— 测别的路径没有运维意义。
 * - 鉴权头风格照 protocol spec(bearer 缺省;opencodego/moonshot/bailian x-api-key)。
 * - 任何失败只 warn 不冒泡,绝不影响在飞 LLM 流主职。日志不得带 key、key 指纹或请求正文。
 *
 * 探活模型字面量:inboundModelIds 逐个尝试(经 upstreamModelForRequest 精确改写、去重);
 * 400/404 视为该字面量可能已被上游退役 → 换下一个,其余非 2xx(401/429/5xx)与网络错误
 * 直接定性失败。不读 catalog,保持本器与 catalog epoch 解耦;字面量全退役表现为持续
 * 探活失败(仅日志),届时调整 inbound 顺序即可。调度层只看这次调用的终态结果。
 *
 * env:OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED=1 关;
 *      OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS 调周期(缺省 60s,夹 [15s, 1h])。
 */

import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";
import {
  STATIC_KEY_PROVIDERS,
  type StaticKeyProviderSpec,
  type StaticProviderKeys,
} from "@openclaude/protocol";
import { STATIC_PROVIDER_META } from "../http/proxy/staticProviderMeta.js";
import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import { query as _query } from "../db/queries.js";
import { recordProviderProbeSuccess as _recordSuccess } from "../http/proxy/providerHealthSink.js";

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_TOKENS = 512;
const SLOW_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const SLOW_STATUSES = new Set([400, 401, 402, 403, 404]);
const OMITTED_LOG_FIELDS = new Set([
  "body",
  "requestBody",
  "headers",
  "authorization",
  "apiKey",
  "api_key",
  "key",
  "fingerprint",
  "keyFingerprint",
]);

export interface RecoveryProbeResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** 终态探活实际使用的上游 model 字面量(成功时写样本 model 列,供 admin 观察)。 */
  model: string;
}

export interface RecoveryProberHandle {
  stop(): void;
  /** 手动跑一轮(测试/运维用);上轮未结束时复用同一 in-flight promise。绕过时间退避,不绕过许可。 */
  runNow(): Promise<void>;
}

export type RecoveryProbeRequest = (
  spec: StaticKeyProviderSpec,
  key: string,
) => Promise<RecoveryProbeResult>;

interface RecoveryProberDeps {
  query?: typeof _query;
  probeRequest?: RecoveryProbeRequest;
  /** 只记成功样本;失败由日志承载(缺成功样本=不恢复,判定等价)。 */
  recordSuccess?: (providerId: string, model: string) => void;
}

/** 进程内、按 provider。不写入 DB,重启即丢。 */
interface ProbePace {
  keyMark: string;
  slowStatus: number | null;
  slowCount: number;
  nextProbeAt: number;
  suppressedTicks: number;
}

function probeCandidates(spec: StaticKeyProviderSpec): string[] {
  const rewritten = spec.inboundModelIds.map((m) => spec.upstreamModelForRequest?.(m) ?? m);
  return [...new Set(rewritten)];
}

/**
 * 探活请求头 —— 与真实流量(upstream.ts makeStaticKeyUpstream.applyUpstreamAuth)同源:
 * 鉴权头风格照 spec;上游要求稳定会话 id 头(OpenCode Go `x-opencode-session`,2026-09-07
 * 起缺失即 400 MissingSessionID)时探活也必须带,否则探活恒 400 → 永不恢复,正是本器要根治
 * 的死锁形态。探活每次是独立会话,随机 UUID 即可。导出仅为单测(不发网络即可断言头集)。
 */
export function buildRecoveryProbeHeaders(
  spec: StaticKeyProviderSpec,
  key: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (spec.authScheme === "x-api-key") headers["x-api-key"] = key;
  else headers.authorization = `Bearer ${key}`;
  if (spec.sessionIdHeader) headers[spec.sessionIdHeader] = randomUUID();
  return headers;
}

async function defaultProbeRequest(
  spec: StaticKeyProviderSpec,
  key: string,
): Promise<RecoveryProbeResult> {
  const meta = STATIC_PROVIDER_META[spec.id];
  const dispatcher = meta.egress === "direct" ? directEgressDispatcher() : undefined;
  const headers = buildRecoveryProbeHeaders(spec, key);

  let statusCode: number | null = null;
  let error: string | null = null;
  let model = "";
  for (const candidate of probeCandidates(spec)) {
    model = candidate;
    try {
      const res = await request(spec.upstreamEndpoint, {
        method: "POST",
        dispatcher,
        headers,
        body: JSON.stringify({
          model,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: "ping" }],
        }),
        headersTimeout: PROBE_TIMEOUT_MS,
        bodyTimeout: PROBE_TIMEOUT_MS,
      });
      statusCode = res.statusCode;
      await res.body.dump().catch(() => {});
      // 真实推理成功(2xx)才背书恢复;401/429/5xx 直接定性失败;400/404 可能只是该
      // model 字面量退役 → 换下一个候选。调度层的慢退避只看这里返回的终态。
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true, statusCode, error: null, model };
      }
      if (res.statusCode !== 400 && res.statusCode !== 404) {
        return { ok: false, statusCode, error, model };
      }
    } catch (err) {
      // 先抹掉本次 key / 指纹再截断,避免截断把密钥切成无法整段匹配的碎片。
      error = redactProbeError(String((err as Error)?.message ?? err), key).slice(0, 200);
      return { ok: false, statusCode: null, error, model };
    }
  }
  return { ok: false, statusCode, error, model };
}

function keyMark(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function redactProbeError(input: string, key: string): string {
  if (key.length < 8) return input;
  const digest = keyMark(key);
  return input
    .split(digest)
    .join("[redacted]")
    .split(key)
    .join("[redacted]")
    .split(digest.slice(0, 16))
    .join("[redacted]");
}

function slowBackoffMs(consecutive: number, intervalMs: number): number {
  const step =
    consecutive <= 1 ? SLOW_BACKOFF_MS[0] : consecutive === 2 ? SLOW_BACKOFF_MS[1] : SLOW_BACKOFF_MS[2];
  // interval 已夹到 ≤1h,所以结果不会长于 1h,也不会短于调用方配置的周期。
  return Math.max(step, intervalMs);
}

function redactString(input: string, secretList: readonly string[]): string {
  let redacted = input;
  for (const secret of secretList) {
    if (secret.length < 8 || !redacted.includes(secret)) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function sanitize(value: unknown, secretList: readonly string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value, secretList);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return redactString(String(value), secretList);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secretList, seen));
  const out: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(value)) {
    if (OMITTED_LOG_FIELDS.has(field)) continue;
    out[field] = sanitize(inner, secretList, seen);
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function startRecoveryProber(
  opts: {
    staticProviderKeys: StaticProviderKeys;
    log: {
      info: (msg: string, extra?: Record<string, unknown>) => void;
      warn: (msg: string, extra?: Record<string, unknown>) => void;
    };
    _deps?: RecoveryProberDeps;
  },
): RecoveryProberHandle | null {
  if (process.env.OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED === "1") {
    opts.log.info("recovery_prober_disabled");
    return null;
  }
  const raw = Number(process.env.OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS ?? 60_000);
  const intervalMs = Math.min(
    Math.max(Number.isFinite(raw) && raw > 0 ? raw : 60_000, 15_000),
    3_600_000,
  );

  const q = opts._deps?.query ?? _query;
  const probeRequest = opts._deps?.probeRequest ?? defaultProbeRequest;
  const recordSuccess = opts._deps?.recordSuccess ?? _recordSuccess;
  const log = opts.log;
  const knownKeys = new Set<string>();

  const byId = new Map<string, StaticKeyProviderSpec>(
    STATIC_KEY_PROVIDERS.map((p) => [p.id, p]),
  );
  const pace = new Map<string, ProbePace>();
  // setInterval 与这次取值在同一同步段,相位就是 timer 的起点。
  const startedAt = Date.now();

  let stopped = false;
  let inflight: Promise<void> | null = null;

  function nextOpenSlot(finishedAt: number): number {
    const elapsed = finishedAt - startedAt;
    if (elapsed <= 0) return startedAt + intervalMs;
    const remainder = elapsed % intervalMs;
    if (remainder === 0) return finishedAt + intervalMs;
    return finishedAt + (intervalMs - remainder);
  }

  function noteKeys(): void {
    for (const value of Object.values(opts.staticProviderKeys)) {
      if (typeof value === "string" && value.length >= 8) knownKeys.add(value);
    }
  }

  function secrets(): string[] {
    noteKeys();
    const out: string[] = [];
    for (const key of knownKeys) {
      const digest = keyMark(key);
      out.push(key, digest, digest.slice(0, 16));
    }
    // 先抹完整指纹,再抹 16 位前缀,避免前缀替换把完整哈希切碎后泄漏剩余部分。
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  function logWarn(msg: string, extra: Record<string, unknown>): void {
    log.warn(msg, sanitize(extra, secrets()) as Record<string, unknown>);
  }

  function logInfo(msg: string, extra: Record<string, unknown>): void {
    log.info(msg, sanitize(extra, secrets()) as Record<string, unknown>);
  }

  function remember(
    providerId: string,
    mark: string,
    slowStatus: number | null,
    slowCount: number,
    finishedAt: number,
    backoffMs: number,
  ): number {
    const nextProbeAt = finishedAt + backoffMs;
    pace.set(providerId, {
      keyMark: mark,
      slowStatus,
      slowCount,
      nextProbeAt,
      suppressedTicks: 0,
    });
    return nextProbeAt;
  }

  function rememberOpen(
    providerId: string,
    mark: string,
    finishedAt: number,
  ): { nextProbeAt: number; backoffMs: number } {
    const nextProbeAt = nextOpenSlot(finishedAt);
    pace.set(providerId, {
      keyMark: mark,
      slowStatus: null,
      slowCount: 0,
      nextProbeAt,
      suppressedTicks: 0,
    });
    return { nextProbeAt, backoffMs: nextProbeAt - finishedAt };
  }

  async function runTick(bypassWait: boolean): Promise<void> {
    noteKeys();
    const r = await q<{ provider_id: string; health_status: string | null; health_mode: string }>(
      "SELECT provider_id, health_status, health_mode FROM provider_ops",
    );
    const present = new Set<string>();
    for (const row of r.rows) {
      if (byId.has(row.provider_id)) present.add(row.provider_id);
    }
    for (const id of [...pace.keys()]) {
      if (!present.has(id)) pace.delete(id);
    }

    for (const row of r.rows) {
      if (stopped) return;
      // 过滤在代码而非 SQL:单测可注入任意 ops 行;全表 ≤9 行,无谓再压查询。
      const spec = byId.get(row.provider_id);
      if (!spec) continue; // 非静态 provider(account-pool 体系)不在本系统治理面
      const eligible = row.health_mode === "auto" && row.health_status === "degraded";
      const key = opts.staticProviderKeys[spec.id];
      if (!eligible || !key) {
        // 已观测到 healthy / forced / 缺 key:清掉退避。没看见的 DB 往返不在这里处理。
        pace.delete(spec.id);
        continue;
      }
      const mark = keyMark(key);
      let st = pace.get(spec.id);
      if (st && st.keyMark !== mark) {
        pace.delete(spec.id);
        st = undefined;
      }
      // 时间门只挡慢类。成功/瞬态的 nextProbeAt 只是下一档 timer,不在这里跳拍。
      if (!bypassWait && st?.slowStatus != null && Date.now() < st.nextProbeAt) {
        st.suppressedTicks += 1;
        continue;
      }
      const suppressed = st?.suppressedTicks ?? 0;
      const res = await probeRequest(spec, key);
      const finishedAt = Date.now();
      if (res.ok) {
        const open = rememberOpen(spec.id, mark, finishedAt);
        recordSuccess(spec.id, res.model);
        logInfo("recovery_probe_ok", {
          provider: spec.id,
          status: res.statusCode,
          model: res.model,
          suppressedTicks: suppressed,
          nextProbeAt: open.nextProbeAt,
          backoffMs: open.backoffMs,
          at: finishedAt,
        });
        continue;
      }
      const status = res.statusCode;
      const slow = status != null && SLOW_STATUSES.has(status);
      if (!slow) {
        const open = rememberOpen(spec.id, mark, finishedAt);
        logWarn("recovery_probe_failed", {
          provider: spec.id,
          status,
          error: res.error,
          model: res.model,
          failureClass: "transient",
          consecutive: 0,
          nextProbeAt: open.nextProbeAt,
          backoffMs: open.backoffMs,
          suppressedTicks: suppressed,
          at: finishedAt,
        });
        continue;
      }
      // 同一 HTTP 状态才沿 5/15/60 累加;换成另一种慢状态从 1 重新计数。
      const slowCount = st && st.slowStatus === status ? st.slowCount + 1 : 1;
      const backoffMs = slowBackoffMs(slowCount, intervalMs);
      const nextProbeAt = remember(spec.id, mark, status, slowCount, finishedAt, backoffMs);
      logWarn("recovery_probe_failed", {
        provider: spec.id,
        status,
        error: res.error,
        model: res.model,
        failureClass: slow ? "slow" : "transient",
        consecutive: slowCount,
        nextProbeAt,
        backoffMs,
        suppressedTicks: suppressed,
        at: finishedAt,
      });
    }
  }

  function scheduleTick(bypassWait: boolean): Promise<void> {
    if (inflight) return inflight; // in-flight guard:极端超时一轮可 9×30s,防 tick 重叠;手动也不另起一条
    inflight = runTick(bypassWait)
      .catch((err: unknown) => {
        logWarn("recovery_prober_tick_failed", { err: errorText(err) });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (!stopped) void scheduleTick(false);
  }, intervalMs);
  timer.unref?.();
  void scheduleTick(false); // runOnStart:无退避记录时立即探;已有退避则遵守,不走手动强制

  log.info("recovery_prober_started", { intervalMs, providers: STATIC_KEY_PROVIDERS.length });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: () => scheduleTick(true),
  };
}

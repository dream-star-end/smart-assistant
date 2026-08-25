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
 *     完全等价),失败细节进 egress 日志 recovery_probe_failed(status/error/model)。
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
 * - 只在 degraded+auto 期间探测(forced 模式尊重管理员;转 healthy 即停)→ 稳态零成本,
 *   每 tick 每 provider 至多 1 次终态探活。
 * - 出口策略与真实流量同源:STATIC_PROVIDER_META.egress direct → directEgressDispatcher
 *   直连,否则全局代理 —— 测别的路径没有运维意义。
 * - 鉴权头风格照 protocol spec(bearer 缺省;opencodego/moonshot/bailian x-api-key)。
 * - 任何失败只 warn 不冒泡,绝不影响在飞 LLM 流主职。
 *
 * 探活模型字面量:inboundModelIds 逐个尝试(经 upstreamModelForRequest 精确改写、去重);
 * 400/404 视为该字面量可能已被上游退役 → 换下一个,其余非 2xx(401/429/5xx)与网络错误
 * 直接定性失败。不读 catalog,保持本器与 catalog epoch 解耦;字面量全退役表现为持续
 * 探活失败(仅日志),届时调整 inbound 顺序即可。
 *
 * env:OC_PROVIDER_HEALTH_RECOVERY_PROBE_DISABLED=1 关;
 *      OC_PROVIDER_HEALTH_RECOVERY_PROBE_INTERVAL_MS 调周期(缺省 60s,夹 [15s, 1h])。
 */

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

export interface RecoveryProbeResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** 终态探活实际使用的上游 model 字面量(成功时写样本 model 列,供 admin 观察)。 */
  model: string;
}

export interface RecoveryProberHandle {
  stop(): void;
  /** 手动跑一轮(测试/运维用);上轮未结束时复用同一 in-flight promise。 */
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

function probeCandidates(spec: StaticKeyProviderSpec): string[] {
  const rewritten = spec.inboundModelIds.map((m) => spec.upstreamModelForRequest?.(m) ?? m);
  return [...new Set(rewritten)];
}

async function defaultProbeRequest(
  spec: StaticKeyProviderSpec,
  key: string,
): Promise<RecoveryProbeResult> {
  const meta = STATIC_PROVIDER_META[spec.id];
  const dispatcher = meta.egress === "direct" ? directEgressDispatcher() : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (spec.authScheme === "x-api-key") headers["x-api-key"] = key;
  else headers.authorization = `Bearer ${key}`;

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
      // model 字面量退役 → 换下一个候选。
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true, statusCode, error: null, model };
      }
      if (res.statusCode !== 400 && res.statusCode !== 404) {
        return { ok: false, statusCode, error, model };
      }
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 200);
      return { ok: false, statusCode: null, error, model };
    }
  }
  return { ok: false, statusCode, error, model };
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

  const byId = new Map<string, StaticKeyProviderSpec>(
    STATIC_KEY_PROVIDERS.map((p) => [p.id, p]),
  );

  let stopped = false;
  let inflight: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    const r = await q<{ provider_id: string; health_status: string | null; health_mode: string }>(
      "SELECT provider_id, health_status, health_mode FROM provider_ops",
    );
    for (const row of r.rows) {
      if (stopped) return;
      // 过滤在代码而非 SQL:单测可注入任意 ops 行;全表 ≤9 行,无谓再压查询。
      if (row.health_mode !== "auto" || row.health_status !== "degraded") continue;
      const spec = byId.get(row.provider_id);
      if (!spec) continue; // 非静态 provider(account-pool 体系)不在本系统治理面
      const key = opts.staticProviderKeys[spec.id];
      if (!key) continue; // 缺 key 无法探活:保持降级(与 proxy not_configured 拒绝口径一致)
      const res = await probeRequest(spec, key);
      if (res.ok) {
        recordSuccess(spec.id, res.model);
        log.info("recovery_probe_ok", { provider: spec.id, status: res.statusCode, model: res.model });
      } else {
        log.warn("recovery_probe_failed", {
          provider: spec.id,
          status: res.statusCode,
          error: res.error,
          model: res.model,
        });
      }
    }
  }

  function scheduleTick(): Promise<void> {
    if (inflight) return inflight; // in-flight guard:极端超时一轮可 9×30s,防 tick 重叠
    inflight = runTick()
      .catch((err: unknown) => {
        log.warn("recovery_prober_tick_failed", {
          err: String((err as Error)?.message ?? err),
        });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (!stopped) void scheduleTick();
  }, intervalMs);
  timer.unref?.();
  void scheduleTick(); // runOnStart:部署后处于降级中的 provider 立即开始积累恢复证据

  log.info("recovery_prober_started", { intervalMs, providers: STATIC_KEY_PROVIDERS.length });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: scheduleTick,
  };
}

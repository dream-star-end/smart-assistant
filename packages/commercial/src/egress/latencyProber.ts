/**
 * 静态 provider 上游网络延迟探测器(0105,admin「模型与服务商」页数据源)。
 *
 * 语义红线:
 * - 这是 **transport 延迟**(DNS+TCP+TLS+服务端首响):GET 上游 /v1/messages 端点,预期
 *   4xx/405 —— **不发推理请求,零 token/配额消耗**;任何 HTTP 响应都算 ok(网络路径通),
 *   status_code 入库仅供观察。ok=true **不**代表订阅有效/key 有效(Codex 评审确认口径)。
 * - dispatcher 严格复刻真实流量出口语义(STATIC_PROVIDER_META.egress:
 *   direct → directEgressDispatcher() 无代理直连;proxy → undefined 落全局
 *   EnvHttpProxyAgent 日本节点)—— 测别的路径得到的延迟没有运维意义。
 * - key 未配置的 provider 跳过不写样本(admin 页有独立的 keyConfigured badge)。
 *
 * 保留:每 tick 顺手 DELETE 7 天前样本(5 provider × ~288 样本/天,总量恒 ~1 万行)。
 * env:COMMERCIAL_LATENCY_PROBE_DISABLED=1 关;COMMERCIAL_LATENCY_PROBE_INTERVAL_MS 调周期
 * (缺省 300s,夹在 [30s, 1h];egress 进程 env 直读,与 EGRESS_DRAIN_MS 同款先例)。
 */

import { request } from "undici";
import { STATIC_KEY_PROVIDERS, type StaticProviderKeys } from "@openclaude/protocol";
import { STATIC_PROVIDER_META } from "../http/proxy/staticProviderMeta.js";
import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import { query } from "../db/queries.js";

const PROBE_TIMEOUT_MS = 10_000;
const RETENTION_DAYS = 7;

export interface LatencyProberHandle {
  stop(): void;
  /** 手动触发一轮(测试/运维用);正常由 interval 驱动。 */
  runNow(): Promise<void>;
}

export function startLatencyProber(opts: {
  staticProviderKeys: StaticProviderKeys;
  log: { info: (msg: string, extra?: Record<string, unknown>) => void; warn: (msg: string, extra?: Record<string, unknown>) => void };
}): LatencyProberHandle | null {
  if (process.env.COMMERCIAL_LATENCY_PROBE_DISABLED === "1") {
    opts.log.info("latency_prober_disabled");
    return null;
  }
  const raw = Number(process.env.COMMERCIAL_LATENCY_PROBE_INTERVAL_MS ?? 300_000);
  const intervalMs = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? raw : 300_000, 30_000), 3_600_000);

  let stopped = false;

  const probeOne = async (specIdx: number): Promise<void> => {
    const spec = STATIC_KEY_PROVIDERS[specIdx];
    const key = opts.staticProviderKeys[spec.id];
    if (!key) return; // 缺 key 不探测:admin 页 keyConfigured badge 单独表达
    const meta = STATIC_PROVIDER_META[spec.id];
    const dispatcher = meta.egress === "direct" ? directEgressDispatcher() : undefined;
    const t0 = process.hrtime.bigint();
    let ok = false;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await request(spec.upstreamEndpoint, {
        method: "GET",
        dispatcher,
        headersTimeout: PROBE_TIMEOUT_MS,
        bodyTimeout: PROBE_TIMEOUT_MS,
      });
      statusCode = res.statusCode;
      ok = true; // 任何 HTTP 响应 = 网络路径通(transport 语义,见文件头)
      await res.body.dump().catch(() => {});
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 200);
    }
    const latencyMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    await query(
      `INSERT INTO provider_latency_samples (provider_id, latency_ms, ok, status_code, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [spec.id, latencyMs, ok, statusCode, error],
    );
  };

  let running = false; // in-flight guard:全员超时一轮可近 50s,防最小 interval(30s)下 tick 重叠
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      for (let i = 0; i < STATIC_KEY_PROVIDERS.length; i++) {
        if (stopped) return;
        await probeOne(i);
      }
      await query(
        `DELETE FROM provider_latency_samples WHERE probed_at < NOW() - make_interval(days => $1)`,
        [RETENTION_DAYS],
      );
    } catch (err) {
      // 探测器任何失败都不能影响 egress 主职(在飞 LLM 流);只告警不冒泡。
      opts.log.warn("latency_prober_tick_failed", { err: String((err as Error)?.message ?? err) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick(); // runOnStart:部署/重启后 admin 页不用等一个周期才有数据

  opts.log.info("latency_prober_started", { intervalMs, providers: STATIC_KEY_PROVIDERS.length });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tick,
  };
}

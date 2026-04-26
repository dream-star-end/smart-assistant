/**
 * compute_host 磁盘水位监控(remote-only,5min 轮询)。
 *
 * 与 alertRules.ts 的 PolledRule 框架解耦 —— 那套是为同步 DB rule 设计的,
 * 这里需要 SSH/IO + 5min cadence,塞进去会污染 snapshot 模型。所以独立 setInterval。
 *
 * 边界:
 *   - 只覆盖 `name != 'self'` 的 ready host。self host 走 node_exporter / 本地监控。
 *   - SSH 失败不 enqueue 错误告警(SSH 失败本身有 host bootstrap / health 路径覆盖)。
 *   - 不发 resolved 通知(磁盘从 90% → 70% 是日常,刷 resolved 制造噪音)。
 *   - dedupe_key 按 host + severity + 1h 桶,同一 host 同一严重度 1h 内只 1 条。
 *
 * 阈值由 system_settings 控:
 *   - alerts_disk_high_warn_pct(默认 85)
 *   - alerts_disk_high_critical_pct(默认 95)
 *
 * 单次 SSH 5s timeout,3 host × 1 次/5min × <1s/次 = 极轻量。
 */

import { EVENTS } from "../admin/alertEvents.js";
import { enqueueAlert as _enqueueAlert } from "../admin/alertOutbox.js";
import { query as _query } from "../db/queries.js";
import { listAllHosts as _listAllHosts } from "./queries.js";
import { decryptSshPassword as _decryptSshPassword } from "./crypto.js";
import { sshRun, type SshTarget } from "./sshExec.js";
import type { Logger } from "../logging/logger.js";
import { rootLogger } from "../logging/logger.js";

/** 默认 5 分钟一次。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** 单 host SSH 超时 5s —— `df -P /` 必须秒级返回,慢于此说明机器有问题。 */
const SSH_TIMEOUT_MS = 5_000;

const DEFAULT_WARN_PCT = 85;
const DEFAULT_CRITICAL_PCT = 95;

export type DiskSeverity = "warning" | "critical" | null;

export interface DiskMonitorOptions {
  /** 默认 5min。测试可调小。 */
  intervalMs?: number;
  /** 测试注入的 sshRun fake。 */
  sshRunFn?: typeof sshRun;
  /** 测试注入 logger。 */
  logger?: Logger;
  /**
   * 测试注入。生产无需传 —— Node 20 不支持 `mock.module`,故把模块依赖
   * 暴露成可选 opts 字段(对齐 imageDistribute._pruneRemoteStaleImages 的 DI 模式)。
   */
  _deps?: {
    listAllHosts?: typeof _listAllHosts;
    decryptSshPassword?: typeof _decryptSshPassword;
    enqueueAlert?: typeof _enqueueAlert;
    query?: typeof _query;
  };
}

export interface DiskMonitorHandle {
  /** 优雅停机:清 timer 并 await 当前 inflight tick(对齐 ilinkAlertWorker.stop)。 */
  stop(): Promise<void>;
  /** 暴露给测试:手动跑一轮,await 完成后断言 enqueue 副作用。 */
  _runOnce(): Promise<void>;
}

/**
 * 解析 `df -P /` 的 Use% 列。期望输入是单个百分号字串 `"83%"` 或 `"83%\n"`。
 * 失败返 null(空白 / 无 % / NaN)。
 */
export function parseDfOutput(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!trimmed.endsWith("%")) return null;
  const numStr = trimmed.slice(0, -1).trim();
  const n = Number(numStr);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.floor(n);
}

/**
 * 决策:>= critical → "critical";>= warn → "warning";否则 null(不告警)。
 */
export function decideSeverity(
  pct: number,
  warnPct: number,
  critPct: number,
): DiskSeverity {
  if (pct >= critPct) return "critical";
  if (pct >= warnPct) return "warning";
  return null;
}

/** 1 小时桶,用于 dedupe_key。 */
function hourBucket(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/**
 * 启动监控。多次调用是幂等的:首次启动后再调返回的 handle 是同一个。
 * (但本函数本身不维护单例 — 上层 startAlertScheduler 自己保证只调 1 次。)
 */
export function startComputeHostDiskMonitor(
  opts: DiskMonitorOptions = {},
): DiskMonitorHandle {
  const interval = Math.max(10_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sshRunFn = opts.sshRunFn ?? sshRun;
  const logger = opts.logger ?? rootLogger.child({ mod: "compute-disk-monitor" });
  const listAllHostsFn = opts._deps?.listAllHosts ?? _listAllHosts;
  const decryptFn = opts._deps?.decryptSshPassword ?? _decryptSshPassword;
  const enqueueFn = opts._deps?.enqueueAlert ?? _enqueueAlert;
  const queryFn = opts._deps?.query ?? _query;

  let stopped = false;
  let inflight: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    let warnPct = DEFAULT_WARN_PCT;
    let critPct = DEFAULT_CRITICAL_PCT;
    try {
      warnPct = await readPctSetting(queryFn, "alerts_disk_high_warn_pct", DEFAULT_WARN_PCT);
      critPct = await readPctSetting(queryFn, "alerts_disk_high_critical_pct", DEFAULT_CRITICAL_PCT);
    } catch (err) {
      logger.warn?.("[disk-monitor] read settings failed; using defaults", { err: String(err) });
    }

    let hosts;
    try {
      hosts = await listAllHostsFn();
    } catch (err) {
      logger.warn?.("[disk-monitor] listAllHosts failed", { err: String(err) });
      return;
    }
    const targets = hosts.filter((h) => h.status === "ready" && h.name !== "self");
    if (targets.length === 0) return;

    await Promise.allSettled(
      targets.map((row) =>
        checkOneHost(row, warnPct, critPct, sshRunFn, decryptFn, enqueueFn, logger),
      ),
    );
  }

  function scheduleTick(): Promise<void> {
    if (inflight) return inflight; // inFlight guard:上一轮没结束就跳过
    inflight = runOnce()
      .catch((err) => {
        logger.warn?.("[disk-monitor] tick failed", { err: String(err) });
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void scheduleTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (inflight) {
        try { await inflight; } catch { /* */ }
      }
    },
    _runOnce: scheduleTick,
  };
}

async function checkOneHost(
  row: Awaited<ReturnType<typeof _listAllHosts>>[number],
  warnPct: number,
  critPct: number,
  sshRunFn: typeof sshRun,
  decryptFn: typeof _decryptSshPassword,
  enqueueFn: typeof _enqueueAlert,
  logger: Logger,
): Promise<void> {
  let password: Buffer;
  try {
    password = decryptFn(row.id, row.ssh_password_nonce, row.ssh_password_ct);
  } catch (err) {
    logger.warn?.("[disk-monitor] decrypt password failed", {
      host_id: row.id,
      host_name: row.name,
      err: String(err),
    });
    return;
  }
  try {
    const target: SshTarget = {
      host: row.host,
      port: row.ssh_port,
      username: row.ssh_user,
      password,
      knownHostsContent: null,
    };
    let result;
    try {
      // -P 强制 POSIX 输出格式;awk 取第 5 列(Use%)
      result = await sshRunFn(target, "df -P / | awk 'NR==2{print $5}'", SSH_TIMEOUT_MS);
    } catch (err) {
      logger.warn?.("[disk-monitor] ssh failed", {
        host_id: row.id,
        host_name: row.name,
        err: String(err),
      });
      return;
    }
    const pct = parseDfOutput(result.stdout);
    if (pct === null) {
      logger.warn?.("[disk-monitor] parse df output failed", {
        host_id: row.id,
        host_name: row.name,
        stdout: result.stdout.slice(0, 200),
      });
      return;
    }
    const severity = decideSeverity(pct, warnPct, critPct);
    if (severity === null) return;

    // 阻塞等 INSERT 完成 —— 与 alertRules.ts 同款 polled-rule 投递语义,确保
     // 5min tick 结束时已落 outbox。失败不抛(FK race / DB blip),只 warn。
     try {
       await enqueueFn({
         event_type: EVENTS.COMPUTE_HOST_DISK_HIGH,
         severity,
         title: `compute_host 磁盘${severity === "critical" ? "告急" : "告警"} — ${row.name} ${pct}%`,
         body:
           `host=${row.name}(${row.id})根分区 \`/\` 使用率 **${pct}%** ` +
           `(阈值 warn=${warnPct}% / critical=${critPct}%)。` +
           `\n\n建议:登录该 host 排查 \`docker system df\` / 大日志 / 镜像堆积。` +
           `若在多租户机器上,留意是否影响同节点其他工作负载。`,
         payload: {
           host_id: row.id,
           host_name: row.name,
           used_pct: pct,
           warn_pct: warnPct,
           critical_pct: critPct,
           mount: "/",
         },
         dedupe_key: `health.compute_host_disk_high:${row.id}:${severity}:${hourBucket()}`,
       });
     } catch (err) {
       logger.warn?.("[disk-monitor] enqueue alert failed", {
         host_id: row.id,
         host_name: row.name,
         err: String(err),
       });
     }
  } finally {
    password.fill(0);
  }
}

/**
 * 直接 SQL 读取阈值,与 alertRules.ts 保持同款 fallback-safe 模式 ——
 * 避免依赖 systemSettings allowlist 注册(那是更大的产品决策,留待运维要 UI 时再做)。
 */
async function readPctSetting(
  queryFn: typeof _query,
  key: string,
  fallback: number,
): Promise<number> {
  try {
    const r = await queryFn<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      [key],
    );
    if (r.rows.length === 0) return fallback;
    const v = r.rows[0].value;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

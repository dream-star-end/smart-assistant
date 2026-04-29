/**
 * compute_host 主机层 metrics 监控(5min 轮询,SSH 远端 + 本地 self host)。
 *
 * 0030/0031 起这里只跑 `df -P /` 一项(故文件名 *DiskMonitor*);0045 起扩
 * 至 4 维度 — disk / mem / load1 / cpu_count + 一次成功的 metrics_at,所有
 * 写入 `compute_hosts` 5 列。文件名保留以减少 git churn,导出 alias 提供
 * `startComputeHostMetricsMonitor` 给新 caller 用,旧的 `startComputeHostDiskMonitor`
 * 保持向后兼容继续工作。
 *
 * 与 alertRules.ts 的 PolledRule 框架解耦 —— 那套是为同步 DB rule 设计的,
 * 这里需要 SSH/IO + 5min cadence,塞进去会污染 snapshot 模型。所以独立 setInterval。
 *
 * 边界:
 *   - 远端 host(`name != 'self'`)走 SSH;self host 走本地 child_process.exec。
 *   - 单 host 失败被隔离:Promise.allSettled 包裹,不影响其他 host tick。
 *   - all-or-nothing 解析:4 行任一失败 → 跳过 UPDATE 与 disk 告警(下一轮再试)。
 *   - 不发 resolved 通知(磁盘从 90% → 70% 是日常,刷 resolved 制造噪音)。
 *   - dedupe_key 按 host + severity + 1h 桶,同一 host 同一严重度 1h 内只 1 条。
 *
 * 阈值由 system_settings 控:
 *   - alerts_disk_high_warn_pct(默认 85)
 *   - alerts_disk_high_critical_pct(默认 95)
 *
 * 单次 SSH/local exec 5s timeout。
 */

import { exec as _execCb } from "node:child_process";
import { promisify } from "node:util";
import { EVENTS } from "../admin/alertEvents.js";
import { enqueueAlert as _enqueueAlert } from "../admin/alertOutbox.js";
import { getPool } from "../db/index.js";
import { query as _query } from "../db/queries.js";
import { listAllHosts as _listAllHosts } from "./queries.js";
import { decryptSshPassword as _decryptSshPassword } from "./crypto.js";
import { sshRun, type SshTarget } from "./sshExec.js";
import type { Logger } from "../logging/logger.js";
import { rootLogger } from "../logging/logger.js";

const exec = promisify(_execCb);

/** 默认 5 分钟一次。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** 单 host SSH/local 超时 5s —— 4 行命令必须秒级返回,慢于此说明机器有问题。 */
const SSH_TIMEOUT_MS = 5_000;

/**
 * 4 维度采集命令:每行一个值,顺序固定。
 *   line 1:`df -P /` 第 5 列 Use% (例 "83%")
 *   line 2:`free -m` 已用/总内存比 (例 "42")
 *   line 3:`/proc/loadavg` 第 1 列 (例 "0.21")
 *   line 4:`nproc` (例 "4")
 *
 * 用 `;` 串接,任一失败下游仍打印,解析层做 all-or-nothing 兜底。
 */
const METRICS_COMMAND =
  "df -P / | awk 'NR==2{print $5}'; " +
  "free -m | awk '/^Mem:/{printf \"%d\\n\",($3/$2)*100}'; " +
  "cut -d' ' -f1 /proc/loadavg; " +
  "nproc";

const DEFAULT_WARN_PCT = 85;
const DEFAULT_CRITICAL_PCT = 95;

export type DiskSeverity = "warning" | "critical" | null;

export interface MetricsSample {
  diskPct: number;
  memPct: number;
  load1: number;
  cpuCount: number;
}

export interface DiskMonitorOptions {
  /** 默认 5min。测试可调小。 */
  intervalMs?: number;
  /** 测试注入的 sshRun fake。 */
  sshRunFn?: typeof sshRun;
  /** 测试注入的 local exec(self host)。返回 stdout 字符串。 */
  localExecFn?: (cmd: string, timeoutMs: number) => Promise<{ stdout: string }>;
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
    /** 注入 UPDATE compute_hosts metrics 的 SQL runner(测试用,默认走 getPool().query)。 */
    updateMetrics?: (hostId: string, sample: MetricsSample) => Promise<void>;
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
 * 解析 4 行 stdout(METRICS_COMMAND 输出顺序)→ MetricsSample。
 * 任一行失败整体返 null(all-or-nothing,见文件头)。
 *
 * 容忍空白行、CRLF、行尾空格。容忍 mem_pct 因 free 整数舍入到 100(不夹断)。
 */
export function parseMetricsOutput(stdout: string): MetricsSample | null {
  // 把 \r\n 标准化为 \n,过滤纯空行(防 free 在某些容器输出空首行)
  const lines = stdout.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 4) return null;
  const diskPct = parseDfOutput(lines[0]!);
  if (diskPct === null) return null;
  const memPct = parsePctInt(lines[1]!);
  if (memPct === null) return null;
  const load1 = parseFloatStr(lines[2]!);
  if (load1 === null) return null;
  const cpuCount = parseIntStr(lines[3]!);
  if (cpuCount === null || cpuCount < 1) return null;
  return { diskPct, memPct, load1, cpuCount };
}

function parsePctInt(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.floor(n);
}

function parseFloatStr(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
  // 2 位小数(与 NUMERIC(6,2) 对齐)
  return Math.round(n * 100) / 100;
}

function parseIntStr(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1024) return null;
  return n;
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
  const localExecFn =
    opts.localExecFn ??
    (async (cmd: string, timeoutMs: number) => {
      // 与 sshRun 返回签名对齐(只取 stdout)。bash -c 是为了 ; 串接命令统一行为。
      const r = await exec(cmd, { timeout: timeoutMs, shell: "/bin/bash" });
      return { stdout: typeof r.stdout === "string" ? r.stdout : r.stdout.toString("utf8") };
    });
  const logger = opts.logger ?? rootLogger.child({ mod: "compute-metrics-monitor" });
  const listAllHostsFn = opts._deps?.listAllHosts ?? _listAllHosts;
  const decryptFn = opts._deps?.decryptSshPassword ?? _decryptSshPassword;
  const enqueueFn = opts._deps?.enqueueAlert ?? _enqueueAlert;
  const queryFn = opts._deps?.query ?? _query;
  const updateMetricsFn =
    opts._deps?.updateMetrics ??
    (async (hostId: string, sample: MetricsSample) => {
      await getPool().query(
        `UPDATE compute_hosts
            SET disk_pct = $2, mem_pct = $3, load1 = $4, cpu_count = $5,
                metrics_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [hostId, sample.diskPct, sample.memPct, sample.load1, sample.cpuCount],
      );
    });

  let stopped = false;
  let inflight: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    let warnPct = DEFAULT_WARN_PCT;
    let critPct = DEFAULT_CRITICAL_PCT;
    try {
      warnPct = await readPctSetting(queryFn, "alerts_disk_high_warn_pct", DEFAULT_WARN_PCT);
      critPct = await readPctSetting(queryFn, "alerts_disk_high_critical_pct", DEFAULT_CRITICAL_PCT);
    } catch (err) {
      logger.warn?.("[metrics-monitor] read settings failed; using defaults", { err: String(err) });
    }

    let hosts;
    try {
      hosts = await listAllHostsFn();
    } catch (err) {
      logger.warn?.("[metrics-monitor] listAllHosts failed", { err: String(err) });
      return;
    }
    // 0045: 0030 时跳过 self,因 self 没 SSH 凭据。本版起 self 走本地 exec,纳入采集。
    const targets = hosts.filter((h) => h.status === "ready");
    if (targets.length === 0) return;

    await Promise.allSettled(
      targets.map((row) =>
        checkOneHost(
          row,
          warnPct,
          critPct,
          sshRunFn,
          localExecFn,
          decryptFn,
          enqueueFn,
          updateMetricsFn,
          logger,
        ),
      ),
    );
  }

  function scheduleTick(): Promise<void> {
    if (inflight) return inflight; // inFlight guard:上一轮没结束就跳过
    inflight = runOnce()
      .catch((err) => {
        logger.warn?.("[metrics-monitor] tick failed", { err: String(err) });
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

  // 0045: startup 立刻 tick 一次,避免重启后 5min 内 admin UI metrics 全 NULL。
  // 走 setImmediate 确保不阻塞 startAlertScheduler 的同步返回。
  setImmediate(() => {
    if (stopped) return;
    void scheduleTick();
  });

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

/** 0045: 新名,语义更准。旧名保留向后兼容。 */
export const startComputeHostMetricsMonitor = startComputeHostDiskMonitor;

async function checkOneHost(
  row: Awaited<ReturnType<typeof _listAllHosts>>[number],
  warnPct: number,
  critPct: number,
  sshRunFn: typeof sshRun,
  localExecFn: (cmd: string, timeoutMs: number) => Promise<{ stdout: string }>,
  decryptFn: typeof _decryptSshPassword,
  enqueueFn: typeof _enqueueAlert,
  updateMetricsFn: (hostId: string, sample: MetricsSample) => Promise<void>,
  logger: Logger,
): Promise<void> {
  const isSelf = row.name === "self";
  let result: { stdout: string };

  if (isSelf) {
    try {
      result = await localExecFn(METRICS_COMMAND, SSH_TIMEOUT_MS);
    } catch (err) {
      logger.warn?.("[metrics-monitor] local exec failed (self)", {
        host_id: row.id,
        err: String(err),
      });
      return;
    }
  } else {
    let password: Buffer;
    try {
      password = decryptFn(row.id, row.ssh_password_nonce, row.ssh_password_ct);
    } catch (err) {
      logger.warn?.("[metrics-monitor] decrypt password failed", {
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
      try {
        result = await sshRunFn(target, METRICS_COMMAND, SSH_TIMEOUT_MS);
      } catch (err) {
        logger.warn?.("[metrics-monitor] ssh failed", {
          host_id: row.id,
          host_name: row.name,
          err: String(err),
        });
        return;
      }
    } finally {
      password.fill(0);
    }
  }

  const sample = parseMetricsOutput(result.stdout);
  if (sample === null) {
    logger.warn?.("[metrics-monitor] parse output failed", {
      host_id: row.id,
      host_name: row.name,
      stdout: result.stdout.slice(0, 200),
    });
    return;
  }

  // 1) UPDATE compute_hosts metrics 列(失败 warn 但不阻断告警判定)
  try {
    await updateMetricsFn(row.id, sample);
  } catch (err) {
    logger.warn?.("[metrics-monitor] update metrics failed", {
      host_id: row.id,
      host_name: row.name,
      err: String(err),
    });
  }

  // 2) disk 阈值告警(沿用 0030 时期语义)
  const severity = decideSeverity(sample.diskPct, warnPct, critPct);
  if (severity !== null) {
    try {
      await enqueueFn({
        event_type: EVENTS.COMPUTE_HOST_DISK_HIGH,
        severity,
        title: `compute_host 磁盘${severity === "critical" ? "告急" : "告警"} — ${row.name} ${sample.diskPct}%`,
        body:
          `host=${row.name}(${row.id})根分区 \`/\` 使用率 **${sample.diskPct}%** ` +
          `(阈值 warn=${warnPct}% / critical=${critPct}%)。` +
          `\n\n建议:登录该 host 排查 \`docker system df\` / 大日志 / 镜像堆积。` +
          `若在多租户机器上,留意是否影响同节点其他工作负载。`,
        payload: {
          host_id: row.id,
          host_name: row.name,
          used_pct: sample.diskPct,
          warn_pct: warnPct,
          critical_pct: critPct,
          mount: "/",
        },
        dedupe_key: `health.compute_host_disk_high:${row.id}:${severity}:${hourBucket()}`,
      });
    } catch (err) {
      logger.warn?.("[metrics-monitor] enqueue alert failed", {
        host_id: row.id,
        host_name: row.name,
        err: String(err),
      });
    }
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

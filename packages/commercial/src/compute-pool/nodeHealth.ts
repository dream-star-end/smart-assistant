/**
 * nodeHealth — 定时 health poll 所有非 self host。
 *
 * 状态机由 queries.markHealth 处理:
 *   ready + 3 连败 → quarantined
 *   quarantined + 3 连成功 → ready
 *
 * 本模块只负责:
 *   - 按 ready / quarantined 两种 status 调 /health RPC
 *   - 写回 DB(通过 markHealth 原子事务)
 *   - 自动续期 cert:notAfter 距今 < 30d → 触发 renewal 流程
 */

import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import {
  healthCheck,
  hostRowToTarget,
  requestRenewCert,
  deliverRenewedCert,
} from "./nodeAgentClient.js";
import { signHostLeafCsr } from "./certAuthority.js";
import { randomBytes, randomUUID } from "node:crypto";

const log = rootLogger.child({ subsys: "node-health" });

/** 单次 health 循环的目标集合:status ∈ {ready, quarantined}。 */
const TARGET_STATUSES = ["ready", "quarantined"] as const;

/** cert 还剩几天就触发续期。 */
const RENEW_WINDOW_DAYS = 30;

export interface HealthPollerOptions {
  intervalMs?: number;
  /** 单次 /health 超时(ms)。默认 5s。 */
  perHostTimeoutMs?: number;
  /** 允许并发 poll 的 host 数。默认 4。 */
  concurrency?: number;
}

export class HealthPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private opts: HealthPollerOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      if (!this.running) {
        this.running = true;
        try {
          await this.pollOnce();
        } catch (e) {
          log.error("health poll batch failed", {
            err: e instanceof Error ? e.message : String(e),
          });
        } finally {
          this.running = false;
        }
      }
      this.timer = setTimeout(tick, this.opts.intervalMs ?? 30_000);
    };
    this.timer = setTimeout(tick, 1_000); // 1s 后第一次跑
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 外部可直接调一次 poll,用于测试或管理触发。 */
  async pollOnce(): Promise<void> {
    // 列出全部 host 并过滤 target statuses
    const rows = await queries.listAllHosts();
    const targets = rows.filter((r) =>
      (TARGET_STATUSES as readonly string[]).includes(r.status) && r.name !== "self",
    );
    if (targets.length === 0) return;

    const concurrency = this.opts.concurrency ?? 4;
    // 简单分批
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.allSettled(batch.map((row) => this.pollHost(row.id)));
    }
  }

  private async pollHost(hostId: string): Promise<void> {
    const row = await queries.getHostById(hostId);
    if (!row) return;
    const target = hostRowToTarget(row);
    const operationId = randomUUID();
    const actor = "system:healthPoller";
    try {
      const r = await healthCheck(target);
      const { previousStatus, nextStatus } = await queries.applyHealthSnapshot(hostId, {
        endpointOk: r.ok,
        endpointErr: r.ok ? null : "health ok=false",
        uplinkOk: r.uplinkOk,
        uplinkErr: r.uplinkErr ?? null,
        egressOk: r.egressProbeOk,
        egressErr: r.egressProbeErr ?? null,
        // plan v4 round-2:string|undefined,不要 ?? null;applyHealthSnapshot
        // 只在 string 时才把值写回 row.loaded_image_id(undefined = "agent 没报",
        // 不能把 DB 已知值清成 NULL)。
        loadedImageId: typeof r.loadedImageId === "string" ? r.loadedImageId : undefined,
        loadedImageTag: r.loadedImageTag ?? null,
        operationId,
        actor,
      });
      if (nextStatus !== previousStatus) {
        log.info("host status transition", {
          hostId,
          from: previousStatus,
          to: nextStatus,
          containers: r.containerCount,
        });
      }
      // 并行:cert renewal 检查
      if (r.ok) {
        await this.maybeRenewCert(row).catch((e) =>
          log.error("cert renewal failed", {
            hostId,
            err: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // RPC 失败 → 仅 endpoint 维度已知,其它维度未知(undefined)
      await queries
        .applyHealthSnapshot(hostId, {
          endpointOk: false,
          endpointErr: msg.slice(0, 500),
          operationId,
          actor,
        })
        .catch(() => {
          /* swallow to avoid cascade */
        });
    } finally {
      if (target.psk) target.psk.fill(0);
    }
  }

  /** cert notAfter 距今 < 30d → 触发续期 RPC。 */
  private async maybeRenewCert(row: Awaited<ReturnType<typeof queries.getHostById>>): Promise<void> {
    if (!row || !row.agent_cert_not_after) return;
    const notAfter = row.agent_cert_not_after;
    const daysLeft = (notAfter.getTime() - Date.now()) / 86_400_000;
    if (daysLeft > RENEW_WINDOW_DAYS) return;

    log.info("cert approaching expiry, triggering renewal", {
      hostId: row.id,
      daysLeft: daysLeft.toFixed(1),
    });
    const target = hostRowToTarget(row);
    try {
      const nonce = randomBytes(32).toString("hex");
      const { csrPem } = await requestRenewCert(target, nonce);
      const signed = await signHostLeafCsr(row.id, csrPem);
      await deliverRenewedCert(target, nonce, signed.certPem);
      await queries.updateCert({
        id: row.id,
        certPem: signed.certPem,
        fingerprintSha256: signed.fingerprintSha256,
        notBefore: signed.notBefore,
        notAfter: signed.notAfter,
      });
      log.info("cert renewed", { hostId: row.id, newNotAfter: signed.notAfter.toISOString() });
    } finally {
      if (target.psk) target.psk.fill(0);
    }
  }
}

// 单例 helper(service 启动时 new 并 start)
let _instance: HealthPoller | null = null;
export function getHealthPoller(opts?: HealthPollerOptions): HealthPoller {
  if (!_instance) {
    _instance = new HealthPoller(opts);
  }
  return _instance;
}

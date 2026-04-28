/**
 * compute-pool master init(0042)。
 *
 * 在 commercial gateway 启动早期(在 HTTP listen 之前的合理位置)调用 initComputePool。
 * 完成:
 *   1. 读 OC_RUNTIME_IMAGE → docker inspect → 算 desiredImageId
 *   2. setDesiredImage(写到 compute_pool_state 单例 + epoch++)
 *   3. setLoadedImage(self_host_id, ...) — self host 的镜像 = master 的本地镜像
 *   4. 触发一次 backfill:并行 4 路 / 单 host 30s 超时 / 整体 5min 超时,
 *      对每台非-self host 拉一次 /health → applyHealthSnapshot 写各维度
 *   5. 触发一次 imagePromote(同步,不并发到 backfill — 避免 distribute 把还没 health
 *      的 host 状态搞乱)
 *
 * "open placement gate" 是 SQL 谓词的副作用 — 只要 compute_pool_state.desired_image_id
 * 非空,gate 就开了;具体哪些 host 通过 gate 由 last_*_at 新鲜度决定。
 *
 * 如果 OC_RUNTIME_IMAGE 没配 / docker inspect 失败 → init 写一行 audit 跳过,master
 * 仍然启动(单 host / dev 兼容);此时 listSchedulableHosts 永远返回空(desiredImageId
 * 为 NULL → SELECT 不命中)。运维需在容器化部署里保证 image 就位。
 */

import { randomUUID } from "node:crypto";
import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import { healthCheck, hostRowToTarget } from "./nodeAgentClient.js";
import { writeAuditStandalone } from "./audit.js";
import { getPool } from "../db/index.js";
import { setDesiredImage } from "./poolState.js";
import { inspectLocalImageId, promoteOnce } from "./imagePromote.js";
import type { ComputeHostRow } from "./types.js";

const log = rootLogger.child({ subsys: "pool-init" });

export interface InitOptions {
  /** OC_RUNTIME_IMAGE。空 → 跳过整套 init,gate 永久关。 */
  imageTag?: string;
  /** 整体 backfill 超时(ms)。默认 5min。 */
  backfillTotalMs?: number;
  /** 单 host probe 超时(ms)。默认 30s。 */
  perHostMs?: number;
  /** 并发 probe 数。默认 4。 */
  concurrency?: number;
}

export interface InitResult {
  desiredImageId: string | null;
  selfSynced: boolean;
  backfillHosts: number;
  backfillSucceeded: number;
  backfillSkipped: number;
  backfillTimedOut: boolean;
  promoteRan: boolean;
}

export async function initComputePool(opts: InitOptions = {}): Promise<InitResult> {
  const operationId = randomUUID();
  const actor = "system:initComputePool";
  const imageTag = opts.imageTag ?? process.env.OC_RUNTIME_IMAGE?.trim() ?? "";
  const backfillTotalMs = opts.backfillTotalMs ?? 5 * 60_000;
  const perHostMs = opts.perHostMs ?? 30_000;
  const concurrency = opts.concurrency ?? 4;

  const result: InitResult = {
    desiredImageId: null,
    selfSynced: false,
    backfillHosts: 0,
    backfillSucceeded: 0,
    backfillSkipped: 0,
    backfillTimedOut: false,
    promoteRan: false,
  };

  if (!imageTag) {
    log.warn("OC_RUNTIME_IMAGE empty — placement gate will stay closed (no image desired)");
    await writeAuditStandalone(getPool(), {
      hostId: null,
      operation: "pool.init.skip",
      operationId,
      reasonCode: null,
      detail: { reason: "no-image-tag" },
      actor,
    });
    return result;
  }

  // Step 1+2: master image inspect + setDesiredImage
  const desiredImageId = await inspectLocalImageId(imageTag);
  if (!desiredImageId) {
    log.error("master local docker inspect failed — placement gate will stay closed", { imageTag });
    await writeAuditStandalone(getPool(), {
      hostId: null,
      operation: "pool.init.skip",
      operationId,
      reasonCode: null,
      detail: { reason: "master-image-not-found", imageTag },
      actor,
    });
    return result;
  }
  result.desiredImageId = desiredImageId;
  const setRes = await setDesiredImage(desiredImageId, imageTag);
  log.info("desired image set", {
    desiredImageId,
    imageTag,
    changed: setRes.changed,
    epoch: setRes.newEpoch.toString(),
  });

  // Step 3: self host loaded_image_id sync
  try {
    const self = await queries.getSelfHost();
    await queries.setLoadedImage(self.id, desiredImageId, imageTag, {
      actor,
      operationId,
      source: "pool.init.self",
    });
    result.selfSynced = true;
  } catch (e) {
    log.error("self host loadedImage sync failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Step 4: backfill — 拉一遍非 self host 的 /health
  const allRows = await queries.listAllHosts();
  const targets = allRows.filter((r) => r.name !== "self");
  result.backfillHosts = targets.length;

  if (targets.length > 0) {
    const queue = [...targets];
    const seen = new Set<string>();
    let succeeded = 0;
    let skipped = 0;

    const oneHost = async (row: ComputeHostRow): Promise<void> => {
      seen.add(row.id);
      const target = hostRowToTarget(row);
      try {
        const r = await Promise.race([
          healthCheck(target),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`per-host timeout after ${perHostMs}ms`)), perHostMs),
          ),
        ]);
        await queries.applyHealthSnapshot(row.id, {
          endpointOk: r.ok,
          endpointErr: r.ok ? null : "health ok=false",
          uplinkOk: r.uplinkOk,
          uplinkErr: r.uplinkErr ?? null,
          egressOk: r.egressProbeOk,
          egressErr: r.egressProbeErr ?? null,
          // plan v4 round-2:contract 是 string|undefined,不要 ?? null。
          // applyHealthSnapshot 仅 typeof === "string" 时写回 DB;undefined =
          // "agent 没报"保留 DB 已知值。
          loadedImageId: typeof r.loadedImageId === "string" ? r.loadedImageId : undefined,
          loadedImageTag: r.loadedImageTag ?? null,
          operationId,
          actor: "system:initComputePool.backfill",
        });
        succeeded += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await queries
          .applyHealthSnapshot(row.id, {
            endpointOk: false,
            endpointErr: msg.slice(0, 500),
            operationId,
            actor: "system:initComputePool.backfill",
          })
          .catch(() => undefined);
        skipped += 1;
      } finally {
        if (target.psk) target.psk.fill(0);
      }
    };

    const workers = (async () => {
      const pool: Promise<void>[] = [];
      for (let i = 0; i < Math.min(concurrency, targets.length); i++) {
        pool.push(
          (async () => {
            while (queue.length > 0) {
              const row = queue.shift();
              if (!row) break;
              await oneHost(row);
            }
          })(),
        );
      }
      await Promise.all(pool);
    })();

    let timedOut = false;
    await Promise.race([
      workers,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, backfillTotalMs),
      ),
    ]);
    result.backfillSucceeded = succeeded;
    result.backfillSkipped = skipped + (targets.length - seen.size);
    result.backfillTimedOut = timedOut;

    if (timedOut) {
      // 让背景任务自然完成,但不再等。生产 5min 超时已极宽,真在卡通常是 ssh hang。
      log.warn("backfill total timeout fired — gate opens with available data", {
        totalMs: backfillTotalMs,
        seen: seen.size,
        total: targets.length,
      });
    }
  }

  // Step 5: 一次 promote(distribute 把 host 与 desired 对齐)
  try {
    const r = await promoteOnce({ imageTag });
    result.promoteRan = true;
    log.info("initial image promote done", {
      changedDesired: r.changedDesired,
      hostsCount: r.hosts.length,
      summary: r.hosts.map((h) => `${h.hostName}:${h.action}`).join(","),
    });
  } catch (e) {
    log.error("initial image promote failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  await writeAuditStandalone(getPool(), {
    hostId: null,
    operation: "pool.init.done",
    operationId,
    reasonCode: null,
    detail: { ...result, desiredImageId, imageTag },
    actor,
  });

  return result;
}

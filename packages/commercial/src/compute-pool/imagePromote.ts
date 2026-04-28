/**
 * imagePromote — image desired_image_id 收敛器(0042)。
 *
 * 职责:
 *   1. master 启动时 / 周期性触发,docker inspect 本地 OC_RUNTIME_IMAGE → 算 master 期望的
 *      image config ID。写到 compute_pool_state(发生变化时 master_epoch++)。
 *   2. 自动 distribute:遍历 status IN ('ready','quarantined') 的 host,loaded_image_id 与
 *      desired 不一致 → 触发 streamImageToHost。成功 → setLoadedImage;失败 → setQuarantined
 *      (image-distribute-failed)。
 *   3. 自动 clear:之前因 image-mismatch / image-distribute-failed 进 quarantine 的 host,
 *      在某轮 promote 后 loaded_image_id 已对齐 → clearQuarantineByReason 让它重回 ready。
 *
 * 不做:
 *   - 不主动 quarantine "image-mismatch" 单独类。该 reason 仅在 imagePromote 看到
 *     loaded_image_id stale 一次循环未能 distribute 成功后,fallback 到 hard quarantine。
 *     M1 阶段 master 自身就是镜像源,distribute 同步,基本走不到这个分支。
 *   - 不动 self host(self 由 master 启动时一次性写,本地 docker = master = 一致)。
 *
 * 参数:
 *   - intervalMs:promote tick(默认 5min)
 *   - perHostTimeoutMs:单 host distribute 超时(默认 imageDistribute.DEFAULT_STREAM_TIMEOUT_MS)
 *   - concurrency:并发 distribute 数(默认 2)
 *
 * audit 流:
 *   - operation='image.promote.tick' 每轮一行(detail.host 数 / changed?)
 *   - operation='image.promote.host' 每 host 一行(detail.action='already' | 'distributed' | 'failed')
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import { decryptSshPassword } from "./crypto.js";
import { writeAuditStandalone } from "./audit.js";
import { getPool } from "../db/index.js";
import {
  streamImageToHost,
  ImageDistributeError,
  DEFAULT_STREAM_TIMEOUT_MS,
} from "./imageDistribute.js";
import { getPoolState, setDesiredImage } from "./poolState.js";
import type { ComputeHostRow } from "./types.js";

const log = rootLogger.child({ subsys: "image-promote" });

export interface ImagePromoteOptions {
  intervalMs?: number;
  perHostTimeoutMs?: number;
  concurrency?: number;
  /** master 本地 image tag(OC_RUNTIME_IMAGE)。空 → 跳过整轮。 */
  imageTag?: string;
  /**
   * plan v4 round-2:可选注入 operationId。当 v3ensureRunning ImageNotFound 路径
   * 触发本轮 promote 时,会把同一 operationId 透下来,使 setQuarantined →
   * promoteOnce → distribute / clearQuarantineByReason 的审计行串起来。
   * 未提供 → 自生成 randomUUID()。
   */
  operationId?: string;
}

/**
 * docker inspect 本地 image,取 config ID。失败 / 不存在 → null(调用方决定如何处理)。
 *
 * 直接 spawn docker CLI(commercial-v3 master 上 docker 已装,sshExec 也是这套依赖)。
 * 选 spawn 不选 dockerode 是因为 dockerode 走 unix socket 但跟 v3supervisor 共用一个
 * client 容易绑环;promote tick 走独立 CLI 更隔离。
 */
export async function inspectLocalImageId(image: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch { /* ignore */ }
      resolve(null);
    }, 30_000);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        log.debug?.("docker inspect non-zero exit", { image, code, stderr: stderr.slice(0, 256) });
        resolve(null);
        return;
      }
      const id = stdout.trim();
      resolve(id === "" ? null : id);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn?.("docker inspect spawn error", { image, err: e.message });
      resolve(null);
    });
  });
}

/**
 * 对单个 host 执行 promote 决策:
 *   - host.loaded_image_id == desired → noop(可能顺带 clear quarantine)
 *   - 不一致 → distribute → 成功 setLoadedImage + clear,失败 setQuarantined
 */
async function promoteOneHost(
  row: ComputeHostRow,
  desiredImageId: string,
  imageTag: string,
  perHostTimeoutMs: number,
  operationId: string,
): Promise<"already" | "distributed" | "failed"> {
  const actor = "system:imagePromote";

  // self 不走 distribute 逻辑。loaded_image_id 应在 master 启动时已被 init 同步;
  // 这里若 self 的 loaded 与 desired 不符,表示 master 本机 image 改了但 init 没刷,
  // 直接同步即可。
  if (row.name === "self") {
    if (row.loaded_image_id !== desiredImageId) {
      await queries.setLoadedImage(row.id, desiredImageId, imageTag, {
        actor,
        operationId,
        source: "imagePromote.self-resync",
      });
    }
    return "already";
  }

  // plan v4 round-2 BLOCKER 2 修复:runtime-image-missing 是"DB 说就位但 docker
  // run 实际撞 ImageNotFound"的 hard quarantine,DB 在撒谎;不能因 loaded_image_id
  // 表面对齐就走 already + clear。必须强制重新 distribute 以重建真实状态,
  // distribute 成功后再 clearQuarantineByReason。
  //
  // 其他 image-* hard reason(image-mismatch / image-distribute-failed)的语义是
  // "DB 已知 mismatch",此时若 loaded_image_id 恰好对齐说明上一轮 distribute 已
  // 写过 setLoadedImage,走 already + clear 是对的。
  const isRuntimeImageMissing =
    row.status === "quarantined" &&
    row.quarantine_reason_code === "runtime-image-missing";

  if (row.loaded_image_id === desiredImageId && !isRuntimeImageMissing) {
    // 已对齐。若先前因 image-mismatch / image-distribute-failed 隔离过,顺手清。
    if (
      row.status === "quarantined" &&
      (row.quarantine_reason_code === "image-mismatch" ||
        row.quarantine_reason_code === "image-distribute-failed")
    ) {
      await queries.clearQuarantineByReason(row.id, row.quarantine_reason_code, {
        actor,
        operationId,
      });
      log.info("image promote: cleared image-quarantine after id match", {
        hostId: row.id,
        reason: row.quarantine_reason_code,
      });
    }
    return "already";
  }

  if (isRuntimeImageMissing) {
    log.warn("image promote: runtime-image-missing forces re-distribute despite DB id match", {
      hostId: row.id,
      loadedImageId: row.loaded_image_id,
      desiredImageId,
    });
  }

  // 需要 distribute
  let password: Buffer | null = null;
  try {
    try {
      password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await queries.setQuarantined(row.id, {
        reason: "image-distribute-failed",
        detail: `decrypt ssh password failed: ${msg}`,
        operationId,
        actor,
      });
      return "failed";
    }
    const target = {
      host: row.host,
      port: row.ssh_port,
      username: row.ssh_user,
      password,
      knownHostsContent: null,
    };
    try {
      await streamImageToHost(target, imageTag, {
        hostId: row.id,
        timeoutMs: perHostTimeoutMs,
      });
      await queries.setLoadedImage(row.id, desiredImageId, imageTag, {
        actor,
        operationId,
        source: "imagePromote.distribute",
      });
      // 若先前因 image-* hard quarantine,distribute 成功后清
      if (
        row.status === "quarantined" &&
        (row.quarantine_reason_code === "image-mismatch" ||
          row.quarantine_reason_code === "image-distribute-failed" ||
          row.quarantine_reason_code === "runtime-image-missing")
      ) {
        await queries.clearQuarantineByReason(row.id, row.quarantine_reason_code, {
          actor,
          operationId,
        });
      }
      return "distributed";
    } catch (e) {
      const errMsg =
        e instanceof ImageDistributeError
          ? `${e.source}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      await queries.setQuarantined(row.id, {
        reason: "image-distribute-failed",
        detail: errMsg.slice(0, 500),
        operationId,
        actor,
      });
      return "failed";
    }
  } finally {
    password?.fill(0);
  }
}

/**
 * 一轮 promote:
 *   1. inspect master local imageTag → desiredImageId(失败则 noop,告警)
 *   2. setDesiredImage(可能 epoch++)
 *   3. listReadyOrQuarantinedForImagePromote → 对每个 host concurrency-N 处理
 *
 * @returns 本轮 per-host 结果摘要
 */
export interface PromoteTickResult {
  desiredImageId: string | null;
  changedDesired: boolean;
  hosts: Array<{ hostId: string; hostName: string; action: "already" | "distributed" | "failed" }>;
}

export async function promoteOnce(opts: ImagePromoteOptions): Promise<PromoteTickResult> {
  const imageTag = opts.imageTag ?? process.env.OC_RUNTIME_IMAGE?.trim() ?? "";
  const operationId = opts.operationId ?? randomUUID();
  if (!imageTag) {
    log.debug?.("OC_RUNTIME_IMAGE empty — promote tick skipped");
    return { desiredImageId: null, changedDesired: false, hosts: [] };
  }
  const desiredImageId = await inspectLocalImageId(imageTag);
  if (!desiredImageId) {
    log.warn("master local image inspect failed — promote tick aborted", { imageTag });
    await writeAuditStandalone(getPool(), {
      hostId: null,
      operation: "image.promote.tick",
      operationId,
      reasonCode: null,
      detail: { skipReason: "master-image-not-found", imageTag },
      actor: "system:imagePromote",
    });
    return { desiredImageId: null, changedDesired: false, hosts: [] };
  }

  const setRes = await setDesiredImage(desiredImageId, imageTag);
  if (setRes.changed) {
    log.info("desired image changed", {
      previousId: setRes.previous.desiredImageId,
      newId: desiredImageId,
      tag: imageTag,
      newEpoch: setRes.newEpoch.toString(),
    });
  }

  const rows = await queries.listReadyOrQuarantinedForImagePromote();
  const concurrency = opts.concurrency ?? 2;
  const perHostTimeoutMs = opts.perHostTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const results: PromoteTickResult["hosts"] = [];
  const queue = [...rows];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, rows.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) break;
          try {
            const action = await promoteOneHost(row, desiredImageId, imageTag, perHostTimeoutMs, operationId);
            results.push({ hostId: row.id, hostName: row.name, action });
          } catch (e) {
            log.error("promoteOneHost unexpectedly threw", {
              hostId: row.id,
              err: e instanceof Error ? e.message : String(e),
            });
            results.push({ hostId: row.id, hostName: row.name, action: "failed" });
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  await writeAuditStandalone(getPool(), {
    hostId: null,
    operation: "image.promote.tick",
    operationId,
    reasonCode: null,
    detail: {
      desiredImageId,
      imageTag,
      changedDesired: setRes.changed,
      newEpoch: setRes.newEpoch.toString(),
      hostCount: results.length,
      summary: results.map((r) => `${r.hostName}:${r.action}`).join(","),
    },
    actor: "system:imagePromote",
  });

  return { desiredImageId, changedDesired: setRes.changed, hosts: results };
}

export class ImagePromoteScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private opts: ImagePromoteOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.opts.intervalMs ?? 5 * 60_000;
    const tick = async () => {
      if (this.stopped) return;
      if (!this.running) {
        this.running = true;
        try {
          await promoteOnce(this.opts);
        } catch (e) {
          log.error("promote tick failed", {
            err: e instanceof Error ? e.message : String(e),
          });
        } finally {
          this.running = false;
        }
      }
      this.timer = setTimeout(tick, interval);
    };
    // 启动 60s 后开始(让 backfill 先跑)
    this.timer = setTimeout(tick, 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

let _instance: ImagePromoteScheduler | null = null;
export function getImagePromoteScheduler(opts?: ImagePromoteOptions): ImagePromoteScheduler {
  if (!_instance) _instance = new ImagePromoteScheduler(opts);
  return _instance;
}


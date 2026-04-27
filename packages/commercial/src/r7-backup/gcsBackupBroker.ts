// R7.1 — GcsBackupBroker
//
// 范围:仅 broker 公共 API + manifest 校验 + signed URL 颁发。**不**接 supervisor /
// scheduler / containerService。CLI(`scripts/r7-cli.ts`)是 R7.1 唯一的调用方。
//
// 详见 `docs/v3/R7-volume-gcs-backup-plan.md` §4.6 + R7.1 sub-plan v2。
//
// 不变量:
//  - broker 不读 env / process.env;所有依赖通过 BrokerOpts 注入(便于测试 + 多实例)
//  - 所有 public method 入参 uid / containerDbId 走 runtime safe-int 校验
//  - manifest schema + object 前缀校验在 commit / read / issueDownloadUrls 三处都跑
//  - 时间 / uuid 可注入(测试 deterministic)
//  - disabled broker 任何 issue/* / commit / read / delete 立刻 throw `disabled`,不联网

import { randomUUID } from "node:crypto";

import type { GcsClient, ObjectPutResult } from "./gcsClient.js";
import {
  BackupBrokerError,
  type Manifest,
  assertContainerDbId,
  assertSliceObjectPrefix,
  assertUid,
  parseAndAssertManifest,
} from "./types.js";

// ─── BrokerOpts ─────────────────────────────────────────────────────────

export interface BrokerOpts {
  /** Master kill-switch:env `R7_BACKUP_ENABLED && R7_RESTORE_ENABLED` 都为 "1" 时 true。
   *  R7.1 简化:任一关 → broker disabled,所有 public method throw `disabled`。
   *  R7.3 supervisor 集成时再考虑 backup-only / restore-only 分离 gating。 */
  enabled: boolean;
  /** Target bucket(env `R7_GCS_BUCKET`)。 */
  bucket: string;
  client: GcsClient;
  /** Signed URL 有效期(秒),默认 3600(1h)。 */
  uploadUrlTtlSec?: number;
  downloadUrlTtlSec?: number;
  /** Manifest sourceHostId / sourceHostName(用于事后追溯哪台 host 推的备份)。 */
  hostId: string;
  hostName: string;
  // ─── 测试注入点 ──────────────────────────────────────────────────────
  now?: () => Date;
  /** 4 字符 hex 后缀 generator;默认 `crypto.randomUUID().slice(0,4)`。 */
  shortUuid?: () => string;
}

const DEFAULT_TTL_SEC = 3600;

// ─── 公共 API result types ─────────────────────────────────────────────

export interface IssueUploadUrlsResult {
  data: { url: string; objectName: string; ifGenerationMatch: string };
  proj: { url: string; objectName: string; ifGenerationMatch: string };
  /** epoch ms。data / proj 共用同一过期(同次 issue) */
  expiresAt: number;
}

export interface IssueDownloadUrlsResult {
  data: { url: string };
  proj: { url: string };
  expiresAt: number;
}

export interface ReadManifestResult {
  manifest: Manifest;
  generation: string;
}

export interface CommitManifestResult {
  /** true → 写成功;false → CAS 412(caller 决定 LWW / 重读 / 报错) */
  committed: boolean;
  /** committed=true 时返回新 generation,供后续 commit 用作 ifGenerationMatch */
  generation?: string;
}

// ─── 工具 ───────────────────────────────────────────────────────────────

/** ISO8601 去毫秒,`:` → `-`,例 `2026-04-27T03-15-22Z`。 */
function isoSecForObjectName(d: Date): string {
  // toISOString 形如 `2026-04-27T03:15:22.123Z`,长度恒定,slice(0,19)+'Z' 安全
  return `${d.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
}

function defaultShortUuid(): string {
  // randomUUID() = `xxxxxxxx-xxxx-...`,前 4 个 hex 字符即够(R7.1 plan §4.3 文案)。
  // 撞概率 1/65536,撞了走 PUT If-Generation-Match: 0 重试,**不是**保证。
  return randomUUID().slice(0, 4);
}

// ─── Broker ─────────────────────────────────────────────────────────────

export class GcsBackupBroker {
  private readonly opts: Required<Omit<BrokerOpts, "now" | "shortUuid">> & {
    now: () => Date;
    shortUuid: () => string;
  };

  constructor(opts: BrokerOpts) {
    if (!opts.bucket || typeof opts.bucket !== "string") {
      throw new BackupBrokerError("config_invalid", "BrokerOpts.bucket required");
    }
    if (!opts.client || typeof opts.client !== "object") {
      throw new BackupBrokerError("config_invalid", "BrokerOpts.client required");
    }
    if (!opts.hostId || !opts.hostName) {
      throw new BackupBrokerError(
        "config_invalid",
        "BrokerOpts.hostId / hostName required",
      );
    }
    const upload = opts.uploadUrlTtlSec ?? DEFAULT_TTL_SEC;
    const download = opts.downloadUrlTtlSec ?? DEFAULT_TTL_SEC;
    if (!Number.isInteger(upload) || upload <= 0 || upload > 7 * 24 * 3600) {
      throw new BackupBrokerError("config_invalid", "uploadUrlTtlSec out of range (1..7d)");
    }
    if (!Number.isInteger(download) || download <= 0 || download > 7 * 24 * 3600) {
      throw new BackupBrokerError("config_invalid", "downloadUrlTtlSec out of range (1..7d)");
    }
    this.opts = {
      enabled: opts.enabled,
      bucket: opts.bucket,
      client: opts.client,
      uploadUrlTtlSec: upload,
      downloadUrlTtlSec: download,
      hostId: opts.hostId,
      hostName: opts.hostName,
      now: opts.now ?? (() => new Date()),
      shortUuid: opts.shortUuid ?? defaultShortUuid,
    };
  }

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private requireEnabled(): void {
    if (!this.opts.enabled) {
      throw new BackupBrokerError("disabled", "broker is disabled");
    }
  }

  private manifestObjectName(uid: number): string {
    return `u${uid}/manifest.json`;
  }

  private buildSliceObjectName(
    uid: number,
    kind: "data" | "proj",
    containerDbId: number,
    isoSec: string,
    shortUuid: string,
  ): string {
    return `u${uid}/${kind}-${isoSec}-c${containerDbId}-${shortUuid}.tar.zst`;
  }

  // ─── public API ───────────────────────────────────────────────────────

  /**
   * 颁发 2 个 V4 signed PUT URL(data + proj),带 `If-Generation-Match: 0` 强制 must-not-exist。
   *
   * - objectName 同次 issue 共用同一时间戳 + 同一 shortUuid(便于追溯一对)
   * - expiresAt 也共用(同时过期,简化)
   * - caller 应在 expiresAt 前完成两个 PUT;过了过期 → 重新 issue
   */
  async issueUploadUrls(
    uid: number,
    containerDbId: number,
  ): Promise<IssueUploadUrlsResult> {
    this.requireEnabled();
    assertUid(uid);
    assertContainerDbId(containerDbId);

    const now = this.opts.now();
    const isoSec = isoSecForObjectName(now);
    const shortUuid = this.opts.shortUuid();
    if (!/^[0-9a-f]{4}$/.test(shortUuid)) {
      throw new BackupBrokerError(
        "config_invalid",
        `shortUuid generator returned invalid value: ${shortUuid}`,
      );
    }

    const dataObject = this.buildSliceObjectName(uid, "data", containerDbId, isoSec, shortUuid);
    const projObject = this.buildSliceObjectName(uid, "proj", containerDbId, isoSec, shortUuid);
    const ifGenerationMatch = "0";
    const expiresAt = now.getTime() + this.opts.uploadUrlTtlSec * 1000;

    const [dataUrl, projUrl] = await Promise.all([
      this.opts.client.signUrl({
        bucket: this.opts.bucket,
        object: dataObject,
        method: "PUT",
        expiresAt,
        ifGenerationMatch,
        contentType: "application/zstd",
      }),
      this.opts.client.signUrl({
        bucket: this.opts.bucket,
        object: projObject,
        method: "PUT",
        expiresAt,
        ifGenerationMatch,
        contentType: "application/zstd",
      }),
    ]);

    return {
      data: { url: dataUrl, objectName: dataObject, ifGenerationMatch },
      proj: { url: projUrl, objectName: projObject, ifGenerationMatch },
      expiresAt,
    };
  }

  /**
   * 给 manifest 里的 data + proj 颁发 V4 signed GET URL。
   *
   * 安全要点:**不**假设 manifest 来自 readManifest —— 重跑 schema + object 前缀校验,
   * 防 caller 拿伪造 manifest 让 broker 给跨 user object 签 URL(Codex round-1 finding)。
   */
  async issueDownloadUrls(
    uid: number,
    manifest: Manifest,
  ): Promise<IssueDownloadUrlsResult> {
    this.requireEnabled();
    assertUid(uid);
    // 重跑全部校验 — manifest 可能来自不可信 caller
    const validated = parseAndAssertManifest(uid, manifest);

    const now = this.opts.now();
    const expiresAt = now.getTime() + this.opts.downloadUrlTtlSec * 1000;
    // GET 故意不传 contentType:V4 signed URL 把 content-type 计入 canonical
    // signed headers,客户端 GET 必须发完全相同的 Content-Type 才过签名校验,
    // 但 GET 一般不带 body 也不带 Content-Type。RealGcsClient 也会忽略 GET 的
    // contentType 双保险。
    const [dataUrl, projUrl] = await Promise.all([
      this.opts.client.signUrl({
        bucket: this.opts.bucket,
        object: validated.data.object,
        method: "GET",
        expiresAt,
      }),
      this.opts.client.signUrl({
        bucket: this.opts.bucket,
        object: validated.proj.object,
        method: "GET",
        expiresAt,
      }),
    ]);

    return {
      data: { url: dataUrl },
      proj: { url: projUrl },
      expiresAt,
    };
  }

  /**
   * 读 + 严格校验 user 的 manifest.json。
   *
   * - 不存在 → null
   * - 存在但 JSON 损坏 / schema 错 → throw `manifest_malformed`
   * - 存在但 uid 错位 → throw `manifest_uid_mismatch`
   * - 存在但 object 前缀错位 → throw `manifest_malformed`(防伪造跨 user)
   */
  async readManifest(uid: number): Promise<ReadManifestResult | null> {
    this.requireEnabled();
    assertUid(uid);
    const result = await this.opts.client.getObject(
      this.opts.bucket,
      this.manifestObjectName(uid),
    );
    if (!result.exists) return null;
    const text = result.body.toString("utf8");
    const manifest = parseAndAssertManifest(uid, text);
    return { manifest, generation: result.generation };
  }

  /**
   * 写 manifest(CAS via If-Generation-Match)。
   *
   * - `ifGenerationMatch === "0"` 首次写,object 不存在;已存在 → committed=false
   * - `ifGenerationMatch === "<prev>"` 后续写,prev = readManifest 返回的 generation;
   *   prev 已被改 → committed=false
   * - 写入前重跑 schema + uid + object 前缀校验(broker 不信任 caller 构 manifest)
   * - 412 → committed=false(caller 走 LWW / 重读 / 报错)
   * - 其它 io_error → throw,不吞
   */
  async commitManifest(
    uid: number,
    manifest: Manifest,
    opts: { ifGenerationMatch: string },
  ): Promise<CommitManifestResult> {
    this.requireEnabled();
    assertUid(uid);
    if (typeof opts.ifGenerationMatch !== "string" || !/^[0-9]+$/.test(opts.ifGenerationMatch)) {
      throw new BackupBrokerError(
        "config_invalid",
        "commitManifest.opts.ifGenerationMatch must be ASCII numeric string",
      );
    }
    // 重跑校验:caller 可能误构;errno > "stringly typed"
    const validated = parseAndAssertManifest(uid, manifest);

    const body = Buffer.from(JSON.stringify(validated, null, 2), "utf8");
    let result: ObjectPutResult;
    try {
      result = await this.opts.client.putObject(
        this.opts.bucket,
        this.manifestObjectName(uid),
        {
          body,
          contentType: "application/json",
          ifGenerationMatch: opts.ifGenerationMatch,
        },
      );
    } catch (err) {
      if (err instanceof BackupBrokerError && err.code === "precondition_failed") {
        return { committed: false };
      }
      throw err;
    }
    return { committed: true, generation: result.generation };
  }

  /**
   * 列出 + 删除 user 所有 backup objects(`u<uid>/*` 前缀)。
   *
   * 使用场景:v3volumeGc(R7.5)在删用户 docker volume 时一并清。
   * R7.1 暴露给 manual CLI 用于测试清理。
   */
  async deleteUserBackups(uid: number): Promise<{ deleted: number }> {
    this.requireEnabled();
    assertUid(uid);
    const prefix = `u${uid}/`;
    const listed = await this.opts.client.listObjects(this.opts.bucket, prefix);
    // 二次校验:列表里所有对象前缀必须在 `u<uid>/` 下,避免万一 GcsClient impl 漏
    // prefix filter 把别的用户对象给删了
    const ours = listed.filter((o) => o.name.startsWith(prefix));
    let deleted = 0;
    for (const obj of ours) {
      await this.opts.client.deleteObject(this.opts.bucket, obj.name);
      deleted++;
    }
    return { deleted };
  }

  // ─── helpers for caller ────────────────────────────────────────────────

  /**
   * 由 broker 持有的 host meta 构造完整 Manifest 的辅助方法。
   *
   * caller 已经知道:uid / containerDbId / 两个 slice 的 object/sha256/size/createdAt。
   * 这个方法把 sourceHostId / sourceHostName / version / updatedAt 从 broker opts
   * 填上,返一个**已校验**的 Manifest(走 parseAndAssertManifest 双保险)。
   *
   * R7.1 CLI 用它,R7.3 supervisor 也用它。 */
  buildManifest(args: {
    uid: number;
    containerDbId: number;
    data: { object: string; sha256: string; size: number; createdAt: string };
    proj: { object: string; sha256: string; size: number; createdAt: string };
  }): Manifest {
    assertUid(args.uid);
    assertContainerDbId(args.containerDbId);
    const updatedAt = this.opts.now().toISOString();
    const m = {
      version: 1 as const,
      uid: args.uid,
      updatedAt,
      sourceHostId: this.opts.hostId,
      sourceHostName: this.opts.hostName,
      sourceContainerId: args.containerDbId,
      data: args.data,
      proj: args.proj,
    };
    // parseAndAssertManifest 会做 schema + uid + object 前缀校验
    return parseAndAssertManifest(args.uid, m);
  }
}

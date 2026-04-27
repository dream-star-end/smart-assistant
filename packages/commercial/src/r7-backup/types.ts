// R7.1 — broker 共享类型 + zod schema
//
// 设计意图
// ────────
// • Manifest 是 GCS 上的"指针文件",broker 公共 API 跨进程边界(CLI / R7.3 supervisor)
//   传递它,**必须**在 read/commit/issueDownloadUrls 三处都跑严格 schema 校验,
//   不能假设 caller 顺序(详见 R7.1 sub-plan v2 §2 加固)。
// • `assertSliceObjectPrefix` 把 object 名 prefix 与 uid 绑死 — 防止读到伪造 manifest
//   时给跨 user object 签 GET URL(Codex round-1 finding)。
// • `BackupBrokerError.code` 是 typed enum,**不**用 message 字符串前缀传 CAS 语义,
//   R7.3 接入时可以稳定 catch `precondition_failed` code 走 LWW。

import { z } from "zod";

/**
 * 允许的 object 名(不含 `u<uid>/` 前缀):
 *   `<kind>-<isoSec>-c<cid>-<uuid4>.tar.zst`
 *
 * - `kind` 必须是 `data` 或 `proj`(R7.1 仅这两种 volume)
 * - `isoSec` 是去毫秒的 ISO8601,`:` 替成 `-` 防 path 不合法字符
 * - `c<cid>` 是 agent_containers.id,正整数,无前导 0
 * - `<uuid4>` 是 4 字符 hex 后缀(crypto.randomUUID().slice(0,4)),
 *   1/65536 撞概率;同名撞 → PUT 带 `If-Generation-Match: 0` 在 GCS 端强制 412 重试
 */
export const OBJECT_NAME_TAIL_RE =
  /^(data|proj)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-c[1-9]\d*-[0-9a-f]{4}\.tar\.zst$/;

/** 64 字符小写 hex sha256。helper 跟 RealGcsClient 都按 hex string 走,不用 Buffer。 */
const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters");

/**
 * ISO8601 严格校验:必须 round-trip(`new Date(s).toISOString() === s`)。
 * 这样拒掉 `2026-04-27T03:15:22+00:00`、`2026-04-27 03:15:22`、半结构化输入。
 * R7 broker 自己生成 manifest 时统一用 `Date.toISOString()`,符合此约束。
 */
const isoUtcStrict = z
  .string()
  .min(20)
  .max(30)
  .refine((s) => {
    if (Number.isNaN(Date.parse(s))) return false;
    try {
      return new Date(s).toISOString() === s;
    } catch {
      return false;
    }
  }, "must be ISO8601 UTC with millis (e.g. 2026-04-27T03:15:22.123Z)");

const safePositiveInt = z
  .number()
  .int()
  .positive()
  .lt(Number.MAX_SAFE_INTEGER, "must be < Number.MAX_SAFE_INTEGER");

const safeNonNegativeInt = z
  .number()
  .int()
  .nonnegative()
  .lt(Number.MAX_SAFE_INTEGER, "must be < Number.MAX_SAFE_INTEGER");

const hostIdLike = z.string().min(1).max(64);

export const manifestSliceSchema = z.object({
  /** 完整 object name,例 `u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst`。
   *  在 broker 持 uid 的入口处 (`assertSliceObjectPrefix`) 做 prefix 校验。 */
  object: z.string().min(1).max(512),
  sha256: sha256HexSchema,
  size: safeNonNegativeInt,
  createdAt: isoUtcStrict,
});
export type ManifestSlice = z.infer<typeof manifestSliceSchema>;

export const manifestSchema = z.object({
  version: z.literal(1),
  uid: safePositiveInt,
  updatedAt: isoUtcStrict,
  sourceHostId: hostIdLike,
  sourceHostName: hostIdLike,
  sourceContainerId: safePositiveInt,
  data: manifestSliceSchema,
  proj: manifestSliceSchema,
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Broker error 分类 — 调用方按 code 处理(message 仅供 log,不参与控制流)。
 *
 * - `disabled`             broker 未配齐 / kill-switch off,不应进任何 GCS 调用
 * - `config_invalid`       入参 uid / containerDbId 非 positive safe int,或 broker opts 非法
 * - `manifest_malformed`   GCS 上 manifest 损坏 / schema 失败 / object 前缀错位
 * - `manifest_uid_mismatch`manifest.uid !== expected,跨 user 篡改防御
 * - `precondition_failed`  GCS 412(CAS 冲突 / If-Generation-Match 0 失败)
 * - `io_error`             其它 GCS / 网络 / IAM 错,调用方一般 surface 给 caller
 */
export type BackupBrokerErrorCode =
  | "disabled"
  | "config_invalid"
  | "manifest_malformed"
  | "manifest_uid_mismatch"
  | "precondition_failed"
  | "io_error";

export class BackupBrokerError extends Error {
  readonly code: BackupBrokerErrorCode;

  constructor(code: BackupBrokerErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[r7-backup] ${code}: ${message}`, options);
    this.name = "BackupBrokerError";
    this.code = code;
  }
}

/**
 * 校验 object 名是否属于 uid + kind。R7.1 sub-plan v2 Codex round-1 finding:
 * `issueDownloadUrls(uid, manifest)` 不能假设 manifest 来自 readManifest —— 任何
 * caller 传进来的 manifest 都要 re-check,避免给跨 user object 签 GET URL。
 */
export function assertSliceObjectPrefix(
  uid: number,
  kind: "data" | "proj",
  object: string,
): void {
  assertUid(uid);
  const prefix = `u${uid}/`;
  if (!object.startsWith(prefix)) {
    throw new BackupBrokerError(
      "manifest_malformed",
      `object does not start with expected prefix ${prefix}`,
    );
  }
  const tail = object.slice(prefix.length);
  if (!OBJECT_NAME_TAIL_RE.test(tail)) {
    throw new BackupBrokerError(
      "manifest_malformed",
      `object tail does not match expected pattern (kind/timestamp/cid/uuid)`,
    );
  }
  if (!tail.startsWith(`${kind}-`)) {
    throw new BackupBrokerError(
      "manifest_malformed",
      `object kind does not match expected ${kind}`,
    );
  }
}

/**
 * 校验 uid 是 positive safe int — TS `number` 不是运行时边界,argv parse / JSON.parse
 * / 反序列化都可能进 NaN/0/负数/小数(Codex round-1 finding)。
 */
export function assertUid(uid: unknown): asserts uid is number {
  if (
    typeof uid !== "number" ||
    !Number.isInteger(uid) ||
    uid <= 0 ||
    uid >= Number.MAX_SAFE_INTEGER
  ) {
    throw new BackupBrokerError(
      "config_invalid",
      `uid must be positive safe integer, got ${typeof uid === "number" ? uid : typeof uid}`,
    );
  }
}

/** 同上,for containerDbId(agent_containers.id)。 */
export function assertContainerDbId(cid: unknown): asserts cid is number {
  if (
    typeof cid !== "number" ||
    !Number.isInteger(cid) ||
    cid <= 0 ||
    cid >= Number.MAX_SAFE_INTEGER
  ) {
    throw new BackupBrokerError(
      "config_invalid",
      `containerDbId must be positive safe integer, got ${typeof cid === "number" ? cid : typeof cid}`,
    );
  }
}

/**
 * 解析+校验 manifest JSON 的统一入口。
 *
 * - JSON parse 失败 → manifest_malformed
 * - schema 失败    → manifest_malformed
 * - manifest.uid !== expected → manifest_uid_mismatch
 * - object 前缀错位 → manifest_malformed
 *
 * 返已校验的 Manifest;**始终**与同一 uid 一起调用。
 */
export function parseAndAssertManifest(uid: number, raw: unknown): Manifest {
  assertUid(uid);
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new BackupBrokerError(
        "manifest_malformed",
        `manifest JSON parse failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
  } else {
    parsed = raw;
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new BackupBrokerError(
      "manifest_malformed",
      `manifest schema violation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const manifest = result.data;
  if (manifest.uid !== uid) {
    throw new BackupBrokerError(
      "manifest_uid_mismatch",
      `manifest.uid=${manifest.uid} but expected uid=${uid}`,
    );
  }
  assertSliceObjectPrefix(uid, "data", manifest.data.object);
  assertSliceObjectPrefix(uid, "proj", manifest.proj.object);
  return manifest;
}

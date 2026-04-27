// R7.1 — GcsClient 抽象层 + RealGcsClient(包 @google-cloud/storage)
//
// 设计意图
// ────────
// • 把 GCS 操作收在一个窄接口后面 → broker 单元测试可注入 FakeGcsClient,
//   不联网、不需要真凭据,符合 commercial 现有 node:test 风格。
// • RealGcsClient 是唯一与 SDK 耦合的地方;**不**暴露 SDK 类型给 broker / CLI。
// • 412 错由 RealGcsClient 显式 re-throw 成 `BackupBrokerError("precondition_failed", ...)`,
//   broker 用 typed code 走控制流(R7.1 sub-plan v2 §2 加固)。
// • signUrl 把 `ifGenerationMatch` 作为 V4 signed extension header 一起签 —— 如果
//   只在 PUT 请求 header 加而没在签名时加,GCS 会拒"unsigned header"或忽略 precondition。

import { Storage, type GetSignedUrlConfig } from "@google-cloud/storage";

import { BackupBrokerError } from "./types.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

export interface SignedUrlReq {
  bucket: string;
  object: string;
  method: "GET" | "PUT";
  /** epoch ms;SDK 接受 number 形式 */
  expiresAt: number;
  /** 仅允许 ASCII 数字字符串(`^[0-9]+$`);"0" = must-not-exist。
   *  其它 header 一律不接受(R7 plan §4.5/§4.6.5 设计:不开 generic header 接口)。 */
  ifGenerationMatch?: string;
  /** 默认 application/zstd(R7 上传 / 下载 .tar.zst)。 */
  contentType?: string;
}

export type ObjectGetResult =
  | { exists: false; generation?: never; body?: never }
  | {
      exists: true;
      /** GCS object generation,字符串保留(数值上限超 JS safe int) */
      generation: string;
      body: Buffer;
      contentType?: string;
    };

export interface ObjectPutOpts {
  body: Buffer;
  contentType?: string;
  /** 数字字符串。"0" = must-not-exist;其它 = CAS 必须等于现存 generation。 */
  ifGenerationMatch?: string;
}

export interface ObjectPutResult {
  generation: string;
}

export interface ListedObject {
  name: string;
}

/**
 * Broker 唯一的存储依赖。Real / Fake 实现都实现这个接口。
 *
 * 错误约定:
 * - 412 (precondition failed) → throw `BackupBrokerError("precondition_failed", ...)`
 * - 其它(网络 / 5xx / IAM 拒)→ throw `BackupBrokerError("io_error", ...)`
 */
export interface GcsClient {
  signUrl(req: SignedUrlReq): Promise<string>;
  getObject(bucket: string, object: string): Promise<ObjectGetResult>;
  putObject(bucket: string, object: string, opts: ObjectPutOpts): Promise<ObjectPutResult>;
  listObjects(bucket: string, prefix: string): Promise<ListedObject[]>;
  /** missing 视作成功(幂等 delete)。 */
  deleteObject(bucket: string, object: string): Promise<void>;
}

// ─── ifGenerationMatch 校验 ─────────────────────────────────────────────

const NUMERIC_STRING_RE = /^[0-9]+$/;

function assertNumericString(field: string, value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !NUMERIC_STRING_RE.test(value)) {
    throw new BackupBrokerError(
      "config_invalid",
      `${field} must be ASCII numeric string`,
    );
  }
}

// ─── RealGcsClient ─────────────────────────────────────────────────────

export interface RealGcsClientOpts {
  /** GOOGLE_APPLICATION_CREDENTIALS 绝对路径(SA JSON)。 */
  credentialsPath: string;
}

/**
 * GCS HTTP 错误形状:`@google-cloud/storage` SDK 把 HTTP 响应错包成 `Error`,
 * 在 v7 上同时挂 `code: number` (HTTP status,如 412/404)和 `errors[]`。
 *
 * 我们只需要 status code 来分类。defensive read,字段缺失退到 io_error。
 */
function isHttpStatus(err: unknown, status: number): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" && code === status;
}

function gcsErr(action: string, err: unknown): never {
  if (isHttpStatus(err, 412)) {
    throw new BackupBrokerError(
      "precondition_failed",
      `${action}: GCS 412 precondition failed`,
      { cause: err },
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  throw new BackupBrokerError("io_error", `${action}: ${msg}`, { cause: err });
}

export class RealGcsClient implements GcsClient {
  private readonly storage: Storage;

  constructor(opts: RealGcsClientOpts) {
    if (!opts.credentialsPath || typeof opts.credentialsPath !== "string") {
      throw new BackupBrokerError(
        "config_invalid",
        "RealGcsClient.credentialsPath required",
      );
    }
    // SDK 自己读 keyFilename(JSON 解析 + JWT 签名);不暴露 apiEndpoint(测试不走这条)
    this.storage = new Storage({ keyFilename: opts.credentialsPath });
  }

  async signUrl(req: SignedUrlReq): Promise<string> {
    assertNumericString("ifGenerationMatch", req.ifGenerationMatch);
    const action = req.method === "PUT" ? "write" : "read";
    const cfg: GetSignedUrlConfig = {
      version: "v4",
      action,
      expires: req.expiresAt,
    };
    // GET 不签 content-type:GCS 把 contentType 加入 V4 canonical signed headers,
    // 客户端发 GET 时如不附带完全相同的 Content-Type 就签名校验失败。GET 请求一般
    // 也不该带 Content-Type。仅 PUT 需要(上传 .tar.zst,接收方校验)。
    if (req.method === "PUT") {
      cfg.contentType = req.contentType ?? "application/zstd";
    }
    if (req.ifGenerationMatch !== undefined) {
      // 必须作为 signed extension header 一起签 — 否则 GCS 接受请求时不会强制
      // precondition,attacker / 误操作能把 if-gen-match=0 砍掉覆盖 object。
      cfg.extensionHeaders = {
        "x-goog-if-generation-match": req.ifGenerationMatch,
      };
    }
    try {
      const file = this.storage.bucket(req.bucket).file(req.object);
      const [url] = await file.getSignedUrl(cfg);
      return url;
    } catch (err) {
      gcsErr(`signUrl(${req.method} ${req.bucket}/${req.object})`, err);
    }
  }

  async getObject(bucket: string, object: string): Promise<ObjectGetResult> {
    try {
      const file = this.storage.bucket(bucket).file(object);
      const [exists] = await file.exists();
      if (!exists) return { exists: false };
      const [body] = await file.download();
      const [meta] = await file.getMetadata();
      const generation = meta.generation;
      if (generation === undefined || generation === null) {
        throw new BackupBrokerError(
          "io_error",
          `getObject(${bucket}/${object}): missing generation in metadata`,
        );
      }
      return {
        exists: true,
        generation: String(generation),
        body: Buffer.from(body),
        contentType:
          typeof meta.contentType === "string" ? meta.contentType : undefined,
      };
    } catch (err) {
      if (err instanceof BackupBrokerError) throw err;
      // file.exists() / download() 的 404 在 SDK 内部已被 exists() 抑制成 false;
      // 这里能落到 catch 的多半是网络 / IAM。
      gcsErr(`getObject(${bucket}/${object})`, err);
    }
  }

  async putObject(
    bucket: string,
    object: string,
    opts: ObjectPutOpts,
  ): Promise<ObjectPutResult> {
    assertNumericString("ifGenerationMatch", opts.ifGenerationMatch);
    try {
      const file = this.storage.bucket(bucket).file(object);
      const saveOpts: Parameters<typeof file.save>[1] = {
        contentType: opts.contentType ?? "application/zstd",
      };
      if (opts.ifGenerationMatch !== undefined) {
        saveOpts.preconditionOpts = {
          // SDK 接受 number/string,我们传 number 避免歧义;assertNumericString 已保正整数 / 0。
          ifGenerationMatch: Number.parseInt(opts.ifGenerationMatch, 10),
        };
      }
      await file.save(opts.body, saveOpts);
      // SDK save() 不返 generation;reload metadata 拿
      const [meta] = await file.getMetadata();
      const generation = meta.generation;
      if (generation === undefined || generation === null) {
        throw new BackupBrokerError(
          "io_error",
          `putObject(${bucket}/${object}): missing generation after save`,
        );
      }
      return { generation: String(generation) };
    } catch (err) {
      if (err instanceof BackupBrokerError) throw err;
      gcsErr(`putObject(${bucket}/${object})`, err);
    }
  }

  async listObjects(bucket: string, prefix: string): Promise<ListedObject[]> {
    try {
      const [files] = await this.storage.bucket(bucket).getFiles({ prefix });
      return files.map((f) => ({ name: f.name }));
    } catch (err) {
      gcsErr(`listObjects(${bucket}/${prefix})`, err);
    }
  }

  async deleteObject(bucket: string, object: string): Promise<void> {
    try {
      await this.storage.bucket(bucket).file(object).delete({ ignoreNotFound: true });
    } catch (err) {
      gcsErr(`deleteObject(${bucket}/${object})`, err);
    }
  }
}

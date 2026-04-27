#!/usr/bin/env tsx
/**
 * R7.1 — Manual GCS backup/restore CLI(单 user 端到端验证用)。
 *
 * 范围
 * ────
 * 仅作为 R7.1 阶段对 GcsBackupBroker 的人工验证工具,**不**接 supervisor / scheduler /
 * containerService。R7.3+ 的真实路径才是 supervisor 在 master 内调用 broker。
 *
 * 详见 `docs/v3/R7-volume-gcs-backup-plan.md` §4.6 + R7.1 sub-plan v2 §5。
 *
 * 用法
 * ────
 *   r7-cli backup  <uid> <containerDbId> <data-tar.zst> <proj-tar.zst>
 *     1) issueUploadUrls(uid, cid) → 2 个 V4 PUT URL(带 if-gen-match=0)
 *     2) PUT 各 tar(undici fetch),边传边计算 sha256+size
 *     3) readManifest(uid) → null(首次)或 prev generation
 *     4) buildManifest(broker 填 host/version/updatedAt)
 *     5) commitManifest(uid, manifest, ifGenerationMatch=prevGen|"0")
 *        - CAS 失败 → 重 readManifest 拿新 gen,重 commit 一次;再失败报错退出
 *
 *   r7-cli restore <uid> <data-out.tar.zst> <proj-out.tar.zst>
 *     1) readManifest(uid) → null 则 exit 4 + stderr
 *     2) issueDownloadUrls(uid, manifest) → 2 个 V4 GET URL
 *     3) GET 各 tar 写到 out path(`wx` 标志,文件已存在就 exit 5,不覆盖)
 *     4) sha256 + size 比对 manifest;不匹配 exit 6
 *
 *   r7-cli list <uid>
 *     readManifest(uid) → JSON 打印 manifest + generation,无 manifest 输出 "(none)"
 *
 *   r7-cli delete <uid>
 *     deleteUserBackups(uid) → 打印 deleted 数
 *
 * 退出码
 * ──────
 *   0  success
 *   1  unexpected runtime error
 *   2  config invalid:R7_BACKUP_ENABLED!=1 / R7_RESTORE_ENABLED!=1 / 缺 R7_GCS_BUCKET /
 *      缺 GOOGLE_APPLICATION_CREDENTIALS / 非法 uid|cid argv;ConfigError
 *   3  CAS 重试后仍 conflict(并发 commit / manifest 被改)
 *   4  no manifest exists for this uid(restore 前必有)
 *   5  output path already exists(restore 不覆盖)
 *   6  sha256 不匹配(下载 / 上传 corruption)
 *
 * Note: argv parse 故意没用 commander —— commercial workspace 没引入 commander,
 *       脚本场景手解 8 行就够,加依赖不值。
 */

import { createHash } from "node:crypto";
import { open as fsOpen, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { fetch } from "undici";

import { loadR7Config, ConfigError } from "../src/config.js";
import {
  BackupBrokerError,
  GcsBackupBroker,
  type Manifest,
  RealGcsClient,
} from "../src/r7-backup/index.js";

// ─── exit code 常量 ────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_CONFIG = 2;
const EXIT_CAS = 3;
const EXIT_NO_MANIFEST = 4;
const EXIT_OUTPUT_EXISTS = 5;
const EXIT_SHA_MISMATCH = 6;

// ─── argv 解析 / 校验 ──────────────────────────────────────────────────

function fail(exitCode: number, msg: string): never {
  process.stderr.write(`[r7-cli] ${msg}\n`);
  process.exit(exitCode);
}

/** 严格 positive safe int(argv parse 边界,跟 broker assertUid 保持一致) */
function parsePositiveInt(name: string, raw: string | undefined): number {
  if (!raw) fail(EXIT_CONFIG, `${name} required`);
  if (!/^[1-9]\d*$/.test(raw)) {
    fail(EXIT_CONFIG, `${name} must be positive integer (got: ${JSON.stringify(raw)})`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= Number.MAX_SAFE_INTEGER) {
    fail(EXIT_CONFIG, `${name} out of safe int range`);
  }
  return n;
}

function requireAbsolutePath(name: string, p: string | undefined): string {
  if (!p) fail(EXIT_CONFIG, `${name} required`);
  if (!isAbsolute(p)) fail(EXIT_CONFIG, `${name} must be absolute path (got: ${p})`);
  return p;
}

// ─── broker 构造 ───────────────────────────────────────────────────────

interface CliEnv {
  bucket: string;
  credentialsPath: string;
  backupEnabled: boolean;
  restoreEnabled: boolean;
}

/** 把 loadR7Config 结果归一成 CLI 视角。需要 backup+restore 都 enabled。
 *  CLI 故意不依赖 commercial master 的 DATABASE_URL/REDIS_URL 等无关 env,
 *  这样在 helper host 或 dev box 上验证 R7 行为不需要伪造一堆 dummy。 */
function loadCliEnv(): CliEnv {
  let cfg;
  try {
    cfg = loadR7Config();
  } catch (err) {
    if (err instanceof ConfigError) {
      const lines = err.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
      fail(EXIT_CONFIG, `config invalid:\n${lines}`);
    }
    throw err;
  }
  if (!cfg.R7_GCS_BUCKET) fail(EXIT_CONFIG, "R7_GCS_BUCKET not set");
  if (!cfg.GOOGLE_APPLICATION_CREDENTIALS) {
    fail(EXIT_CONFIG, "GOOGLE_APPLICATION_CREDENTIALS not set");
  }
  if (!cfg.R7_BACKUP_ENABLED) fail(EXIT_CONFIG, 'R7_BACKUP_ENABLED must be "1"');
  if (!cfg.R7_RESTORE_ENABLED) fail(EXIT_CONFIG, 'R7_RESTORE_ENABLED must be "1"');
  return {
    bucket: cfg.R7_GCS_BUCKET,
    credentialsPath: cfg.GOOGLE_APPLICATION_CREDENTIALS,
    backupEnabled: cfg.R7_BACKUP_ENABLED,
    restoreEnabled: cfg.R7_RESTORE_ENABLED,
  };
}

function makeBroker(env: CliEnv): GcsBackupBroker {
  const client = new RealGcsClient({ credentialsPath: env.credentialsPath });
  // R7.1 CLI 单机:hostId/Name 用主机名占位,manifest sourceHost* 用于事后追溯
  const hostName = process.env.HOSTNAME || process.env.HOST || "cli";
  return new GcsBackupBroker({
    enabled: env.backupEnabled && env.restoreEnabled,
    bucket: env.bucket,
    client,
    hostId: hostName,
    hostName,
  });
}

// ─── PUT / GET helpers (undici fetch + 流式 sha256) ─────────────────────

interface SliceMeta {
  sha256: string;
  size: number;
  createdAt: string;
}

/** 文件 → sha256 hex + size。先 stat 拿 size,再读全文件算 hash。 */
async function hashFile(absPath: string): Promise<{ sha256: string; size: number }> {
  const st = await fsStat(absPath);
  if (!st.isFile()) fail(EXIT_RUNTIME, `${absPath} is not a regular file`);
  const buf = await fsReadFile(absPath);
  const h = createHash("sha256").update(buf).digest("hex");
  if (st.size !== buf.byteLength) {
    // unlikely 但 stat / read 不一致是问题,直接报
    fail(EXIT_RUNTIME, `${absPath} size mismatch: stat=${st.size} read=${buf.byteLength}`);
  }
  return { sha256: h, size: st.size };
}

async function putToSignedUrl(
  url: string,
  filePath: string,
): Promise<void> {
  const buf = await fsReadFile(filePath);
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/zstd",
      // 必须跟 broker.signUrl 的 extensionHeaders 一致,否则 GCS 拒
      "x-goog-if-generation-match": "0",
    },
    body: buf,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    fail(EXIT_RUNTIME, `PUT ${filePath} failed: HTTP ${resp.status} ${text.slice(0, 500)}`);
  }
}

async function getFromSignedUrl(url: string, outPath: string): Promise<{ size: number; sha256: string }> {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    fail(EXIT_RUNTIME, `GET failed: HTTP ${resp.status} ${text.slice(0, 500)}`);
  }
  if (!resp.body) fail(EXIT_RUNTIME, "GET succeeded but no body");
  // wx = exclusive write,文件已存在 → EEXIST
  let fh;
  try {
    fh = await fsOpen(outPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      fail(EXIT_OUTPUT_EXISTS, `output path already exists: ${outPath}`);
    }
    throw err;
  }
  const hasher = createHash("sha256");
  let size = 0;
  try {
    // resp.body 是 web ReadableStream;node 的 file handle.write 接 buffer
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      hasher.update(value);
      size += value.byteLength;
      await fh.write(value);
    }
  } finally {
    await fh.close();
  }
  return { size, sha256: hasher.digest("hex") };
}

// ─── command: backup ────────────────────────────────────────────────────

async function cmdBackup(argv: string[]): Promise<number> {
  const uid = parsePositiveInt("uid", argv[0]);
  const cid = parsePositiveInt("containerDbId", argv[1]);
  const dataPath = requireAbsolutePath("data-tar-path", argv[2]);
  const projPath = requireAbsolutePath("proj-tar-path", argv[3]);

  const env = loadCliEnv();
  const broker = makeBroker(env);

  // 1) 算 hash + size(在 PUT 前算,避免传完才发现 size mismatch)
  process.stderr.write(`[r7-cli] hashing ${dataPath} + ${projPath}...\n`);
  const [dataHash, projHash] = await Promise.all([hashFile(dataPath), hashFile(projPath)]);

  // 2) issueUploadUrls
  process.stderr.write(`[r7-cli] issueUploadUrls(uid=${uid}, cid=${cid})...\n`);
  const issued = await broker.issueUploadUrls(uid, cid);

  // 3) PUT × 2(并行)
  process.stderr.write(
    `[r7-cli] PUT data → ${issued.data.objectName}, proj → ${issued.proj.objectName}...\n`,
  );
  await Promise.all([
    putToSignedUrl(issued.data.url, dataPath),
    putToSignedUrl(issued.proj.url, projPath),
  ]);

  // 4) build manifest
  const createdAt = new Date().toISOString();
  const dataSlice: SliceMeta = { ...dataHash, createdAt };
  const projSlice: SliceMeta = { ...projHash, createdAt };
  const manifest = broker.buildManifest({
    uid,
    containerDbId: cid,
    data: { object: issued.data.objectName, ...dataSlice },
    proj: { object: issued.proj.objectName, ...projSlice },
  });

  // 5) commit with retry once
  let prev = await broker.readManifest(uid);
  let ifGen = prev?.generation ?? "0";
  let result = await broker.commitManifest(uid, manifest, { ifGenerationMatch: ifGen });
  if (!result.committed) {
    // 重读一次拿新 gen,重 commit 一次。再失败 → exit 3。
    process.stderr.write(`[r7-cli] commit CAS conflict, retrying once...\n`);
    prev = await broker.readManifest(uid);
    ifGen = prev?.generation ?? "0";
    result = await broker.commitManifest(uid, manifest, { ifGenerationMatch: ifGen });
    if (!result.committed) {
      fail(EXIT_CAS, "commitManifest CAS failed twice (concurrent writer?)");
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        uid,
        containerDbId: cid,
        manifest,
        generation: result.generation,
      },
      null,
      2,
    ) + "\n",
  );
  return EXIT_OK;
}

// ─── command: restore ──────────────────────────────────────────────────

async function cmdRestore(argv: string[]): Promise<number> {
  const uid = parsePositiveInt("uid", argv[0]);
  const dataOut = requireAbsolutePath("data-out-path", argv[1]);
  const projOut = requireAbsolutePath("proj-out-path", argv[2]);

  const env = loadCliEnv();
  const broker = makeBroker(env);

  process.stderr.write(`[r7-cli] readManifest(uid=${uid})...\n`);
  const r = await broker.readManifest(uid);
  if (!r) fail(EXIT_NO_MANIFEST, `no manifest exists for uid=${uid}`);

  const issued = await broker.issueDownloadUrls(uid, r.manifest);

  // 提前查 out 路径(早 fail)— 真正 wx open 在 getFromSignedUrl 里
  for (const [label, p] of [
    ["data-out", dataOut],
    ["proj-out", projOut],
  ] as const) {
    try {
      await fsStat(dirname(p));
    } catch {
      fail(EXIT_RUNTIME, `${label} parent dir not accessible: ${dirname(p)}`);
    }
  }

  process.stderr.write(`[r7-cli] GET data → ${dataOut}, proj → ${projOut}...\n`);
  const [dataDl, projDl] = await Promise.all([
    getFromSignedUrl(issued.data.url, dataOut),
    getFromSignedUrl(issued.proj.url, projOut),
  ]);

  // sha256 + size 校验
  for (const [label, dl, expected] of [
    ["data", dataDl, r.manifest.data] as const,
    ["proj", projDl, r.manifest.proj] as const,
  ]) {
    if (dl.sha256 !== expected.sha256) {
      fail(EXIT_SHA_MISMATCH, `${label} sha256 mismatch: got ${dl.sha256} expected ${expected.sha256}`);
    }
    if (dl.size !== expected.size) {
      fail(EXIT_SHA_MISMATCH, `${label} size mismatch: got ${dl.size} expected ${expected.size}`);
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        uid,
        manifest: r.manifest,
        dataOut,
        projOut,
      },
      null,
      2,
    ) + "\n",
  );
  return EXIT_OK;
}

// ─── command: list ─────────────────────────────────────────────────────

async function cmdList(argv: string[]): Promise<number> {
  const uid = parsePositiveInt("uid", argv[0]);
  const env = loadCliEnv();
  const broker = makeBroker(env);

  const r = await broker.readManifest(uid);
  if (!r) {
    process.stdout.write(`(none) — uid=${uid} has no manifest\n`);
    return EXIT_OK;
  }
  process.stdout.write(
    JSON.stringify({ generation: r.generation, manifest: r.manifest }, null, 2) + "\n",
  );
  return EXIT_OK;
}

// ─── command: delete ───────────────────────────────────────────────────

async function cmdDelete(argv: string[]): Promise<number> {
  const uid = parsePositiveInt("uid", argv[0]);
  const env = loadCliEnv();
  const broker = makeBroker(env);

  const r = await broker.deleteUserBackups(uid);
  process.stdout.write(JSON.stringify({ ok: true, uid, ...r }, null, 2) + "\n");
  return EXIT_OK;
}

// ─── main ─────────────────────────────────────────────────────────────

function usage(): void {
  process.stderr.write(
    [
      "Usage: r7-cli <command> [args]",
      "",
      "Commands:",
      "  backup  <uid> <containerDbId> <data-tar-path> <proj-tar-path>",
      "  restore <uid> <data-out-path> <proj-out-path>",
      "  list    <uid>",
      "  delete  <uid>",
      "",
      "Required env: R7_GCS_BUCKET, GOOGLE_APPLICATION_CREDENTIALS,",
      "              R7_BACKUP_ENABLED=1, R7_RESTORE_ENABLED=1",
      "",
      "Exit codes: 0 ok | 1 runtime | 2 config | 3 CAS | 4 no-manifest |",
      "            5 output-exists | 6 sha-mismatch",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "backup":
      return cmdBackup(rest);
    case "restore":
      return cmdRestore(rest);
    case "list":
      return cmdList(rest);
    case "delete":
      return cmdDelete(rest);
    case undefined:
    case "-h":
    case "--help":
      usage();
      return cmd === undefined ? EXIT_CONFIG : EXIT_OK;
    default:
      usage();
      fail(EXIT_CONFIG, `unknown command: ${cmd}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof BackupBrokerError) {
        process.stderr.write(`[r7-cli] BackupBrokerError(${err.code}): ${err.message}\n`);
        // typed broker error → 2 if config-ish, 3 if CAS, else 1
        if (err.code === "config_invalid" || err.code === "disabled") process.exit(EXIT_CONFIG);
        if (err.code === "precondition_failed") process.exit(EXIT_CAS);
        process.exit(EXIT_RUNTIME);
      }
      process.stderr.write(`[r7-cli] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(EXIT_RUNTIME);
    },
  );
}

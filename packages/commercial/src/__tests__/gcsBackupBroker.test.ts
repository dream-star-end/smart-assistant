// R7.1 — GcsBackupBroker unit tests
//
// 思路
// ────
// 用 FakeGcsClient(本文件内 ~120 行)替 RealGcsClient,broker 公共 API 全覆盖,
// 不联网、不需要凭据,与 commercial 现有 node:test 风格一致(参考 v3Readiness.test.ts)。
//
// 覆盖目标:R7.1 sub-plan v2 §4 列的 ≥ 23 case,显式覆盖 v2 加固点(uid 错位 manifest /
// 跨 user object 校验 / negative uid input / 412 vs io_error 分支)。

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BackupBrokerError,
  GcsBackupBroker,
  type GcsClient,
  type Manifest,
  type ObjectGetResult,
  type ObjectPutOpts,
  type ObjectPutResult,
  type SignedUrlReq,
} from "../r7-backup/index.js";

// ───────────────────────────────────────────────────────────────────────
//  FakeGcsClient
// ───────────────────────────────────────────────────────────────────────

interface FakeObject {
  body: Buffer;
  generation: number;
  contentType?: string;
}

class FakeGcsClient implements GcsClient {
  // bucket → (object → FakeObject)
  private store = new Map<string, Map<string, FakeObject>>();
  private nextGen = 1;
  /** 调用计数器,断言用 */
  callCounts = { signUrl: 0, getObject: 0, putObject: 0, listObjects: 0, deleteObject: 0 };
  /** 记录每次 signUrl 收到的 req,便于 assert broker 是否传了正确的字段。 */
  signUrlCalls: SignedUrlReq[] = [];
  /** 注入式失败 — 下一次某操作 throw 这个 error */
  failNext: { op: keyof FakeGcsClient["callCounts"]; err: BackupBrokerError } | null = null;

  private bucketMap(bucket: string): Map<string, FakeObject> {
    let m = this.store.get(bucket);
    if (!m) {
      m = new Map();
      this.store.set(bucket, m);
    }
    return m;
  }

  private maybeFail(op: keyof FakeGcsClient["callCounts"]): void {
    if (this.failNext && this.failNext.op === op) {
      const err = this.failNext.err;
      this.failNext = null;
      throw err;
    }
  }

  async signUrl(req: SignedUrlReq): Promise<string> {
    this.callCounts.signUrl++;
    this.signUrlCalls.push({ ...req });
    this.maybeFail("signUrl");
    const enc = encodeURIComponent(req.object);
    const ifGen = req.ifGenerationMatch ?? "none";
    return `https://fake.test/${req.bucket}/${enc}?method=${req.method}&exp=${req.expiresAt}&ifGen=${ifGen}`;
  }

  async getObject(bucket: string, object: string): Promise<ObjectGetResult> {
    this.callCounts.getObject++;
    this.maybeFail("getObject");
    const obj = this.bucketMap(bucket).get(object);
    if (!obj) return { exists: false };
    return {
      exists: true,
      generation: String(obj.generation),
      body: obj.body,
      contentType: obj.contentType,
    };
  }

  async putObject(
    bucket: string,
    object: string,
    opts: ObjectPutOpts,
  ): Promise<ObjectPutResult> {
    this.callCounts.putObject++;
    this.maybeFail("putObject");
    const m = this.bucketMap(bucket);
    const existing = m.get(object);
    if (opts.ifGenerationMatch !== undefined) {
      const ifGen = opts.ifGenerationMatch;
      if (ifGen === "0") {
        if (existing) {
          throw new BackupBrokerError(
            "precondition_failed",
            `fake: object ${object} already exists`,
          );
        }
      } else {
        if (!existing || String(existing.generation) !== ifGen) {
          throw new BackupBrokerError(
            "precondition_failed",
            `fake: generation mismatch for ${object}`,
          );
        }
      }
    }
    const generation = this.nextGen++;
    m.set(object, {
      body: Buffer.from(opts.body),
      generation,
      contentType: opts.contentType,
    });
    return { generation: String(generation) };
  }

  async listObjects(bucket: string, prefix: string) {
    this.callCounts.listObjects++;
    this.maybeFail("listObjects");
    return Array.from(this.bucketMap(bucket).keys())
      .filter((n) => n.startsWith(prefix))
      .map((name) => ({ name }));
  }

  async deleteObject(bucket: string, object: string): Promise<void> {
    this.callCounts.deleteObject++;
    this.maybeFail("deleteObject");
    this.bucketMap(bucket).delete(object);
  }

  /** 测试辅助:直接在 FakeGcs 中预放对象(不走 broker) */
  seed(bucket: string, object: string, body: Buffer | string, contentType?: string): number {
    const m = this.bucketMap(bucket);
    const generation = this.nextGen++;
    m.set(object, {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
      generation,
      contentType,
    });
    return generation;
  }

  /** 测试辅助:列举所有 key */
  allKeys(bucket: string): string[] {
    return Array.from(this.bucketMap(bucket).keys()).sort();
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Broker fixture helpers
// ───────────────────────────────────────────────────────────────────────

function makeBroker(overrides: {
  enabled?: boolean;
  client?: GcsClient;
  now?: () => Date;
  shortUuid?: () => string;
} = {}) {
  const client = overrides.client ?? new FakeGcsClient();
  const broker = new GcsBackupBroker({
    enabled: overrides.enabled ?? true,
    bucket: "test-bucket",
    client,
    hostId: "host-uuid-001",
    hostName: "self",
    now: overrides.now,
    shortUuid: overrides.shortUuid,
  });
  return { broker, client: client as FakeGcsClient };
}

const FIXED_NOW = new Date("2026-04-27T03:15:22.123Z");
const FIXED_NOW_FN = () => FIXED_NOW;
const FIXED_UUID_FN = () => "a3f2";

/** 构造一个 caller-style"已上传两个 slice"后的 manifest(用 broker.buildManifest)。 */
function makeManifest(
  broker: GcsBackupBroker,
  uid: number,
  containerDbId: number,
  dataObject: string,
  projObject: string,
): Manifest {
  return broker.buildManifest({
    uid,
    containerDbId,
    data: {
      object: dataObject,
      sha256: "a".repeat(64),
      size: 100,
      createdAt: FIXED_NOW.toISOString(),
    },
    proj: {
      object: projObject,
      sha256: "b".repeat(64),
      size: 200,
      createdAt: FIXED_NOW.toISOString(),
    },
  });
}

// ───────────────────────────────────────────────────────────────────────
//  isEnabled / disabled gating
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.isEnabled", () => {
  test("returns true when enabled=true", () => {
    const { broker } = makeBroker({ enabled: true });
    assert.equal(broker.isEnabled(), true);
  });

  test("returns false when enabled=false", () => {
    const { broker } = makeBroker({ enabled: false });
    assert.equal(broker.isEnabled(), false);
  });
});

describe("GcsBackupBroker disabled gating", () => {
  test("issueUploadUrls throws BackupBrokerError(disabled)", async () => {
    const { broker } = makeBroker({ enabled: false });
    await assert.rejects(
      () => broker.issueUploadUrls(32, 1234),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "disabled",
    );
  });

  test("commitManifest throws disabled", async () => {
    const { broker } = makeBroker({ enabled: false });
    // 即便 manifest 是合法的也应该被 disabled 拒
    const m: Manifest = {
      version: 1,
      uid: 32,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "host-uuid-001",
      sourceHostName: "self",
      sourceContainerId: 1234,
      data: {
        object: "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "a".repeat(64),
        size: 100,
        createdAt: FIXED_NOW.toISOString(),
      },
      proj: {
        object: "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "b".repeat(64),
        size: 200,
        createdAt: FIXED_NOW.toISOString(),
      },
    };
    await assert.rejects(
      () => broker.commitManifest(32, m, { ifGenerationMatch: "0" }),
      (err: unknown) => err instanceof BackupBrokerError && err.code === "disabled",
    );
  });

  test("readManifest throws disabled", async () => {
    const { broker } = makeBroker({ enabled: false });
    await assert.rejects(
      () => broker.readManifest(32),
      (err: unknown) => err instanceof BackupBrokerError && err.code === "disabled",
    );
  });

  test("issueDownloadUrls throws disabled", async () => {
    const { broker: enabled } = makeBroker({ enabled: true, now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      enabled,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    const { broker } = makeBroker({ enabled: false });
    await assert.rejects(
      () => broker.issueDownloadUrls(32, m),
      (err: unknown) => err instanceof BackupBrokerError && err.code === "disabled",
    );
  });

  test("deleteUserBackups throws disabled", async () => {
    const { broker } = makeBroker({ enabled: false });
    await assert.rejects(
      () => broker.deleteUserBackups(32),
      (err: unknown) => err instanceof BackupBrokerError && err.code === "disabled",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  issueUploadUrls
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.issueUploadUrls", () => {
  test("returns 2 URLs with deterministic objectName when now/uuid injected", async () => {
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const r = await broker.issueUploadUrls(32, 1234);
    assert.equal(r.data.objectName, "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst");
    assert.equal(r.proj.objectName, "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst");
    assert.equal(r.data.ifGenerationMatch, "0");
    assert.equal(r.proj.ifGenerationMatch, "0");
    assert.equal(r.expiresAt, FIXED_NOW.getTime() + 3600 * 1000);
    assert.match(r.data.url, /^https:\/\/fake\.test\/test-bucket\//);
    assert.match(r.proj.url, /^https:\/\/fake\.test\/test-bucket\//);
    assert.equal(client.callCounts.signUrl, 2);
  });

  test("data and proj share same timestamp + uuid (paired)", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const r = await broker.issueUploadUrls(32, 1234);
    // 同一时间戳 + uuid,只 kind 不同
    assert.equal(
      r.data.objectName.replace("data-", "X-"),
      r.proj.objectName.replace("proj-", "X-"),
    );
  });

  test("two consecutive calls with different uuids → different objectNames", async () => {
    let i = 0;
    const uuids = ["a3f2", "b1c2"];
    const { broker } = makeBroker({
      now: FIXED_NOW_FN,
      shortUuid: () => uuids[i++]!,
    });
    const r1 = await broker.issueUploadUrls(32, 1234);
    const r2 = await broker.issueUploadUrls(32, 1234);
    assert.notEqual(r1.data.objectName, r2.data.objectName);
    assert.notEqual(r1.proj.objectName, r2.proj.objectName);
  });

  test("objectName regex: data-/proj- + isoSec + cid + 4hex uuid", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const r = await broker.issueUploadUrls(32, 1234);
    const re = /^u32\/(data|proj)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-c1234-[0-9a-f]{4}\.tar\.zst$/;
    assert.match(r.data.objectName, re);
    assert.match(r.proj.objectName, re);
  });

  test("rejects uid <= 0 / non-integer / NaN", async () => {
    const { broker } = makeBroker();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as number[]) {
      await assert.rejects(
        () => broker.issueUploadUrls(bad, 1234),
        (err: unknown) =>
          err instanceof BackupBrokerError && err.code === "config_invalid",
        `uid=${bad} should be rejected`,
      );
    }
  });

  test("rejects non-number uid (e.g. string '32')", async () => {
    const { broker } = makeBroker();
    await assert.rejects(
      // @ts-expect-error — runtime boundary test
      () => broker.issueUploadUrls("32", 1234),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "config_invalid",
    );
  });

  test("rejects containerDbId <= 0", async () => {
    const { broker } = makeBroker();
    await assert.rejects(
      () => broker.issueUploadUrls(32, 0),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "config_invalid",
    );
  });

  test("rejects shortUuid generator returning non-4hex", async () => {
    const { broker } = makeBroker({ shortUuid: () => "ZZZZ" });
    await assert.rejects(
      () => broker.issueUploadUrls(32, 1234),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "config_invalid",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  commitManifest
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.commitManifest", () => {
  test("first commit with ifGenerationMatch=0 → committed=true", async () => {
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    const r = await broker.commitManifest(32, m, { ifGenerationMatch: "0" });
    assert.equal(r.committed, true);
    assert.equal(typeof r.generation, "string");
    // FakeGcs 里有 manifest.json
    assert.deepEqual(client.allKeys("test-bucket"), ["u32/manifest.json"]);
  });

  test("second commit with ifGenerationMatch=0 → committed=false (precondition_failed swallowed)", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    await broker.commitManifest(32, m, { ifGenerationMatch: "0" });
    const r2 = await broker.commitManifest(32, m, { ifGenerationMatch: "0" });
    assert.equal(r2.committed, false);
    assert.equal(r2.generation, undefined);
  });

  test("commit with prev generation → committed=true", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    const first = await broker.commitManifest(32, m, { ifGenerationMatch: "0" });
    assert.equal(first.committed, true);
    const second = await broker.commitManifest(32, m, {
      ifGenerationMatch: first.generation!,
    });
    assert.equal(second.committed, true);
  });

  test("uid mismatch → throws manifest_uid_mismatch (broker self-check)", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    // 试图把这个 m 写到 uid=33 的位置 → 校验拒
    await assert.rejects(
      () => broker.commitManifest(33, m, { ifGenerationMatch: "0" }),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_uid_mismatch",
    );
  });

  test("manifest.data.object pointing to u33/... while uid=32 → throws manifest_malformed", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    // 直接构造非法 manifest(绕过 buildManifest 的校验)
    const m: Manifest = {
      version: 1,
      uid: 32,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "host-uuid-001",
      sourceHostName: "self",
      sourceContainerId: 1234,
      data: {
        // 错位 — uid 在 manifest 是 32 但 object 在 u33/ 下
        object: "u33/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "a".repeat(64),
        size: 100,
        createdAt: FIXED_NOW.toISOString(),
      },
      proj: {
        object: "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "b".repeat(64),
        size: 200,
        createdAt: FIXED_NOW.toISOString(),
      },
    };
    await assert.rejects(
      () => broker.commitManifest(32, m, { ifGenerationMatch: "0" }),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_malformed",
    );
  });

  test("non-numeric ifGenerationMatch → throws config_invalid", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    await assert.rejects(
      () => broker.commitManifest(32, m, { ifGenerationMatch: "abc" }),
      (err: unknown) => err instanceof BackupBrokerError && err.code === "config_invalid",
    );
  });

  test("io_error from GCS putObject → re-throws (does NOT swallow as committed=false)", async () => {
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    client.failNext = {
      op: "putObject",
      err: new BackupBrokerError("io_error", "fake: 500 server error"),
    };
    await assert.rejects(
      () => broker.commitManifest(32, m, { ifGenerationMatch: "0" }),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "io_error",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  readManifest
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.readManifest", () => {
  test("returns null when no manifest exists", async () => {
    const { broker } = makeBroker();
    assert.equal(await broker.readManifest(32), null);
  });

  test("returns parsed manifest + generation when present", async () => {
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    await broker.commitManifest(32, m, { ifGenerationMatch: "0" });
    const r = await broker.readManifest(32);
    assert.ok(r);
    assert.equal(r!.manifest.uid, 32);
    assert.equal(r!.manifest.data.object, m.data.object);
    assert.equal(typeof r!.generation, "string");
    void client; // suppress unused
  });

  test("malformed JSON in manifest object → throws manifest_malformed", async () => {
    const { broker, client } = makeBroker();
    client.seed("test-bucket", "u32/manifest.json", "{not valid json", "application/json");
    await assert.rejects(
      () => broker.readManifest(32),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_malformed",
    );
  });

  test("wrong version (e.g. 99) → throws manifest_malformed", async () => {
    const { broker, client } = makeBroker();
    const bad = JSON.stringify({
      version: 99,
      uid: 32,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "h",
      sourceHostName: "self",
      sourceContainerId: 1,
      data: { object: "u32/data-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "a".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
      proj: { object: "u32/proj-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "b".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
    });
    client.seed("test-bucket", "u32/manifest.json", bad, "application/json");
    await assert.rejects(
      () => broker.readManifest(32),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_malformed",
    );
  });

  test("uid mismatch (manifest.uid=33, expected=32) → throws manifest_uid_mismatch", async () => {
    const { broker, client } = makeBroker();
    const bad = JSON.stringify({
      version: 1,
      uid: 33,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "h",
      sourceHostName: "self",
      sourceContainerId: 1,
      data: { object: "u33/data-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "a".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
      proj: { object: "u33/proj-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "b".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
    });
    client.seed("test-bucket", "u32/manifest.json", bad, "application/json");
    await assert.rejects(
      () => broker.readManifest(32),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_uid_mismatch",
    );
  });

  test("uid matches but data.object points to u33/... → throws manifest_malformed (cross-user defense)", async () => {
    const { broker, client } = makeBroker();
    const bad = JSON.stringify({
      version: 1,
      uid: 32,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "h",
      sourceHostName: "self",
      sourceContainerId: 1,
      data: { object: "u33/data-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "a".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
      proj: { object: "u32/proj-2026-04-27T03-15-22Z-c1-a3f2.tar.zst", sha256: "b".repeat(64), size: 0, createdAt: FIXED_NOW.toISOString() },
    });
    client.seed("test-bucket", "u32/manifest.json", bad, "application/json");
    await assert.rejects(
      () => broker.readManifest(32),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_malformed",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  issueDownloadUrls
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.issueDownloadUrls", () => {
  test("signs GET URL for both data and proj from manifest", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    const r = await broker.issueDownloadUrls(32, m);
    assert.match(r.data.url, /method=GET/);
    assert.match(r.proj.url, /method=GET/);
    // URL 中应包含正确的 object 名(URL-encoded)
    assert.match(r.data.url, /u32%2Fdata-/);
    assert.match(r.proj.url, /u32%2Fproj-/);
  });

  test("GET signed URLs do NOT include contentType (V4 signed-header mismatch defense)", async () => {
    // 回归 Codex round-1 blocker:GCS V4 把 content-type 计入 signed headers,
    // GET 时 broker 不应传 contentType,否则 client 必须发完全相同的 Content-Type
    // 才过签名校验,但 GET 一般不带 body 也不带 Content-Type → 签名失败。
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = makeManifest(
      broker,
      32,
      1234,
      "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
      "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    );
    client.signUrlCalls.length = 0;
    await broker.issueDownloadUrls(32, m);
    assert.equal(client.signUrlCalls.length, 2);
    for (const call of client.signUrlCalls) {
      assert.equal(call.method, "GET");
      assert.equal(call.contentType, undefined, `GET signUrl must not pass contentType (got ${call.contentType})`);
      assert.equal(call.ifGenerationMatch, undefined, "GET signUrl must not pass ifGenerationMatch");
    }
  });

  test("PUT signed URLs (issueUploadUrls) DO include contentType=application/zstd + ifGenerationMatch=0", async () => {
    // 对应回归:PUT 路径必须保留 contentType 和 if-gen-match=0,与 CLI 的 PUT
    // header 对齐。如果 broker 漏传 → CLI 上传时签名校验失败。
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    client.signUrlCalls.length = 0;
    await broker.issueUploadUrls(32, 1234);
    assert.equal(client.signUrlCalls.length, 2);
    for (const call of client.signUrlCalls) {
      assert.equal(call.method, "PUT");
      assert.equal(call.contentType, "application/zstd");
      assert.equal(call.ifGenerationMatch, "0");
    }
  });

  test("rejects manifest with cross-user object (uid=32 + manifest.proj.object=u33/...)", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const malicious: Manifest = {
      version: 1,
      uid: 32,
      updatedAt: FIXED_NOW.toISOString(),
      sourceHostId: "h",
      sourceHostName: "self",
      sourceContainerId: 1234,
      data: {
        object: "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "a".repeat(64),
        size: 0,
        createdAt: FIXED_NOW.toISOString(),
      },
      proj: {
        // 跨 user!
        object: "u33/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "b".repeat(64),
        size: 0,
        createdAt: FIXED_NOW.toISOString(),
      },
    };
    await assert.rejects(
      () => broker.issueDownloadUrls(32, malicious),
      (err: unknown) =>
        err instanceof BackupBrokerError && err.code === "manifest_malformed",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
//  deleteUserBackups
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.deleteUserBackups", () => {
  test("deletes all u<uid>/* objects and returns count", async () => {
    const { broker, client } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    // 写一些假对象
    client.seed("test-bucket", "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst", "data-bytes");
    client.seed("test-bucket", "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst", "proj-bytes");
    client.seed("test-bucket", "u32/manifest.json", "{}");
    // 别的 user
    client.seed("test-bucket", "u33/data-2026-04-27T03-15-22Z-c5555-bbbb.tar.zst", "other");

    const r = await broker.deleteUserBackups(32);
    assert.equal(r.deleted, 3);
    assert.deepEqual(client.allKeys("test-bucket"), [
      "u33/data-2026-04-27T03-15-22Z-c5555-bbbb.tar.zst",
    ]);
  });

  test("empty user → deleted=0, no error", async () => {
    const { broker } = makeBroker();
    const r = await broker.deleteUserBackups(32);
    assert.equal(r.deleted, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  buildManifest helper
// ───────────────────────────────────────────────────────────────────────

describe("GcsBackupBroker.buildManifest", () => {
  test("fills sourceHostId/Name from broker opts, not caller", async () => {
    const { broker } = makeBroker({ now: FIXED_NOW_FN, shortUuid: FIXED_UUID_FN });
    const m = broker.buildManifest({
      uid: 32,
      containerDbId: 1234,
      data: {
        object: "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "a".repeat(64),
        size: 100,
        createdAt: FIXED_NOW.toISOString(),
      },
      proj: {
        object: "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
        sha256: "b".repeat(64),
        size: 200,
        createdAt: FIXED_NOW.toISOString(),
      },
    });
    assert.equal(m.sourceHostId, "host-uuid-001");
    assert.equal(m.sourceHostName, "self");
    assert.equal(m.version, 1);
    assert.equal(m.updatedAt, FIXED_NOW.toISOString());
  });
});

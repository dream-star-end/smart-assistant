/**
 * 科研 durable 层集成测试(真 PG):
 *   - store:createJob 幂等 / claimNextJob(running 转移)/ complete・fail guard /
 *     recoverStale / checkpoints / documents(tenant 隔离 + getSpan)/ blobs(tenant 隔离)/
 *     artifacts / 保留策略 GC(blob 默认 30 天 TTL + gcExpiredBlobs + gcOldArtifacts)。
 *   - scheduler:drainResearchJobs 派发 handler → completed / failed;未注册 kind → failed。
 *   - 并发:两个 claimNextJob 不重复领取(advisory lock + FOR UPDATE SKIP LOCKED)。
 *   - researchConfig:public 默认 / patch(校验+持久+audit)/ secret set・clear round-trip。
 *
 * pg 不可用时 skip(CI 必须有 PG → REQUIRE_TEST_DB=1)。
 */

// KMS key(测试固定 32B base64)— 必须在 import crypto 前设好。
process.env.OPENCLAUDE_KMS_KEY =
  process.env.OPENCLAUDE_KMS_KEY ?? Buffer.alloc(32, 7).toString("base64");

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import {
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  gcExpiredBlobs,
  gcOldArtifacts,
  getBlob,
  getDocument,
  getJob,
  getSpan,
  listArtifacts,
  listCheckpoints,
  putBlob,
  putDocument,
  recordCheckpoint,
  recoverStale,
  registerArtifact,
} from "../research/store.js";
import { drainResearchJobs, runResearchGc } from "../research/scheduler.js";
import {
  getResearchConfigPublic,
  getResearchConfigView,
  getResearchSecrets,
  patchResearchConfig,
  setResearchSecret,
  clearResearchSecret,
  DEFAULT_RESEARCH_CONFIG,
} from "../admin/researchConfig.js";
import type { NormalizedDocument } from "@openclaude/protocol/research";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;
let userA = "0";
let userB = "0";

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  // clean slate:整库重建,自带全部 migration(含 0094/0095)
  await resetTestSchemaForTest();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE research_jobs, research_phase_checkpoints, research_documents, research_artifacts, research_blobs, users RESTART IDENTITY CASCADE",
  );
  // research_config 是单行表(0095 seed),TRUNCATE 会清掉 → 重新 seed
  await query("INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  const a = await query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ('a@test', 'x') RETURNING id::text AS id",
  );
  const b = await query<{ id: string }>(
    "INSERT INTO users (email, password_hash) VALUES ('b@test', 'x') RETURNING id::text AS id",
  );
  userA = a.rows[0].id;
  userB = b.rows[0].id;
});

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

// ─── store: jobs ─────────────────────────────────────────────────────

describe("research store: jobs", () => {
  it("createJob 幂等(同 user+request_id 不重复入队)", async (t) => {
    if (skip(t)) return;
    const j1 = await createJob({ userId: userA, requestId: "r1", kind: "ingest" });
    const j2 = await createJob({ userId: userA, requestId: "r1", kind: "ingest" });
    assert.equal(j1.id, j2.id);
    assert.equal(j1.status, "queued");
  });

  it("claimNextJob 把 queued 转 running 并 attempts++", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "r1", kind: "lit_search" });
    const claimed = await claimNextJob(10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, "running");
    assert.equal(claimed[0].attempts, 1);
    // 再 claim 拿不到(已 running)
    const again = await claimNextJob(10);
    assert.equal(again.length, 0);
  });

  it("completeJob/failJob 带 status guard(非 running 不写)", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "r1", kind: "ingest" });
    // 未 claim(queued)→ completeJob 应失败(guard)
    const job = await getJob(userA, "r1");
    assert.ok(job);
    assert.equal(await completeJob(job.id, { ok: 1 }), false);
    // claim 后 complete 成功
    await claimNextJob(10);
    assert.equal(await completeJob(job.id, { ok: 1 }), true);
    // 已 completed,再 fail 无效
    assert.equal(await failJob(job.id, "late"), false);
    const done = await getJob(userA, "r1");
    assert.equal(done?.status, "completed");
    assert.deepEqual(done?.result, { ok: 1 });
  });

  it("recoverStale 把崩前 running(locked_at 久远)标 interrupted", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "r1", kind: "ingest" });
    await claimNextJob(10);
    // 人为把 locked_at 拨到 1 小时前
    await query("UPDATE research_jobs SET locked_at = NOW() - INTERVAL '1 hour'");
    const n = await recoverStale(30 * 60_000);
    assert.equal(n, 1);
    const job = await getJob(userA, "r1");
    assert.equal(job?.status, "interrupted");
  });

  it("checkpoints 记录并按序读出(job running 时)", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "r1", kind: "research_task" });
    const [job] = await claimNextJob(1); // 转 running
    assert.ok(await recordCheckpoint(job.id, "search_plan", "completed", { plan: "x" }));
    assert.ok(await recordCheckpoint(job.id, "metadata_results", "completed", { n: 3 }));
    const cps = await listCheckpoints(job.id);
    assert.deepEqual(cps.map((c) => c.phase), ["search_plan", "metadata_results"]);
    assert.deepEqual(cps[1].output, { n: 3 });
  });

  it("recordCheckpoint status guard:job 非 running 不写(挡 stale worker 长尾)", async (t) => {
    if (skip(t)) return;
    const job = await createJob({ userId: userA, requestId: "r1", kind: "ingest" });
    // queued(未 claim)→ checkpoint 应被 guard 挡掉
    assert.equal(await recordCheckpoint(job.id, "search_plan", "completed", { x: 1 }), false);
    assert.equal((await listCheckpoints(job.id)).length, 0);
    // claim → running → 可写;之后人为标 interrupted → 再写被挡
    await claimNextJob(1);
    assert.equal(await recordCheckpoint(job.id, "search_plan", "completed", { x: 1 }), true);
    await query("UPDATE research_jobs SET status = 'interrupted' WHERE id = $1", [job.id]);
    assert.equal(await recordCheckpoint(job.id, "metadata_results", "completed", { x: 2 }), false);
    assert.equal((await listCheckpoints(job.id)).length, 1);
  });

  it("并发 claimNextJob 不重复领取(SKIP LOCKED)", async (t) => {
    if (skip(t)) return;
    for (let i = 0; i < 6; i++) {
      await createJob({ userId: userA, requestId: `r${i}`, kind: "ingest" });
    }
    const [c1, c2] = await Promise.all([claimNextJob(6), claimNextJob(6)]);
    const ids = new Set([...c1, ...c2].map((j) => j.id));
    // 两次合计领取数 == 唯一 id 数(无重复领取)
    assert.equal(ids.size, c1.length + c2.length);
    assert.equal(ids.size, 6);
  });
});

// ─── store: documents / blobs / artifacts(tenant 隔离) ──────────────

function sampleDoc(docId: string): NormalizedDocument {
  return {
    docId,
    contentSha256: `sha-${docId}`,
    lang: "en",
    title: "Paper",
    spans: [
      { spanId: "s1", sectionPath: ["1"], charStart: 0, charEnd: 20, text: "Hello world example." },
    ],
    references: [],
  };
}

describe("research store: documents/blobs/artifacts", () => {
  it("putDocument/getDocument/getSpan + tenant 隔离", async (t) => {
    if (skip(t)) return;
    await putDocument({ userId: userA, doc: sampleDoc("doc1") });
    const got = await getDocument(userA, "doc1");
    assert.equal(got?.spans[0].text, "Hello world example.");
    // userB 看不到 userA 的文档(同 docId 也不串)
    assert.equal(await getDocument(userB, "doc1"), null);
    const span = await getSpan(userA, "doc1", "s1");
    assert.equal(span?.text, "Hello world example.");
    assert.equal(await getSpan(userB, "doc1", "s1"), null);
  });

  it("putBlob/getBlob + tenant 隔离(复合主键)", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userA, blobId: "b1", sha256: "h", sizeBytes: 10, storagePath: "/m/b1" });
    const got = await getBlob(userA, "b1");
    assert.equal(got?.storagePath, "/m/b1");
    assert.equal(await getBlob(userB, "b1"), null);
    // 两用户可各自持同名 blob_id(复合主键允许)
    await putBlob({ userId: userB, blobId: "b1", sha256: "h2", sizeBytes: 20, storagePath: "/m/b1-b" });
    assert.equal((await getBlob(userB, "b1"))?.storagePath, "/m/b1-b");
  });

  it("document.source_blob_id 同租户 FK:拒指向他人 blob", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userB, blobId: "bx", sha256: "h", sizeBytes: 5, storagePath: "/m/bx" });
    // userA 文档引用 userB 的 blob → FK(user_id, source_blob_id)不匹配 → 拒
    const doc = { ...sampleDoc("docA"), sourceBlobId: "bx" };
    await assert.rejects(putDocument({ userId: userA, doc }));
    // userA 引用自己的 blob → 通过
    await putBlob({ userId: userA, blobId: "bx", sha256: "h", sizeBytes: 5, storagePath: "/m/bx-a" });
    await putDocument({ userId: userA, doc });
    assert.equal((await getDocument(userA, "docA"))?.sourceBlobId, "bx");
    // 删 blob:列级 ON DELETE SET NULL(source_blob_id)只置空指针,不碰 NOT NULL user_id;
    // 文档仍在(权威 spans 已落地)。
    await query("DELETE FROM research_blobs WHERE user_id = $1 AND blob_id = 'bx'", [userA]);
    const stillThere = await getDocument(userA, "docA");
    assert.ok(stillThere, "blob 删除后文档仍存在");
    assert.equal(stillThere?.spans[0].text, "Hello world example.");
  });

  it("registerArtifact/listArtifacts", async (t) => {
    if (skip(t)) return;
    const job = await createJob({ userId: userA, requestId: "r1", kind: "render" });
    await registerArtifact({
      jobId: job.id,
      userId: userA,
      kind: "report",
      storagePath: "/home/agent/.openclaude/research/r1/report.pdf",
      mime: "application/pdf",
      sizeBytes: 1234,
    });
    const arts = await listArtifacts(userA);
    assert.equal(arts.length, 1);
    assert.equal(arts[0].kind, "report");
    assert.equal(arts[0].sizeBytes, 1234);
    assert.equal((await listArtifacts(userB)).length, 0);
  });
});

// ─── store: 保留策略 GC(blob TTL / artifacts 记录保留) ─────────────

describe("research store: retention gc", () => {
  it("putBlob 默认 expires_at = NOW()+30 天(未传/null 均兜底)", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userA, blobId: "b1", sha256: "h", sizeBytes: 1, storagePath: "/m/b1" });
    await putBlob({ userId: userA, blobId: "b2", sha256: "h", sizeBytes: 1, storagePath: "/m/b2", expiresAt: null });
    const r = await query<{ blob_id: string; days: number }>(
      `SELECT blob_id, EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400 AS days
         FROM research_blobs WHERE user_id = $1 ORDER BY blob_id`,
      [userA],
    );
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) {
      assert.ok(row.days !== null, `${row.blob_id} expires_at 不应为 NULL`);
      assert.ok(Number(row.days) > 29 && Number(row.days) < 31, `默认 TTL 应 ~30 天(实际 ${row.days})`);
    }
    // 显式传 expiresAt 仍尊重调用方
    const explicit = new Date(Date.now() + 3600_000);
    await putBlob({ userId: userA, blobId: "b3", sha256: "h", sizeBytes: 1, storagePath: "/m/b3", expiresAt: explicit });
    const r3 = await query<{ expires_at: Date }>(
      "SELECT expires_at FROM research_blobs WHERE user_id = $1 AND blob_id = 'b3'", [userA],
    );
    assert.ok(Math.abs(r3.rows[0].expires_at.getTime() - explicit.getTime()) < 1000);
  });

  it("gcExpiredBlobs:过期删(先文件后行),未过期保留;doc.source_blob_id 置空", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userA, blobId: "old", sha256: "h", sizeBytes: 1, storagePath: "/m/old" });
    await putBlob({ userId: userA, blobId: "fresh", sha256: "h", sizeBytes: 1, storagePath: "/m/fresh" });
    // 文档指向将被 GC 的 blob:验证列级 ON DELETE SET NULL 生效
    await putDocument({ userId: userA, doc: { ...sampleDoc("docGc"), sourceBlobId: "old" } });
    await query("UPDATE research_blobs SET expires_at = NOW() - INTERVAL '1 hour' WHERE blob_id = 'old'");
    const unlinked: string[] = [];
    const n = await gcExpiredBlobs({ unlinkImpl: async (p) => { unlinked.push(p); } });
    assert.equal(n, 1);
    assert.deepEqual(unlinked, ["/m/old"]);
    assert.equal(await getBlob(userA, "old"), null);
    assert.ok(await getBlob(userA, "fresh"), "未过期 blob 应保留");
    const doc = await query<{ source_blob_id: string | null }>(
      "SELECT source_blob_id FROM research_documents WHERE user_id = $1 AND doc_id = 'docGc'", [userA],
    );
    assert.equal(doc.rows[0].source_blob_id, null, "blob GC 后文档指针应置空(权威 spans 不受影响)");
  });

  it("gcExpiredBlobs:文件删失败不阻断行删(warn 上报)", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userA, blobId: "bad", sha256: "h", sizeBytes: 1, storagePath: "/m/bad" });
    await query("UPDATE research_blobs SET expires_at = NOW() - INTERVAL '1 hour' WHERE blob_id = 'bad'");
    const warns: string[] = [];
    const n = await gcExpiredBlobs({
      unlinkImpl: async () => { throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" }); },
      onWarn: (m) => warns.push(m),
    });
    assert.equal(n, 1, "文件删失败仍应删行");
    assert.equal(await getBlob(userA, "bad"), null);
    assert.ok(warns.some((w) => w.includes("/m/bad")));
  });

  it("gcOldArtifacts:超 180 天记录删,新记录保留", async (t) => {
    if (skip(t)) return;
    await registerArtifact({ userId: userA, kind: "report", storagePath: "/vol/old.pdf" });
    await registerArtifact({ userId: userA, kind: "bib", storagePath: "/vol/new.bib" });
    await query("UPDATE research_artifacts SET created_at = NOW() - INTERVAL '200 days' WHERE storage_path = '/vol/old.pdf'");
    const n = await gcOldArtifacts();
    assert.equal(n, 1);
    const left = await listArtifacts(userA);
    assert.equal(left.length, 1);
    assert.equal(left[0].storagePath, "/vol/new.bib");
  });

  it("runResearchGc:blob + artifacts 一轮清理(scheduler 每日 tick 入口)", async (t) => {
    if (skip(t)) return;
    await putBlob({ userId: userA, blobId: "old", sha256: "h", sizeBytes: 1, storagePath: "/tmp/oc-gc-not-exists" });
    await query("UPDATE research_blobs SET expires_at = NOW() - INTERVAL '1 hour' WHERE blob_id = 'old'");
    await registerArtifact({ userId: userA, kind: "report", storagePath: "/vol/old.pdf" });
    await query("UPDATE research_artifacts SET created_at = NOW() - INTERVAL '200 days'");
    const res = await runResearchGc(); // 默认 unlink:ENOENT 不阻断行删
    assert.equal(res.blobsDeleted, 1);
    assert.equal(res.artifactsDeleted, 1);
  });
});

// ─── scheduler: drain ────────────────────────────────────────────────

describe("research scheduler: drain", () => {
  it("派发 handler → completed;handler 抛错 → failed", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "ok", kind: "ingest" });
    await createJob({ userId: userA, requestId: "boom", kind: "index" });
    const res = await drainResearchJobs({
      handlers: {
        ingest: async () => ({ parsed: true }),
        index: async () => { throw new Error("boom"); },
      },
      onError: () => { /* silence */ },
    });
    assert.equal(res.picked, 2);
    assert.equal(res.completed, 1);
    assert.equal(res.failed, 1);
    assert.equal((await getJob(userA, "ok"))?.status, "completed");
    assert.equal((await getJob(userA, "boom"))?.status, "failed");
  });

  it("未注册 kind 的 job → failed(不无限 spin)", async (t) => {
    if (skip(t)) return;
    await createJob({ userId: userA, requestId: "r1", kind: "cite_check" });
    const res = await drainResearchJobs({ handlers: {}, onError: () => {} });
    assert.equal(res.failed, 1);
    const job = await getJob(userA, "r1");
    assert.equal(job?.status, "failed");
    assert.match(String(job?.error), /no handler/);
  });

  it("空队列 → ran:false", async (t) => {
    if (skip(t)) return;
    const res = await drainResearchJobs({ handlers: {} });
    assert.equal(res.ran, false);
    assert.equal(res.skipReason, "empty");
  });
});

// ─── researchConfig ──────────────────────────────────────────────────

describe("researchConfig", () => {
  it("默认 public:disabled + 缺省 config", async (t) => {
    if (skip(t)) return;
    const pub = await getResearchConfigPublic();
    assert.equal(pub.enabled, false);
    assert.equal(pub.config.ingest.engine, DEFAULT_RESEARCH_CONFIG.ingest.engine);
  });

  it("patch:校验通过则持久化 + 写 audit", async (t) => {
    if (skip(t)) return;
    const view = await patchResearchConfig(
      {
        enabled: true,
        config: {
          ...DEFAULT_RESEARCH_CONFIG,
          litSources: { openalexMailto: "x@y.com", s2Enabled: true },
        },
      },
      { adminId: userA },
    );
    assert.equal(view.enabled, true);
    assert.equal(view.config.litSources.openalexMailto, "x@y.com");
    const pub = await getResearchConfigPublic();
    assert.equal(pub.enabled, true);
    const audit = await query<{ action: string }>(
      "SELECT action FROM admin_audit WHERE action = 'research_config.patch'",
    );
    assert.equal(audit.rows.length, 1);
  });

  it("secret set/clear round-trip(明文不入 audit)", async (t) => {
    if (skip(t)) return;
    await setResearchSecret("s2ApiKey", "secret-xyz", { adminId: userA });
    const secrets = await getResearchSecrets();
    assert.equal(secrets.s2ApiKey, "secret-xyz");
    const view = await getResearchConfigView();
    assert.deepEqual(view.secretsSet, ["s2ApiKey"]);
    // audit 只写元信息,不含明文
    const audit = await query<{ after: { name: string; set: boolean } }>(
      "SELECT after FROM admin_audit WHERE action = 'research_config.secret' ORDER BY id DESC LIMIT 1",
    );
    assert.deepEqual(audit.rows[0].after, { name: "s2ApiKey", set: true });
    const auditJson = JSON.stringify(audit.rows[0]);
    assert.ok(!auditJson.includes("secret-xyz"), "明文不应出现在 audit");
    // clear
    await clearResearchSecret("s2ApiKey", { adminId: userA });
    assert.deepEqual((await getResearchSecrets()).s2ApiKey, undefined);
    assert.deepEqual((await getResearchConfigView()).secretsSet, []);
  });

  it("secret 损坏密文可被 admin 重设修复(不抛)", async (t) => {
    if (skip(t)) return;
    await setResearchSecret("s2ApiKey", "good", { adminId: userA });
    // 人为损坏密文(模拟 KMS key 轮换 / 字节损坏)
    await query("UPDATE research_config SET secret_ct = decode('00ff','hex') WHERE id = 1");
    // 旧路径 getResearchSecrets 会抛(解密失败);但 setSecret 必须能修复
    const view = await setResearchSecret("s2ApiKey", "fixed", { adminId: userA });
    assert.deepEqual(view.secretsSet, ["s2ApiKey"]);
    assert.equal((await getResearchSecrets()).s2ApiKey, "fixed");
    // audit 记录 priorDecryptFailed 供观测
    const audit = await query<{ before: unknown }>(
      "SELECT before FROM admin_audit WHERE action='research_config.secret' ORDER BY id DESC LIMIT 1",
    );
    assert.deepEqual(audit.rows[0].before, { priorDecryptFailed: true });
  });

  it("patch 拒非法 config(unknown 字段)", async (t) => {
    if (skip(t)) return;
    await assert.rejects(
      patchResearchConfig(
        { config: { ...DEFAULT_RESEARCH_CONFIG, evil: 1 } as never },
        { adminId: userA },
      ),
    );
  });
});

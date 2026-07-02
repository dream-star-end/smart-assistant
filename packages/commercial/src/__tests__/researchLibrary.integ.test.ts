/**
 * 用户文献库(research/library.ts)集成测试(真 PG):
 *   - listLibraryDocuments:元数据投影(spanCount/createdAt)+ tenant 隔离 + 新入库在前。
 *   - deleteLibraryDocument:真删返回 true;跨租户/不存在返回 false。
 *   - uploadAndIngestDocument:research 未开启 → {disabled};开启后 txt 直传 →
 *     铸权威文档(与 oc-ingest 同一 ingestBlob 链)并可 list 到。
 *
 * pg 不可用时 skip(CI 必须有 PG → REQUIRE_TEST_DB=1)。
 */

// KMS key(测试固定 32B base64)— 必须在 import crypto 前设好。
process.env.OPENCLAUDE_KMS_KEY =
  process.env.OPENCLAUDE_KMS_KEY ?? Buffer.alloc(32, 7).toString("base64");
// blob 落盘走独立临时目录,避免污染系统默认路径。
process.env.OC_RESEARCH_BLOB_DIR = `/tmp/oc-research-lib-test-${process.pid}`;

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import {
  deleteLibraryDocument,
  listLibraryDocuments,
  uploadAndIngestDocument,
} from "../research/library.js";
import { putDocument } from "../research/store.js";
import { DEFAULT_RESEARCH_CONFIG, patchResearchConfig } from "../admin/researchConfig.js";
import type { NormalizedDocument } from "@openclaude/protocol/research";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;
let userA = "0";
let userB = "0";

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try {
      await p.end();
    } catch {
      /* */
    }
    return false;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await query("DROP SCHEMA public CASCADE");
  await query("CREATE SCHEMA public");
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try {
      await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } catch {
      /* */
    }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE research_jobs, research_phase_checkpoints, research_documents, research_artifacts, research_blobs, users RESTART IDENTITY CASCADE",
  );
  await query("INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  // 默认 enabled=false;单测各自按需 patch。
  await query("UPDATE research_config SET enabled = FALSE WHERE id = 1");
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
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

function sampleDoc(docId: string, title = "Paper"): NormalizedDocument {
  return {
    docId,
    contentSha256: `sha-${docId}`,
    lang: "en",
    title,
    spans: [
      { spanId: "s1", sectionPath: ["1"], charStart: 0, charEnd: 20, text: "Hello world example." },
      { spanId: "s2", sectionPath: ["2"], charStart: 20, charEnd: 33, text: "Second span." },
    ],
    references: [],
  };
}

describe("research library: list/delete", () => {
  it("list:元数据投影 + tenant 隔离", async (t) => {
    if (skip(t)) return;
    await putDocument({ userId: userA, doc: sampleDoc("doc1", "First") });
    await putDocument({ userId: userA, doc: sampleDoc("doc2", "Second") });
    await putDocument({ userId: userB, doc: sampleDoc("doc9", "OtherTenant") });

    const docs = await listLibraryDocuments(userA);
    assert.equal(docs.length, 2);
    const ids = docs.map((d) => d.docId).sort();
    assert.deepEqual(ids, ["doc1", "doc2"]);
    const d1 = docs.find((d) => d.docId === "doc1");
    assert.equal(d1?.title, "First");
    assert.equal(d1?.lang, "en");
    assert.equal(d1?.spanCount, 2);
    assert.ok(d1 && !Number.isNaN(Date.parse(d1.createdAt)));
    // 权威 span 文本绝不外泄到 list 投影
    assert.ok(!JSON.stringify(docs).includes("Hello world"));
  });

  it("delete:真删 true;跨租户/不存在 false", async (t) => {
    if (skip(t)) return;
    await putDocument({ userId: userA, doc: sampleDoc("doc1") });
    assert.equal(await deleteLibraryDocument(userB, "doc1"), false); // 跨租户删不掉
    assert.equal(await deleteLibraryDocument(userA, "doc1"), true);
    assert.equal(await deleteLibraryDocument(userA, "doc1"), false); // 已删
    assert.equal((await listLibraryDocuments(userA)).length, 0);
  });
});

describe("research library: upload+ingest", () => {
  it("research 未开启 → disabled(调用方 503)", async (t) => {
    if (skip(t)) return;
    const r = await uploadAndIngestDocument(Number(userA), Buffer.from("hi"), "text/plain", "a.txt");
    assert.ok("disabled" in r && r.disabled);
  });

  it("开启后 txt 直传 → 铸权威文档 + list 可见", async (t) => {
    if (skip(t)) return;
    await patchResearchConfig(
      { enabled: true, config: { ...DEFAULT_RESEARCH_CONFIG } },
      { adminId: userA },
    );
    const text = "# 标题\n\n这是一段用于入库的中文正文,足够长以形成有效 span。";
    const r = await uploadAndIngestDocument(
      Number(userA),
      Buffer.from(text, "utf8"),
      "text/markdown",
      "note.md",
    );
    assert.ok(!("disabled" in r));
    assert.ok(r.ok, `ingest should succeed: ${JSON.stringify(r)}`);
    if (r.ok) {
      assert.ok(r.outline.docId);
      const docs = await listLibraryDocuments(userA);
      assert.equal(docs.length, 1);
      assert.equal(docs[0].docId, r.outline.docId);
      assert.ok(docs[0].spanCount >= 1);
    }
  });
});

/**
 * V3 CC 外接 plan Phase 1 — `auth/apiKeyRepo.ts` unit 测试。
 *
 * 跑法: npx tsx --test src/__tests__/apiKeyRepo.unit.test.ts
 *
 * 覆盖 plan §4 不变量:
 *   - #1 No plaintext storage:bind 中只有 hash(Buffer),无任何 secret 明文/hex 子串。
 *     额外锁住 "hash = SHA-256(raw 24 bytes)" 同型(Codex Phase 1 MINOR #2)— 从
 *     `created.plaintext` 拆出 secretHex,自己用 SHA-256 算,断言 == bind[3]。
 *     这一颗钉子防止未来有人手滑写成 `sha256(secretHex)` 字符串路径(跟容器 token
 *     不一致),Phase 0 hash 同型契约在 Phase 1 / Phase 2 都必须维持。
 *   - #3 Prefix collision retry:
 *     • 第一次冲突 → 第二次成功,calls.length === 2
 *     • 三次都冲突 → 抛 PREFIX_COLLISION_RETRIES_EXHAUSTED,calls.length === 3 锁上限
 *
 * 边界:
 *   - 非 23505 错误不重试(透传原 err)
 *   - label 空/全空格/超长 → LABEL_INVALID,不查 DB
 *   - findByPrefix 非法格式 → 返 null,不查 DB
 *   - list 不返 keyHash 字段(invariant #1 的返回结构契约)
 *   - findByPrefix WHERE 必须含 revoked_at IS NULL(Codex Phase 1 MINOR #1)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, QueryResult, QueryResultRow } from "pg";

import { makePgApiKeyRepo, ApiKeyRepoError } from "../auth/apiKeyRepo.js";

interface QueryCall {
  text: string;
  values: unknown[];
}

type QueryResponse =
  | { kind: "rows"; rows: QueryResultRow[]; rowCount: number }
  | { kind: "error"; err: Error & { code?: string; constraint?: string } };

function ok(rows: QueryResultRow[], rowCount = rows.length): QueryResponse {
  return { kind: "rows", rows, rowCount };
}

function pgError(code: string, constraint?: string): QueryResponse {
  const err = new Error(`postgres ${code}${constraint ? ` (${constraint})` : ""}`) as Error & {
    code?: string;
    constraint?: string;
  };
  err.code = code;
  if (constraint !== undefined) err.constraint = constraint;
  return { kind: "error", err };
}

/** Sequence-mock pool:每次 query() 弹一个预设响应。多了报错,少了报错。 */
function makeMockPool(responses: QueryResponse[]): {
  pool: Pool;
  calls: QueryCall[];
  remaining: () => number;
} {
  const calls: QueryCall[] = [];
  let idx = 0;
  const pool = {
    query: async (text: string, values: unknown[]): Promise<QueryResult> => {
      calls.push({ text, values });
      if (idx >= responses.length) {
        throw new Error(`mock pool: unexpected query #${idx + 1} (only ${responses.length} responses prepared)`);
      }
      const r = responses[idx++]!;
      if (r.kind === "error") throw r.err;
      return {
        rows: r.rows,
        rowCount: r.rowCount,
        command: "INSERT",
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;
  return { pool, calls, remaining: () => responses.length - idx };
}

describe("apiKeyRepo.create — invariant #1 (no plaintext) + hash 同型契约", () => {
  test("INSERT bind = [user_id_str, label_trim, prefix, key_hash Buffer]", async () => {
    const fixedDate = new Date("2026-05-18T00:00:00Z");
    const { pool, calls } = makeMockPool([ok([{ id: "42", created_at: fixedDate }])]);
    const repo = makePgApiKeyRepo(pool);

    const created = await repo.create(100n, "  test key  ");

    assert.equal(calls.length, 1);
    const bind = calls[0]!.values;
    assert.equal(bind[0], "100", "user_id 必须 stringify");
    assert.equal(bind[1], "test key", "label 必须 trim 后入库");
    assert.match(bind[2] as string, /^[0-9a-z]{8}$/, "prefix 必须是 8 字符 lowercase base36");
    assert.ok(Buffer.isBuffer(bind[3]), "key_hash bind 必须是 Buffer");
    assert.equal((bind[3] as Buffer).length, 32, "SHA-256 = 32 bytes");

    // plaintext 形如 oc-cc.<8 base36>.<48 hex>
    assert.match(created.plaintext, /^oc-cc\.[0-9a-z]{8}\.[0-9a-f]{48}$/);
    assert.equal(created.id, 42n);
    assert.equal(created.label, "test key");
    assert.equal(created.keyPrefix, bind[2]);
    assert.equal(created.createdAt, fixedDate);
  });

  test("bind 中无任何 secret 明文/hex 子串(invariant #1)", async () => {
    const { pool, calls } = makeMockPool([ok([{ id: "1", created_at: new Date() }])]);
    const repo = makePgApiKeyRepo(pool);
    const created = await repo.create(1n, "label");

    const secretHex = created.plaintext.split(".")[2]!; // 48 hex
    const fullPlaintext = created.plaintext;            // oc-cc.<prefix>.<secretHex>

    // 把每个 bind 位转 string 拼起来,确保 secret 明文一定不存在
    const allBindStr = calls[0]!.values
      .map((v) => (Buffer.isBuffer(v) ? v.toString("hex") : String(v)))
      .join("|");

    assert.ok(!allBindStr.includes(secretHex), "secret hex 不能出现在任何 bind 位");
    assert.ok(!allBindStr.includes(fullPlaintext), "完整 plaintext 不能出现在任何 bind 位");
  });

  test("hash 必须 = SHA-256(Buffer.from(secretHex, 'hex')) — 同型契约(Codex MINOR #2)", async () => {
    // 这颗钉子防未来手滑改成 sha256(secretHex 字符串),会跟容器 token verify 长出不一致行为。
    const { pool, calls } = makeMockPool([ok([{ id: "1", created_at: new Date() }])]);
    const repo = makePgApiKeyRepo(pool);
    const created = await repo.create(1n, "label");

    const secretHex = created.plaintext.split(".")[2]!;
    const expectedHash = createHash("sha256")
      .update(Buffer.from(secretHex, "hex"))
      .digest();
    assert.deepStrictEqual(
      calls[0]!.values[3],
      expectedHash,
      "key_hash 必须等于 SHA-256(raw 24 bytes),不能是 sha256(secretHex 字符串)",
    );
  });
});

describe("apiKeyRepo.create — invariant #3 prefix 碰撞重试", () => {
  test("第一次冲突 → 第二次成功,calls.length === 2", async () => {
    const { pool, calls } = makeMockPool([
      pgError("23505", "user_api_keys_key_prefix_key"),
      ok([{ id: "2", created_at: new Date() }]),
    ]);
    const repo = makePgApiKeyRepo(pool);
    const created = await repo.create(100n, "lbl");
    assert.equal(calls.length, 2, "第 1 次失败 + 第 2 次成功 = 2 次查询");
    assert.equal(created.id, 2n);
    // 第 2 次的 prefix 必须跟第 1 次不同(每次重新生成)
    assert.notEqual(calls[0]!.values[2], calls[1]!.values[2], "重试必须生成新 prefix");
  });

  test("三次都冲突 → 抛 PREFIX_COLLISION_RETRIES_EXHAUSTED,calls.length === 3 锁上限", async () => {
    const { pool, calls } = makeMockPool([
      pgError("23505", "user_api_keys_key_prefix_key"),
      pgError("23505", "user_api_keys_key_prefix_key"),
      pgError("23505", "user_api_keys_key_prefix_key"),
    ]);
    const repo = makePgApiKeyRepo(pool);
    await assert.rejects(
      repo.create(100n, "lbl"),
      (err: unknown) =>
        err instanceof ApiKeyRepoError &&
        err.code === "PREFIX_COLLISION_RETRIES_EXHAUSTED",
    );
    assert.equal(calls.length, 3, "重试上限严格 = 3 次,不能多不能少");
  });

  test("非 23505 错误不重试,直接透传", async () => {
    const fkErr = pgError("23503", "user_api_keys_user_id_fkey"); // FK violation
    const { pool, calls } = makeMockPool([fkErr]);
    const repo = makePgApiKeyRepo(pool);
    await assert.rejects(repo.create(999999n, "lbl"), (err: unknown) => {
      // 不能被包装成 ApiKeyRepoError;原 PG 错码透传
      const e = err as { code?: string };
      return e.code === "23503";
    });
    assert.equal(calls.length, 1, "非 23505 必须立即退出,不应触发重试");
  });

  test("23505 但 constraint 不是 key_prefix → 不重试(其它 UNIQUE 冲突透传)", async () => {
    // 假设 (user_id, label) 未来有 UNIQUE 约束,label 冲突应直接报错不重试
    const labelErr = pgError("23505", "user_api_keys_user_label_unique_hypothetical");
    const { pool, calls } = makeMockPool([labelErr]);
    const repo = makePgApiKeyRepo(pool);
    await assert.rejects(repo.create(1n, "lbl"), (err: unknown) => {
      const e = err as { code?: string };
      return e.code === "23505";
    });
    assert.equal(calls.length, 1, "23505 但非 key_prefix 约束,不应重试");
  });
});

describe("apiKeyRepo.create — label 校验早 fail", () => {
  test("空 / 全空格 / 超长 label → LABEL_INVALID,不查 DB", async () => {
    for (const bad of ["", "  ", "\t\n  ", "a".repeat(81)]) {
      const { pool, calls } = makeMockPool([]);
      const repo = makePgApiKeyRepo(pool);
      await assert.rejects(
        repo.create(1n, bad),
        (err: unknown) =>
          err instanceof ApiKeyRepoError && err.code === "LABEL_INVALID",
        `label="${bad}" 必须 reject 为 LABEL_INVALID`,
      );
      assert.equal(calls.length, 0, `label="${bad}" 不应触发 DB 查询`);
    }
  });

  test("非 string label(undefined/null/number)→ LABEL_INVALID", async () => {
    const repo = makePgApiKeyRepo(makeMockPool([]).pool);
    for (const bad of [undefined, null, 42, {}, []]) {
      await assert.rejects(
        repo.create(1n, bad as unknown as string),
        (err: unknown) =>
          err instanceof ApiKeyRepoError && err.code === "LABEL_INVALID",
      );
    }
  });
});

describe("apiKeyRepo.findByPrefix", () => {
  test("非法格式 → 直接返 null,不查 DB", async () => {
    const { pool, calls } = makeMockPool([]);
    const repo = makePgApiKeyRepo(pool);
    for (const bad of ["BADPRFX!", "short", "a".repeat(9), "UPPERCAS", "abc-1234", ""]) {
      assert.equal(await repo.findByPrefix(bad), null, `prefix="${bad}" 应返 null`);
    }
    assert.equal(calls.length, 0, "非法 prefix 不应触发 DB 查询");
  });

  test("合法 prefix + DB 返 0 行 → null", async () => {
    const { pool, calls } = makeMockPool([ok([])]);
    const repo = makePgApiKeyRepo(pool);
    assert.equal(await repo.findByPrefix("abcd1234"), null);
    assert.equal(calls.length, 1);
  });

  test("SQL WHERE 必须含 revoked_at IS NULL(Codex Phase 1 MINOR #1)", async () => {
    // findByPrefix 严格返 active key;revoked row 与 missing 合并成 null
    const { pool, calls } = makeMockPool([ok([])]);
    const repo = makePgApiKeyRepo(pool);
    await repo.findByPrefix("abcd1234");
    assert.match(calls[0]!.text, /revoked_at IS NULL/, "SQL 必须过滤 revoked_at IS NULL");
  });

  test("合法 prefix + DB 返 1 行 → map 成 ApiKeyRow(含 keyHash 给 strategy 用)", async () => {
    const hash = Buffer.alloc(32, 0xab);
    const ts = new Date("2026-05-18T01:00:00Z");
    const { pool } = makeMockPool([
      ok([{
        id: "7",
        user_id: "100",
        label: "lbl",
        key_prefix: "abcd1234",
        key_hash: hash,
        created_at: ts,
        last_used_at: null,
      }]),
    ]);
    const repo = makePgApiKeyRepo(pool);
    const row = await repo.findByPrefix("abcd1234");
    assert.ok(row);
    assert.equal(row!.id, 7n);
    assert.equal(row!.userId, 100n);
    assert.equal(row!.keyPrefix, "abcd1234");
    assert.deepStrictEqual(row!.keyHash, hash);
    assert.equal(row!.lastUsedAt, null);
  });
});

describe("apiKeyRepo.list — invariant #1 返回结构无 keyHash 字段", () => {
  test("SELECT 不含 key_hash 列(invariant #1 SQL 层钉子)", async () => {
    const { pool, calls } = makeMockPool([ok([])]);
    const repo = makePgApiKeyRepo(pool);
    await repo.list(100n);
    const sql = calls[0]!.text;
    assert.doesNotMatch(sql, /key_hash/, "list SQL 绝不能 SELECT key_hash 列");
    assert.match(sql, /revoked_at IS NULL/, "list 只列未撤销 key");
  });

  test("返回结构无 keyHash 字段 — 即使 DB 误返 hash 也不外泄", async () => {
    // 故意让 mock 在每行**额外**塞 key_hash(真 DB 一般不会,但本测试就是要证明
    // 即使发生了,mapSummaryRow 也不会让它穿透到对外结构)。
    const leaked = Buffer.alloc(32, 0xff);
    const { pool } = makeMockPool([
      ok([
        {
          id: "1",
          label: "a",
          key_prefix: "abcd0001",
          created_at: new Date("2026-05-18T00:00:00Z"),
          last_used_at: null,
          key_hash: leaked,
        },
        {
          id: "2",
          label: "b",
          key_prefix: "abcd0002",
          created_at: new Date("2026-05-18T01:00:00Z"),
          last_used_at: new Date("2026-05-18T02:00:00Z"),
          key_hash: leaked,
        },
      ]),
    ]);
    const repo = makePgApiKeyRepo(pool);
    const arr = await repo.list(100n);
    assert.equal(arr.length, 2);
    for (const item of arr) {
      assert.ok(!("keyHash" in item), "ApiKeySummary 不应有 keyHash 字段");
      assert.ok(!("key_hash" in item), "也不应有 snake_case 漏字段");
    }
    assert.equal(arr[0]!.id, 1n);
    assert.equal(arr[1]!.lastUsedAt?.getTime(), new Date("2026-05-18T02:00:00Z").getTime());
  });
});

describe("apiKeyRepo.revoke", () => {
  test("更新到一行 → true", async () => {
    const { pool, calls } = makeMockPool([ok([], 1)]);
    const repo = makePgApiKeyRepo(pool);
    assert.equal(await repo.revoke(100n, 7n), true);
    assert.match(calls[0]!.text, /revoked_at = now\(\)/);
    assert.match(calls[0]!.text, /revoked_at IS NULL/, "只撤销 active key,防重复撤销改时间戳");
    assert.equal(calls[0]!.values[0], "100");
    assert.equal(calls[0]!.values[1], "7");
  });

  test("无匹配(不存在 / 已撤销 / 不属本 user)→ false", async () => {
    const { pool } = makeMockPool([ok([], 0)]);
    const repo = makePgApiKeyRepo(pool);
    assert.equal(await repo.revoke(100n, 999n), false);
  });
});

describe("apiKeyRepo.touchLastUsed", () => {
  test("更新 last_used_at,repo 不 catch 错误(strategy 层 best-effort)", async () => {
    const { pool, calls } = makeMockPool([ok([], 1)]);
    const repo = makePgApiKeyRepo(pool);
    await repo.touchLastUsed(7n);
    assert.match(calls[0]!.text, /last_used_at = now\(\)/);
    assert.equal(calls[0]!.values[0], "7");
  });

  test("DB error → throw(让 caller decide;Phase 2 strategy 会 .catch)", async () => {
    const { pool } = makeMockPool([pgError("57014", "statement_timeout")]);
    const repo = makePgApiKeyRepo(pool);
    await assert.rejects(repo.touchLastUsed(7n), (err: unknown) => {
      const e = err as { code?: string };
      return e.code === "57014";
    });
  });
});

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { closePool, setPoolOverride } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

/**
 * T-02 round 3 回归测试:
 *
 * 规约:pg_advisory_unlock 失败时(例如连接已坏/网络抖动),
 *   (a) 原始错误(若有)必须向外抛出,unlock 错误只 log,不遮蔽
 *   (b) 这个 client 必须被销毁(release(err)),不能静默还回 pool,
 *       否则它持有的 session-level advisory lock 会跟连接一起活在池里,
 *       导致下次 migrate 卡在 advisory_lock
 *
 * 实现策略:用一个手搓 fake Pool/PoolClient,只需实现被 migrate.ts 调到的最小接口;
 * 通过 setPoolOverride 注入,避开真实 pg。
 */

interface FakeClientOptions {
  /** 除 schema_migrations SELECT 外,第一条 query 是否抛错(模拟 migration 失败)。 */
  failMigrationSql?: boolean;
  /** pg_advisory_unlock 是否抛错。 */
  failUnlock?: boolean;
}

type ReleaseArg = Error | boolean | undefined;

interface FakeHandles {
  pool: Pool;
  released: ReleaseArg[];
  unlockCalled: { count: number };
}

function makeFake(opts: FakeClientOptions): FakeHandles {
  const released: ReleaseArg[] = [];
  const unlockCalled = { count: 0 };

  const client = {
    async query(sql: string, _args?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      // 匹配顺序很重要:unlock/lock 优先,再看 SELECT version,再看其他
      if (/pg_advisory_lock/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/pg_advisory_unlock/i.test(sql)) {
        unlockCalled.count += 1;
        if (opts.failUnlock) {
          throw new Error("simulated unlock failure");
        }
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT version FROM schema_migrations/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // 其余视为 migration 的 DDL:可选失败
      if (opts.failMigrationSql) {
        throw new Error("simulated migration SQL failure");
      }
      return { rows: [], rowCount: 0 };
    },
    release(err?: Error | boolean) {
      released.push(err);
    },
  };

  const pool = {
    async query(_sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
      // schema_migrations DDL (IF NOT EXISTS)
      return { rows: [], rowCount: 0 };
    },
    async connect(): Promise<PoolClient> {
      return client as unknown as PoolClient;
    },
    async end(): Promise<void> { /* noop */ },
    on() { /* noop */ },
  };

  return {
    pool: pool as unknown as Pool,
    released,
    unlockCalled,
  };
}

describe("runMigrations: advisory_unlock failure handling", () => {
  afterEach(async () => {
    // setPoolOverride 注入的是 fake,closePool() 会调到 fake.end()
    await closePool();
  });

  test("when unlock fails after successful migrate, client is destroyed (release(err))", async () => {
    const fake = makeFake({ failUnlock: true });
    setPoolOverride(fake.pool);

    // 内层成功(无 migration 文件,applied=[])、unlock 抛错 → runMigrations 应该
    // 正常返回(unlock 失败不遮蔽也不升级为错误),但 client 必须被销毁。
    // 用一个不存在的目录得到 []。
    const result = await runMigrations({ dir: "/tmp/__nonexistent_mig_dir_for_test__" });
    assert.deepEqual(result.applied, []);
    assert.equal(fake.unlockCalled.count, 1, "unlock should be attempted");
    assert.equal(fake.released.length, 1, "release called exactly once");
    assert.ok(
      fake.released[0] instanceof Error,
      `expected release(Error), got ${typeof fake.released[0]}: ${String(fake.released[0])}`,
    );
    assert.match((fake.released[0] as Error).message, /unlock/i);
  });

  test("happy path: unlock succeeds → client returned to pool (release() with no arg)", async () => {
    const fake = makeFake({});
    setPoolOverride(fake.pool);

    const result = await runMigrations({ dir: "/tmp/__nonexistent_mig_dir_for_test2__" });
    assert.deepEqual(result.applied, []);
    assert.equal(fake.unlockCalled.count, 1);
    assert.equal(fake.released.length, 1);
    assert.equal(
      fake.released[0],
      undefined,
      "on success release() must be called with no argument so client goes back to pool",
    );
  });

  test("when BOTH migration and unlock fail, original migration error propagates; client destroyed", async () => {
    // 这是 round 2 的关键回归:内层 migration SQL 抛 A,紧接着 unlock 抛 B,
    // 必须向外抛 A(migration 真正原因),B 只 log。并且 client 要 release(err) 销毁。
    //
    // 我们需要让 listMigrations 返回一条记录才能触发 migration SQL 执行。
    // 用 node:fs 写一个临时目录 + 一个 .sql 文件。
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "mig-bothfail-"));
    try {
      await writeFile(
        path.join(dir, "0001_any.sql"),
        "CREATE TABLE whatever (id INTEGER);",
        "utf8",
      );

      const fake = makeFake({ failMigrationSql: true, failUnlock: true });
      setPoolOverride(fake.pool);

      await assert.rejects(
        runMigrations({ dir }),
        (err: unknown) => {
          assert.ok(err instanceof Error, "should throw Error");
          assert.match(
            (err as Error).message,
            /migration SQL failure/,
            `expected migration failure, got: ${(err as Error).message}`,
          );
          return true;
        },
      );

      assert.equal(fake.unlockCalled.count, 1, "unlock must still be attempted in finally");
      assert.equal(fake.released.length, 1, "release called exactly once");
      assert.ok(
        fake.released[0] instanceof Error,
        "release must receive an Error to destroy the client",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

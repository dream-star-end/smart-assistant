import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { getPool } from "./index.js";

/**
 * 迁移系统(T-02)。
 *
 * - 迁移文件:`packages/commercial/src/db/migrations/NNNN_*.sql`
 *   文件名前缀 4 位数字,按 lexical(等价 numeric)顺序应用
 * - 版本表 `schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`
 *   `version` = 文件名去除 `.sql` 扩展名,例如 `0001_init_users_auth`
 * - 每个迁移文件在独立事务中应用:
 *     BEGIN → 执行整个 SQL → INSERT schema_migrations → COMMIT
 *   任一失败 → ROLLBACK,该迁移的 DDL 全部回退(Postgres 支持事务 DDL)
 * - 用 pg_advisory_lock 串行化多进程/多实例的并发迁移,避免竞态
 *
 * 安全规约:
 * - 不自动 ROLLBACK 已 applied 的迁移(不可逆操作不应被框架隐式回滚)
 * - 完整性校验:
 *     (a) schema_migrations 中已 applied 的 version 必须在目录里有对应 `.sql`,
 *         否则抛错(防止有人删掉历史 migration 文件造成静默漂移)
 *     (b) 新增的 .sql 文件版本号必须严格大于所有已 applied 的版本
 *         (防止回填编号 0003,而 0005 已经跑过这种 "out-of-order" 状态)
 * - 允许编号不连续(例如 0001、0005、0010):项目有时会预留号段,
 *   硬要求"不跳号"太僵;但"新插入的版本号必须 > max(applied)"足以防止漂移
 *
 * 并发:
 * - 整个 migrate 用 *同一个* 持锁 client(client A)串行执行所有 migration
 *   事务;不再借第二个 client 跑 tx。这样避免在 pool 容量紧张(极端情况 max=1)时
 *   A 等 B 的资源死锁边界
 *
 * 设计注意:
 * - migrate 由 CLI(`npm run migrate:commercial`)或启动时自动执行
 * - 测试可以传 `{ dir }` 指向临时目录,跑不同迁移集
 */

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

/**
 * pg advisory lock 的 key。64-bit int,取一个项目私有的常量。
 * 选值:SHA-1('openclaude-commercial.migrate') 前 8 字节截成 bigint。
 * 这里直接硬编码一个独特 magic 常量,简单够用。
 */
const MIGRATE_ADVISORY_LOCK_ID = 0x0c_be_1e_5a_01n; // 'openclaude' + magic

export interface MigrationsOptions {
  /**
   * 迁移文件目录。默认指向 packages/commercial/src/db/migrations/
   * (相对于 migrate.ts 自己位置,而非 cwd)。
   */
  dir?: string;
  /**
   * 可选:每应用一个迁移的回调(用于日志/测试观察)。
   */
  onApply?: (version: string) => void;
}

export interface MigrationResult {
  /** 本次新应用的 version 列表(按应用顺序)。 */
  applied: string[];
  /** 本次跳过的(已在 schema_migrations 中)version 列表。 */
  skipped: string[];
}

/** 内部:默认迁移目录。 */
function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}

/**
 * 扫描目录,返回按文件名排序的 `{version, file}` 列表。
 * 只接受 `*.sql`,其他文件忽略(README / .bak / 隐藏文件等)。
 */
async function listMigrations(
  dir: string,
): Promise<Array<{ version: string; file: string }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({
      version: file.slice(0, -".sql".length),
      file,
    }));
}

/**
 * 执行迁移。
 *
 * 整个过程串行,加 transaction advisory lock 防止并发。
 * 失败时抛出原错误,调用方(CLI)应 log 并 `process.exit(1)`。
 */
export async function runMigrations(
  opts: MigrationsOptions = {},
): Promise<MigrationResult> {
  const dir = opts.dir ?? defaultMigrationsDir();
  const pool = getPool();

  // 先确保 schema_migrations 表存在(在 advisory lock 之外就做,用 IF NOT EXISTS 幂等)。
  // 不放 lock 内:进入 lock 后第一件事就 SELECT 它,存在性必须先保证。
  await pool.query(SCHEMA_MIGRATIONS_DDL);

  // 拿一个独立 client,用它持有 session-level advisory lock,整个 migrate 期间独占。
  const client = await pool.connect();
  // session-scoped advisory lock 绑在这个 backend 连接上,只有在连接关闭或显式 unlock
  // 时才释放。普通 release() 是把连接还回 pool 继续复用 —— 复用时锁还在,下次 migrate
  // 会卡在 pg_advisory_lock。所以 unlock 失败必须把连接「销毁」(pg 的 release(err)),
  // 而不是还回 pool。
  let unlockError: unknown;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_ADVISORY_LOCK_ID]);
    try {
      return await runMigrationsInner(client, dir, opts);
    } finally {
      // 注意:如果内层 runMigrationsInner 抛错,client 可能处于不可用状态,
      // 再执行 unlock 会抛新错覆盖真正原因。这里 try/catch 吞掉 unlock 本身的错,
      // 仅 log —— 目标是不让清理步骤遮蔽真正的 migration 失败原因。
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_ADVISORY_LOCK_ID]);
      } catch (err) {
        unlockError = err;
        // eslint-disable-next-line no-console
        console.error(
          "[commercial/migrate] advisory_unlock failed (ignored to preserve original error):",
          err,
        );
      }
    }
  } finally {
    if (unlockError !== undefined) {
      // 传 error 进 release() 让 pg 销毁这个 client(而不是还回 pool),
      // 防止尚未释放的 session advisory lock 卡死后续 migrate。
      client.release(unlockError as Error);
    } else {
      client.release();
    }
  }
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

/**
 * 完整性校验:
 *   (a) schema_migrations 里的 version 必须每条都能在 dir 中找到对应 .sql,
 *       否则抛(防止历史文件被删)
 *   (b) 任何 new(unapplied)的文件版本号必须 > max(applied),
 *       否则抛(防止回填低号;例如 applied=[0001,0005],然后新增 0003)
 *
 * (b) 用 lexical 比较足够:我们的 version 格式是 4-digit 前缀。
 */
function verifyIntegrity(
  files: ReadonlyArray<{ version: string; file: string }>,
  applied: ReadonlySet<string>,
): void {
  const fileVersions = new Set(files.map((f) => f.version));
  // (a) 已 applied 的文件是否还在
  const missing: string[] = [];
  for (const v of applied) {
    if (!fileVersions.has(v)) missing.push(v);
  }
  if (missing.length > 0) {
    throw new MigrationIntegrityError(
      `applied migration(s) missing from dir: ${missing.sort().join(", ")}`,
    );
  }

  // (b) 任何 unapplied 版本必须严格大于 max(applied)
  if (applied.size === 0) return;
  let maxApplied = "";
  for (const v of applied) if (v > maxApplied) maxApplied = v;

  const outOfOrder: string[] = [];
  for (const { version } of files) {
    if (applied.has(version)) continue;
    if (version < maxApplied) outOfOrder.push(version);
  }
  if (outOfOrder.length > 0) {
    throw new MigrationIntegrityError(
      `out-of-order migration(s) ${outOfOrder.sort().join(", ")} are older than latest applied (${maxApplied}); ` +
        "bump their version so they sort after the latest applied migration",
    );
  }
}

async function runMigrationsInner(
  client: PoolClient,
  dir: string,
  opts: MigrationsOptions,
): Promise<MigrationResult> {
  const files = await listMigrations(dir);

  const appliedRows = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const alreadyApplied = new Set(appliedRows.rows.map((r) => r.version));

  verifyIntegrity(files, alreadyApplied);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const { version, file } of files) {
    if (alreadyApplied.has(version)) {
      skipped.push(version);
      continue;
    }

    const sql = await readFile(path.join(dir, file), "utf8");

    // 直接在持锁 client A 上 BEGIN/COMMIT,不借第二个 client:
    //   - advisory lock 是 session 级,不影响 A 自己开事务
    //   - 避免 pool 容量紧张时 A 等 B 的资源死锁边界
    //   - Postgres 支持事务 DDL,失败 ROLLBACK 能完整回退
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // rollback 自身失败(连接已挂等)不应遮蔽原错
      }
      throw err;
    }

    applied.push(version);
    opts.onApply?.(version);
  }

  return { applied, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// CLI 入口:`tsx packages/commercial/src/db/migrate.ts` 或 `npm run migrate:commercial`
// ─────────────────────────────────────────────────────────────────────────

function isCliEntry(): boolean {
  const thisFile = fileURLToPath(import.meta.url);
  return process.argv[1] === thisFile;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("[commercial/migrate] starting...");
  const r = await runMigrations({
    // eslint-disable-next-line no-console
    onApply: (v) => console.log(`[commercial/migrate] applied ${v}`),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[commercial/migrate] done. applied=${r.applied.length} skipped=${r.skipped.length}`,
  );
}

if (isCliEntry()) {
  main()
    .then(async () => {
      const { closePool } = await import("./index.js");
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error("[commercial/migrate] failed:", err);
      try {
        const { closePool } = await import("./index.js");
        await closePool();
      } catch { /* ignore */ }
      process.exit(1);
    });
}

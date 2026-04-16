import { Pool, type PoolConfig } from "pg";
import { loadConfig } from "../config.js";

/**
 * PostgreSQL connection pool — 单进程单例。
 *
 * 参见 docs/commercial/02-ARCHITECTURE §3.
 *
 * 规约:
 *   - 进程内第一次 `getPool()` 触发 lazy init
 *   - 最大连接数默认 50(MVP 单机足够)
 *   - idle 超过 30s 自动释放
 *   - statement_timeout 30s,防止 N+1 或慢查询卡死 pool
 *   - 测试通过 `setPoolOverride(pool)` 注入 mock/独立 pool;用完 `resetPool()`
 */

let pool: Pool | null = null;

export interface CreatePoolOptions {
  /** 可选 override connection string。默认 loadConfig().DATABASE_URL。 */
  connectionString?: string;
  /** 最大连接数,默认 50。 */
  max?: number;
  /** idle 超时,ms。 */
  idleTimeoutMillis?: number;
  /** 建连超时,ms。 */
  connectionTimeoutMillis?: number;
  /** 单 statement 超时,ms。 */
  statementTimeoutMs?: number;
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${String(v)}`);
  }
  return v;
}

/** 构造一个新 Pool(不注册为全局单例)。 */
export function createPool(opts: CreatePoolOptions = {}): Pool {
  // `statement_timeout` 作为 pg startup parameter 在握手期下发(node-postgres
  // ClientConfig 字段),不会出现"SET 尚未执行,业务 query 已先行"的竞态。
  // 不要再用 connect 事件 fire-and-forget SET 的写法。
  const statementTimeout = positiveInt("statementTimeoutMs", opts.statementTimeoutMs ?? 30_000);
  const cfg: PoolConfig = {
    connectionString: opts.connectionString ?? loadConfig().DATABASE_URL,
    max: positiveInt("max", opts.max ?? 50),
    idleTimeoutMillis: positiveInt("idleTimeoutMillis", opts.idleTimeoutMillis ?? 30_000),
    connectionTimeoutMillis: positiveInt("connectionTimeoutMillis", opts.connectionTimeoutMillis ?? 5_000),
    statement_timeout: statementTimeout,
    application_name: "openclaude-commercial",
  };
  const p = new Pool(cfg);
  // 防止未处理的 pool 级错误静默:转换为明确日志 + process 不崩
  p.on("error", (err) => {
    // 使用 stderr 直接输出,避免在 T-01 阶段引入 logger
    // eslint-disable-next-line no-console
    console.error("[commercial/db] idle client error:", err.message);
  });
  return p;
}

/** 获取/懒初始化全局 pool。 */
export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * 测试专用:注入外部 pool(如独立测试库)。
 * 若已有单例 pool,必须先 `closePool()`,否则抛错 —— 避免静默泄漏旧 pool 连接。
 */
export function setPoolOverride(p: Pool): void {
  if (pool && pool !== p) {
    throw new Error(
      "commercial/db: pool already initialized; call closePool() before setPoolOverride()",
    );
  }
  pool = p;
}

/**
 * 丢弃并关闭当前 pool。等价于 `closePool()`,保留名字便于测试可读性。
 */
export async function resetPool(): Promise<void> {
  await closePool();
}

/** 进程退出时调用,等待所有连接关闭。 */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

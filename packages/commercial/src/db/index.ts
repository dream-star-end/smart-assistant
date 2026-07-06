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
    // BEGIN 后卡在非 DB await 的持锁事务上限:statement_timeout 只管单条语句,管不住
    // "事务开着不发语句"(如 Tx 内 await 外部 IO 挂起)——那会长期持有行锁/advisory lock。
    // v3+v5 共库(池合计可达 100 连接),必须有第二道防线。60s 远大于任何正常事务。
    idle_in_transaction_session_timeout: 60_000,
    application_name: "openclaude-commercial",
  };
  const p = new Pool(cfg);
  // 防止未处理的 pool 级错误静默:转换为明确日志 + process 不崩。
  // 注意:pg 的 `Pool#error` **只**在 pool 内 *idle* client(已归还池、尚未 checkout)
  // 出错时触发,**覆盖不到 checked-out client**(见下方 connect 监听)。
  p.on("error", (err) => {
    // 使用 stderr 直接输出,避免在 T-01 阶段引入 logger
    // eslint-disable-next-line no-console
    console.error("[commercial/db] idle client error:", err.message);
  });
  // 2026-07-06 事故根治:idle-in-transaction 断连不再崩进程。
  //
  // 根因:provision/recycle 事务在 `BEGIN` 后跨越 docker create+start(及 codex 远端
  // 绑定 HTTP)全程**持有该连接**,期间不发 SQL —— 此时该 client 是 *checked-out* 且
  // idle-in-transaction。压力下 docker 步骤一旦超过 `idle_in_transaction_session_timeout`
  // (上方 60s),PG 服务端强制终止该连接,pg 在 **CLIENT 对象**上 emit 'error'。
  // `Pool#error` 只覆盖 pool 内 *idle* client,覆盖不到 checked-out client;若该 client
  // 此刻无 'error' 监听,Node 会把 EventEmitter 'error' 冒成**进程级 uncaughtException**
  // → gateway 紧急关停(事故当天正是如此,崩溃恰发生在某次 provision 的 docker create
  // 之后、catch 块 rollback+rm 清理之前 → 留下占名僵尸容器)。
  //
  // 修复:`Pool#connect` 在每个新 client 建连时触发一次,这里给它挂一个贯穿其整个
  // 生命周期(idle 或 checked-out 都在)的 no-op 'error' 监听 —— 结构化日志 + **不退出**。
  // 该 client 若正持有事务被强断,下一条 `client.query()` 会在 provision 的 try 内 reject,
  // 走既有 catch → ROLLBACK + `docker rm createdDockerId` 清理(僵尸不再产生),再交上层
  // 短重试。进程级 uncaughtException 兜底(cli/gateway.ts emergencyExit)保留不动。
  //
  // 未加 Prometheus counter:metrics.ts → db/queries.ts → db/index.ts 形成 import 环,
  // 本文件刻意保持零内部依赖(见文件顶注)。可观测由结构化 stderr 承担;需要 counter
  // 时应在无环的更外层(如 renderPrometheus 采集器)统计,不在此处引环。
  p.on("connect", (client) => {
    client.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[commercial/db] client error (idle-in-tx / server-terminated), not exiting:", {
        message: (err as Error)?.message,
      });
    });
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

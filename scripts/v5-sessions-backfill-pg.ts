#!/usr/bin/env -S npx tsx
/**
 * v5-sessions-backfill-pg.ts — master 侧会话权威从 SQLite 割接到 PG 的割接/校验工具
 * (P2 / RFC-v5-sessions-pg.md,Codex 4 轮设计审 PASS)。
 *
 * 本脚本只做「空目标全量灌 + 全量校验 fail-closed」,**没有** --since / 没有静默幂等。
 * 首灌失败重试(retry-initial)与灾难反灌后重割接(re-cutover-from-sqlite)是两个显式
 * 子命令,不共用开关。权威状态机(sessions_store_migration_state)是唯一裁决源,状态行
 * 只单调推进 generation + authority,首次建立后永不删除。
 *
 * ── 权威状态机合法转换(RFC §D1/D4)──
 *   (无行) --initial-->            prepared(gen=1) --全量校验绿--> pg_authoritative(gen=1)
 *   prepared --retry-initial-->    prepared(gen+1) --全量校验绿--> pg_authoritative(gen+1)
 *   sqlite_disaster_recovered --re-cutover--> prepared(gen+1) --绿--> pg_authoritative(gen+1)
 *   (灾难反灌 pg_authoritative→sqlite_disaster_recovered 由 deploy-v5.sh 的 recover 流程做,
 *    本脚本只消费该状态,不生产它。)
 *
 * ── 起手事务与推进顺序(RFC §D4,R4 双写故障恢复协议)──
 *   1. 起手事务:写 prepared + 新 generation + 新 cutover_id(retry/re-cutover 同事务清六表)→ commit。
 *      此后任何 master 启动尝试都被 prepared 态拒起(= 安全态)。
 *   2. 全量灌:SQLite 源 → PG 六表(单事务)。毫秒整数原样、messages/chunk TEXT 原样。
 *   3. 全量校验:六表 count + PK 集合 + 按 PK 逐行全列确定性 digest 对比 SQLite vs PG
 *      (所有 TEXT payload 全量 hash)+ 不变量(next_seq>max(tail._seq)、归档水位)。
 *   4. 全绿才推进:同事务 prepared→pg_authoritative + source_digest + completed_at(按 generation 加栅栏)。
 *   5. **PG 事务 commit 成功后**才写本地 manifest(临时文件 + fsync + 原子 rename + 目录 fsync)。
 *      崩在中间 → manifest 与 PG 不一致 → master 拒起(安全态)→ repair-manifest 收敛。
 *   任何一步失败 = 退出非零 + 状态留在 prepared(master 拒起 = 安全态)。
 *
 * ── digest 算法(SQLite 与 PG 跨引擎一致)──
 *   逐行 rowDigest = sha256(JSON.stringify([pk..., col...] 按固定列序))。
 *     - 每个整数列(BIGINT/INTEGER/SMALLINT)归一化为十进制字符串(消 node-postgres 把
 *       BIGINT 返回 string 而 SQLite 返回 number 的差异;越界 MAX_SAFE_INTEGER 断言);
 *     - 每个 TEXT 列(messages / chunk / cost_credits / context_tokens / whitelist / token ...)
 *       原样字符串全量进 hash(非抽样);NULL 保留为 JS null(JSON.stringify 天然区分 null 与 "null")。
 *   表级 tableDigest = sha256(该表全部 rowDigest 排序后 join('\n'))(排序 → 与 DB collation/行序无关)。
 *   全库 source_digest = sha256(六表 "表名:tableDigest" 按固定表序 join('\n'))。
 *
 * ── 用法 ──
 *   DATABASE_URL=postgres://... OPENCLAUDE_HOME=/root/.openclaude-v5 \
 *     npx tsx scripts/v5-sessions-backfill-pg.ts <子命令> [flags]
 *
 *   子命令(显式分离,无默认):
 *     initial                 首次割接(前置:master 已停 + PG 状态表无行 + 六表全空)
 *     retry-initial           首灌失败重试(前置:authority='prepared' + master 已停)
 *     re-cutover-from-sqlite  灾难反灌后重割接(前置:authority='sqlite_disaster_recovered'
 *                             + master 已停 + 交互确认;--yes 跳过确认供演练自动化)
 *     repair-manifest         manifest 与 PG 状态不一致修复(--cutover-id 必填,须与 PG 行一致;
 *                             只收敛 manifest 到已验证 PG 状态行,永不改 PG、永不提升 authority)
 *     status                  只读:打印 PG 状态行 + manifest + 六表 counts
 *
 *   flags:
 *     --sqlite <path>      SQLite 源路径(默认 $OPENCLAUDE_HOME/sessions.db)
 *     --manifest <path>    本地 manifest 路径(默认 $OPENCLAUDE_HOME/sessions-store-authority.json)
 *     --cutover-id <hex>   repair-manifest 用:必须与 PG 状态行 cutover_id 完全一致
 *     --yes                re-cutover-from-sqlite 用:跳过交互确认(演练自动化)
 *     -h / --help          帮助
 *
 *   env:
 *     DATABASE_URL                        PG 连接串(必填)
 *     OPENCLAUDE_HOME                     默认 sqlite/manifest 的基目录
 *     OC_V5_UNIT                          master systemd unit(默认 openclaude-v5.service)
 *     OC_SESSIONS_ASSUME_MASTER_STOPPED=1 非 systemd 环境(演练/CI)跳过停机断言(显式逃生门)
 *
 * ── 退出码 ──
 *   0 = 成功;非零 = 任一前置/灌库/校验/推进失败(fail-closed,状态留在安全态)。usage 错误 = 2。
 */

import Database from "better-sqlite3";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";

const { Client } = pg;

// ─────────────────────────── 表规格(六张迁移表)───────────────────────────
// cols = 固定列序(与 0134_sessions_master_pg.sql / storage sessionsDb.ts 逐列对齐)。
// kind:int = 毫秒整数/计数/seq(归一化十进制字符串);text = 字符串 payload(原样 hash)。
type ColKind = "int" | "text";
interface TableSpec {
  table: string;
  cols: string[];
  pkCols: string[];
  kind: Record<string, ColKind>;
  /** messages/chunk 这类大 TEXT payload → 校验/灌库走小 batch 控内存。 */
  largePayload: boolean;
}

const CLIENT_SESSIONS: TableSpec = {
  table: "client_sessions",
  cols: [
    "id", "user_id", "agent_id", "title", "pinned", "created_at", "last_at",
    "messages", "message_count", "updated_at", "deleted_at", "next_seq",
    "origin_channel", "archived_through_seq", "archived_count",
  ],
  pkCols: ["id"],
  kind: {
    id: "text", user_id: "text", agent_id: "text", title: "text",
    pinned: "int", created_at: "int", last_at: "int", messages: "text",
    message_count: "int", updated_at: "int", deleted_at: "int", next_seq: "int",
    origin_channel: "text", archived_through_seq: "int", archived_count: "int",
  },
  largePayload: true,
};

const ARCHIVE_CHUNKS: TableSpec = {
  table: "client_session_archive_chunks",
  cols: ["session_id", "user_id", "first_seq", "last_seq", "message_count", "messages", "created_at"],
  pkCols: ["session_id", "first_seq"],
  kind: {
    session_id: "text", user_id: "text", first_seq: "int", last_seq: "int",
    message_count: "int", messages: "text", created_at: "int",
  },
  largePayload: true,
};

const ARCHIVED_IDS: TableSpec = {
  table: "client_session_archived_ids",
  cols: ["session_id", "msg_id"],
  pkCols: ["session_id", "msg_id"],
  kind: { session_id: "text", msg_id: "text" },
  largePayload: false,
};

const SARM: TableSpec = {
  table: "server_authored_request_map",
  cols: ["request_id", "user_id", "session_id", "msg_id", "written_at"],
  pkCols: ["request_id", "user_id"],
  kind: { request_id: "text", user_id: "text", session_id: "text", msg_id: "text", written_at: "int" },
  largePayload: false,
};

const PENDING: TableSpec = {
  table: "pending_usage_patches",
  cols: ["request_id", "user_id", "session_id", "parent_session_id", "delegate_agent_id", "cost_credits", "created_at"],
  pkCols: ["request_id", "user_id"],
  kind: {
    request_id: "text", user_id: "text", session_id: "text", parent_session_id: "text",
    delegate_agent_id: "text", cost_credits: "text", created_at: "int",
  },
  largePayload: false,
};

const WECHAT: TableSpec = {
  table: "wechat_bindings",
  cols: [
    "user_id", "account_id", "login_user_id", "bot_token", "get_updates_buf",
    "context_tokens", "whitelist", "status", "created_at", "updated_at", "last_event_at",
  ],
  pkCols: ["user_id"],
  kind: {
    user_id: "text", account_id: "text", login_user_id: "text", bot_token: "text",
    get_updates_buf: "text", context_tokens: "text", whitelist: "text", status: "text",
    created_at: "int", updated_at: "int", last_event_at: "int",
  },
  largePayload: false,
};

// 固定表序(load / clear / source_digest 聚合都用它)。无 FK 依赖 → 顺序仅为确定性。
const SPECS: TableSpec[] = [CLIENT_SESSIONS, ARCHIVE_CHUNKS, ARCHIVED_IDS, SARM, PENDING, WECHAT];
const STATE_TABLE = "sessions_store_migration_state";

// ─────────────────────────── 通用工具 ───────────────────────────
type Row = Record<string, unknown>;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** 跨引擎归一化:整数列→十进制字符串;文本列→原样字符串;NULL→null。 */
function normValue(kind: ColKind, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (kind === "int") {
    let b: bigint;
    if (typeof v === "bigint") b = v;
    else if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new Error(`整数列期望整数,得到非整数值 ${v}`);
      b = BigInt(v);
    } else if (typeof v === "string") {
      if (!/^-?\d+$/.test(v)) throw new Error(`整数列期望整数字符串,得到 ${JSON.stringify(v)}`);
      b = BigInt(v);
    } else {
      throw new Error(`整数列类型异常: ${typeof v}`);
    }
    if (b > MAX_SAFE || b < MIN_SAFE) throw new Error(`整数越界 MAX_SAFE_INTEGER: ${b.toString()}`);
    return b.toString();
  }
  return typeof v === "string" ? v : String(v);
}

/** rowDigest 输入 = [pk 列归一化..., 全列归一化...](按固定列序,见文件顶部 digest 算法)。 */
function rowNormArray(spec: TableSpec, row: Row): (string | null)[] {
  const pkPart = spec.pkCols.map((c) => normValue(spec.kind[c], row[c]));
  const colPart = spec.cols.map((c) => normValue(spec.kind[c], row[c]));
  return [...pkPart, ...colPart];
}
function rowDigest(spec: TableSpec, row: Row): string {
  return sha256(JSON.stringify(rowNormArray(spec, row)));
}
function pkString(spec: TableSpec, row: Row): string {
  return JSON.stringify(spec.pkCols.map((c) => normValue(spec.kind[c], row[c])));
}

// ─────────────────────────── CLI 解析 ───────────────────────────
type Sub = "initial" | "retry-initial" | "re-cutover-from-sqlite" | "repair-manifest" | "status";
const SUBS: Sub[] = ["initial", "retry-initial", "re-cutover-from-sqlite", "repair-manifest", "status"];

interface Args {
  sub: Sub;
  sqlite: string;
  manifest: string;
  cutoverId: string | null;
  yes: boolean;
}

function usage(msg?: string): never {
  if (msg) console.error(`✗ ${msg}`);
  console.error(
    [
      "usage: v5-sessions-backfill-pg.ts <子命令> [flags]",
      "  子命令: initial | retry-initial | re-cutover-from-sqlite | repair-manifest | status",
      "  flags : --sqlite <path> --manifest <path> --cutover-id <hex> --yes",
      "  env   : DATABASE_URL(必填) OPENCLAUDE_HOME OC_V5_UNIT OC_SESSIONS_ASSUME_MASTER_STOPPED",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const sub = argv[0] as Sub;
  if (argv.includes("-h") || argv.includes("--help")) usage();
  if (!sub || !SUBS.includes(sub)) usage(`未知或缺失子命令: ${sub ?? "(空)"}`);
  const home = process.env.OPENCLAUDE_HOME ?? join(homedir(), ".openclaude");
  const out: Args = {
    sub,
    sqlite: join(home, "sessions.db"),
    manifest: join(home, "sessions-store-authority.json"),
    cutoverId: null,
    yes: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`缺少 ${a} 的值`);
      return v;
    };
    if (a === "--sqlite") out.sqlite = next();
    else if (a === "--manifest") out.manifest = next();
    else if (a === "--cutover-id") out.cutoverId = next();
    else if (a === "--yes") out.yes = true;
    else usage(`未知参数: ${a}`);
  }
  return out;
}

// ─────────────────────────── 前置断言 ───────────────────────────
function assertMasterStopped(): void {
  const unit = process.env.OC_V5_UNIT ?? "openclaude-v5.service";
  if (process.env.OC_SESSIONS_ASSUME_MASTER_STOPPED === "1") {
    console.warn(`[warn] OC_SESSIONS_ASSUME_MASTER_STOPPED=1 → 跳过 ${unit} 停机断言(仅限演练/CI 非 systemd 环境)`);
    return;
  }
  let out = "";
  try {
    // is-active 对 inactive/failed 返回非零并把状态打到 stdout;execFileSync 会抛,stdout 在 err 上。
    out = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim();
  } catch (e) {
    const anyE = e as { stdout?: unknown; message?: string };
    const so = anyE.stdout ? String(anyE.stdout).trim() : "";
    if (so) out = so;
    else {
      throw new Error(
        `无法执行 systemctl is-active ${unit}(${anyE.message ?? e});非 systemd 环境请显式设 ` +
          `OC_SESSIONS_ASSUME_MASTER_STOPPED=1 演练。`,
      );
    }
  }
  if (out === "active") {
    throw new Error(`前置失败:${unit} 仍在运行(is-active=active)。割接/重灌前必须先停 master。`);
  }
  console.log(`  ✓ ${unit} 已停(is-active=${out || "unknown"})`);
}

async function assertPgTablesExist(client: pg.Client): Promise<void> {
  const need = [STATE_TABLE, ...SPECS.map((s) => s.table)];
  for (const t of need) {
    const r = await client.query("SELECT to_regclass($1) AS reg", [t]);
    if (!r.rows[0] || r.rows[0].reg === null) {
      throw new Error(`PG 缺少表 ${t}(0134_sessions_master_pg.sql 未 apply)。先在受控窗口 apply 0134 再割接。`);
    }
  }
}

// ─────────────────────────── 状态行 ───────────────────────────
interface StateRow {
  authority: "prepared" | "pg_authoritative" | "sqlite_disaster_recovered";
  generation: string; // BIGINT → string(node-postgres 默认;不改全局 parser)
  cutover_id: string;
  source_digest: string | null;
  completed_at: string | null;
}

async function readState(client: pg.Client): Promise<StateRow | null> {
  const r = await client.query(
    `SELECT authority, generation::text AS generation, cutover_id,
            source_digest, completed_at::text AS completed_at
       FROM ${STATE_TABLE} WHERE singleton = true`,
  );
  return (r.rows[0] as StateRow) ?? null;
}

async function countRows(client: pg.Client, table: string): Promise<number> {
  const r = await client.query(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0].n);
}

// ─────────────────────────── 起手事务:写 prepared ───────────────────────────
/**
 * 起手事务(RFC §D4)。initial → INSERT prepared gen=1;retry/re-cutover → UPDATE 同事务清六表,
 * 按 (expectedAuthority, expectedGeneration) 加栅栏,只从确切观测到的行推进,gen+1。
 * 推进到新一代 prepared 时**显式**把 source_digest/completed_at 置 NULL(Codex PASS 附带)。
 */
async function prepareTx(
  client: pg.Client,
  opts:
    | { kind: "insert"; cutoverId: string }
    | { kind: "update"; expectedAuthority: StateRow["authority"]; expectedGeneration: string; newGeneration: string; cutoverId: string },
): Promise<void> {
  await client.query("BEGIN");
  try {
    if (opts.kind === "insert") {
      // 六表已在事务外断言为空;此处直接 INSERT。若竞态插入了行 → PK 冲突抛错 → rollback(安全)。
      await client.query(
        `INSERT INTO ${STATE_TABLE} (singleton, authority, generation, cutover_id, source_digest, completed_at)
         VALUES (true, 'prepared', 1, $1, NULL, NULL)`,
        [opts.cutoverId],
      );
    } else {
      const upd = await client.query(
        `UPDATE ${STATE_TABLE}
            SET authority = 'prepared', generation = $1, cutover_id = $2,
                source_digest = NULL, completed_at = NULL
          WHERE singleton = true AND authority = $3 AND generation = $4`,
        [opts.newGeneration, opts.cutoverId, opts.expectedAuthority, opts.expectedGeneration],
      );
      if (upd.rowCount !== 1) {
        throw new Error(
          `起手事务栅栏失败:期望 (authority=${opts.expectedAuthority}, generation=${opts.expectedGeneration}) ` +
            `但 UPDATE 命中 ${upd.rowCount} 行(状态被并发改动?)。已 rollback。`,
        );
      }
      // 同事务清六表(清非空目标的唯一合法入口:栅栏 = master 已停 + 显式子命令 + prepared 事务内清)。
      for (const spec of SPECS) {
        await client.query(`DELETE FROM ${spec.table}`);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ─────────────────────────── 全量灌库(单事务)───────────────────────────
async function pgInsertBatch(client: pg.Client, spec: TableSpec, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const r of rows) {
    const ph: string[] = [];
    for (const c of spec.cols) {
      ph.push(`$${p++}`);
      params.push(r[c] ?? null); // 0/'' 是 nullish-safe(?? 只吞 null/undefined)
    }
    tuples.push(`(${ph.join(",")})`);
  }
  await client.query(`INSERT INTO ${spec.table} (${spec.cols.join(",")}) VALUES ${tuples.join(",")}`, params);
}

async function loadAllTables(client: pg.Client, sqliteDb: Database.Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await client.query("BEGIN");
  try {
    for (const spec of SPECS) {
      const stmt = sqliteDb.prepare(`SELECT ${spec.cols.join(",")} FROM ${spec.table}`);
      const batchRows = spec.largePayload ? 50 : 500;
      let buf: Row[] = [];
      let total = 0;
      for (const row of stmt.iterate() as IterableIterator<Row>) {
        buf.push(row);
        if (buf.length >= batchRows) {
          await pgInsertBatch(client, spec, buf);
          total += buf.length;
          buf = [];
        }
      }
      if (buf.length) {
        await pgInsertBatch(client, spec, buf);
        total += buf.length;
      }
      counts[spec.table] = total;
      console.log(`  · 灌 ${spec.table}: ${total} 行`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
  return counts;
}

// ─────────────────────────── 全量校验 ───────────────────────────
/** SQLite 侧:流式建 pk→rowDigest 映射(不驻留 messages,只留 digest)。onRow 供不变量计算。 */
function buildSqliteMap(
  sqliteDb: Database.Database,
  spec: TableSpec,
  onRow?: (row: Row) => void,
): Map<string, string> {
  const map = new Map<string, string>();
  const stmt = sqliteDb.prepare(`SELECT ${spec.cols.join(",")} FROM ${spec.table}`);
  for (const row of stmt.iterate() as IterableIterator<Row>) {
    map.set(pkString(spec, row), rowDigest(spec, row));
    if (onRow) onRow(row);
  }
  return map;
}

/** PG 侧:keyset 分页流式建 pk→rowDigest 映射(LIMIT 有界每查询 buffer,large payload 小 batch)。 */
async function buildPgMap(client: pg.Client, spec: TableSpec): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const order = spec.pkCols.join(",");
  const batchRows = spec.largePayload ? 50 : 500;
  let last: unknown[] | null = null;
  for (;;) {
    let sql: string;
    let params: unknown[];
    if (last === null) {
      sql = `SELECT ${spec.cols.join(",")} FROM ${spec.table} ORDER BY ${order} LIMIT ${batchRows}`;
      params = [];
    } else {
      const ph = spec.pkCols.map((_, i) => `$${i + 1}`).join(",");
      sql = `SELECT ${spec.cols.join(",")} FROM ${spec.table} WHERE (${spec.pkCols.join(",")}) > (${ph}) ORDER BY ${order} LIMIT ${batchRows}`;
      params = last;
    }
    const res = await client.query(sql, params);
    if (res.rows.length === 0) break;
    for (const row of res.rows as Row[]) map.set(pkString(spec, row), rowDigest(spec, row));
    const lastRow = res.rows[res.rows.length - 1] as Row;
    last = spec.pkCols.map((c) => lastRow[c]);
    if (res.rows.length < batchRows) break;
  }
  return map;
}

function tableDigestOf(map: Map<string, string>): string {
  return sha256([...map.values()].sort().join("\n"));
}

/** 对比一张表的 SQLite vs PG 映射,返回是否一致 + 诊断报告。 */
function compareTable(spec: TableSpec, sqliteMap: Map<string, string>, pgMap: Map<string, string>): {
  ok: boolean;
  report: string[];
} {
  const report: string[] = [];
  let ok = true;
  if (sqliteMap.size !== pgMap.size) {
    ok = false;
    report.push(`  ✗ ${spec.table}: count 不一致 SQLite=${sqliteMap.size} PG=${pgMap.size}`);
  }
  const missingInPg: string[] = [];
  const digestMismatch: string[] = [];
  for (const [k, d] of sqliteMap) {
    const pd = pgMap.get(k);
    if (pd === undefined) missingInPg.push(k);
    else if (pd !== d) digestMismatch.push(k);
  }
  const extraInPg: string[] = [];
  for (const k of pgMap.keys()) if (!sqliteMap.has(k)) extraInPg.push(k);
  if (missingInPg.length) {
    ok = false;
    report.push(`  ✗ ${spec.table}: PG 缺 ${missingInPg.length} 行(样本 PK: ${missingInPg.slice(0, 5).join(", ")})`);
  }
  if (extraInPg.length) {
    ok = false;
    report.push(`  ✗ ${spec.table}: PG 多 ${extraInPg.length} 行(样本 PK: ${extraInPg.slice(0, 5).join(", ")})`);
  }
  if (digestMismatch.length) {
    ok = false;
    report.push(`  ✗ ${spec.table}: ${digestMismatch.length} 行逐列 digest 不一致(样本 PK: ${digestMismatch.slice(0, 5).join(", ")})`);
  }
  const st = tableDigestOf(sqliteMap);
  const pt = tableDigestOf(pgMap);
  if (st !== pt) {
    ok = false;
    report.push(`  ✗ ${spec.table}: 表级 digest 不一致 SQLite=${st.slice(0, 12)} PG=${pt.slice(0, 12)}`);
  }
  if (ok) report.push(`  ✓ ${spec.table}: ${sqliteMap.size} 行一致(tableDigest=${st.slice(0, 12)})`);
  return { ok, report };
}

/** client_sessions 源不变量(next_seq>max(tail._seq)、归档水位)——在 SQLite 源上算,digest 相等则传递到 PG。 */
function checkClientSessionsInvariants(sqliteDb: Database.Database): { ok: boolean; report: string[] } {
  const report: string[] = [];
  const violations: string[] = [];
  // 归档 chunk 聚合:每会话 sum(message_count)/max(last_seq)/chunk 数。
  const aggMap = new Map<string, { sc: number; ml: number }>();
  for (const r of sqliteDb
    .prepare(
      `SELECT session_id, SUM(message_count) AS sc, MAX(last_seq) AS ml
         FROM ${ARCHIVE_CHUNKS.table} GROUP BY session_id`,
    )
    .all() as Array<{ session_id: string; sc: number | null; ml: number | null }>) {
    aggMap.set(r.session_id, { sc: Number(r.sc ?? 0), ml: Number(r.ml ?? 0) });
  }
  const seenSessions = new Set<string>();
  const stmt = sqliteDb.prepare(
    `SELECT id, messages, next_seq, message_count, archived_through_seq, archived_count FROM ${CLIENT_SESSIONS.table}`,
  );
  for (const row of stmt.iterate() as IterableIterator<Row>) {
    const id = String(row.id);
    seenSessions.add(id);
    const nextSeq = Number(row.next_seq);
    const archivedCount = Number(row.archived_count);
    const archivedThrough = Number(row.archived_through_seq);
    const messageCount = Number(row.message_count);
    let maxSeq = 0;
    let tailLen = 0;
    try {
      const arr = JSON.parse(String(row.messages));
      if (Array.isArray(arr)) {
        tailLen = arr.length;
        for (const m of arr) {
          const s = m && typeof (m as Row)._seq === "number" ? ((m as Row)._seq as number) : 0;
          if (s > maxSeq) maxSeq = s;
        }
      } else {
        violations.push(`${id}: messages 非数组`);
      }
    } catch {
      violations.push(`${id}: messages JSON 解析失败`);
    }
    if (!(nextSeq > maxSeq)) violations.push(`${id}: next_seq(${nextSeq}) 未 > max(tail._seq)=${maxSeq}`);
    const agg = aggMap.get(id);
    const sumChunk = agg ? agg.sc : 0;
    if (archivedCount !== sumChunk) violations.push(`${id}: archived_count(${archivedCount}) != SUM(chunk.message_count)(${sumChunk})`);
    if (agg) {
      if (!(archivedThrough >= agg.ml)) violations.push(`${id}: archived_through_seq(${archivedThrough}) < MAX(chunk.last_seq)(${agg.ml})`);
    } else if (archivedCount !== 0) {
      violations.push(`${id}: 无归档 chunk 但 archived_count=${archivedCount}`);
    }
    if (messageCount !== tailLen + archivedCount) {
      violations.push(`${id}: message_count(${messageCount}) != tailLen(${tailLen})+archived_count(${archivedCount})`);
    }
  }
  // 孤儿归档 chunk:session_id 无对应 client_sessions 行。
  for (const sid of aggMap.keys()) {
    if (!seenSessions.has(sid)) violations.push(`${sid}: 孤儿归档 chunk(无 client_sessions 行)`);
  }
  if (violations.length) {
    report.push(`  ✗ 源不变量违反 ${violations.length} 处(样本):`);
    for (const v of violations.slice(0, 10)) report.push(`      - ${v}`);
    return { ok: false, report };
  }
  report.push(`  ✓ 源不变量通过(next_seq>max(tail._seq)、归档水位、message_count 一致)`);
  return { ok: true, report };
}

/** 全量校验:六表 digest 对比 + 不变量。返回 ok + 每表 tableDigest(用于 source_digest)。 */
async function verifyAll(
  sqliteDb: Database.Database,
  client: pg.Client,
): Promise<{ ok: boolean; tableDigests: Record<string, string>; sourceDigest: string }> {
  console.log("── 全量校验(六表 count + PK 集合 + 逐行全列 digest + 不变量)──");
  let ok = true;
  const tableDigests: Record<string, string> = {};
  for (const spec of SPECS) {
    const sqliteMap = buildSqliteMap(sqliteDb, spec);
    const pgMap = await buildPgMap(client, spec);
    const cmp = compareTable(spec, sqliteMap, pgMap);
    for (const line of cmp.report) console.log(line);
    if (!cmp.ok) ok = false;
    // digest 相等时两侧一致,取 SQLite 侧作为权威(校验通过前提下等于 PG)。
    tableDigests[spec.table] = tableDigestOf(sqliteMap);
  }
  const inv = checkClientSessionsInvariants(sqliteDb);
  for (const line of inv.report) console.log(line);
  if (!inv.ok) ok = false;
  const sourceDigest = sha256(SPECS.map((s) => `${s.table}:${tableDigests[s.table]}`).join("\n"));
  return { ok, tableDigests, sourceDigest };
}

// ─────────────────────────── 推进到 pg_authoritative ───────────────────────────
async function advanceToAuthoritative(client: pg.Client, generation: string, sourceDigest: string): Promise<void> {
  await client.query("BEGIN");
  try {
    const now = Date.now();
    const upd = await client.query(
      `UPDATE ${STATE_TABLE}
          SET authority = 'pg_authoritative', source_digest = $1, completed_at = $2
        WHERE singleton = true AND generation = $3 AND authority = 'prepared'`,
      [sourceDigest, String(now), generation],
    );
    if (upd.rowCount !== 1) {
      throw new Error(`推进栅栏失败:期望 (generation=${generation}, authority=prepared) 但命中 ${upd.rowCount} 行。已 rollback。`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ─────────────────────────── manifest 双写(原子)───────────────────────────
interface Manifest {
  authority: string;
  generation: number;
  cutoverId: string;
}

/** 临时文件 + fsync + 原子 rename + 目录 fsync(RFC R4)。PG commit 成功后才调用。 */
function writeManifestAtomic(path: string, obj: Manifest): void {
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(obj, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // rename 落盘需 fsync 目录项。
  const dfd = openSync(dirname(path), "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (e) {
    throw new Error(`manifest 解析失败 ${path}: ${(e as Error).message}`);
  }
}

// ─────────────────────────── 交互确认 ───────────────────────────
async function confirmYes(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans: string = await new Promise((res) => rl.question(promptText, res));
    return ans.trim() === "yes";
  } finally {
    rl.close();
  }
}

// ─────────────────────────── 公共:一次割接(灌+校验+推进+manifest)───────────────────────────
async function runCutover(client: pg.Client, sqliteDb: Database.Database, generation: string, cutoverId: string, manifestPath: string): Promise<void> {
  console.log("── 全量灌库(SQLite → PG,单事务)──");
  await loadAllTables(client, sqliteDb);
  const v = await verifyAll(sqliteDb, client);
  if (!v.ok) {
    throw new Error("全量校验未通过 —— 状态留在 prepared(master 拒起 = 安全态)。修正数据后走 retry-initial 重灌。");
  }
  console.log(`  ✓ 全量校验全绿。source_digest=${v.sourceDigest}`);
  await advanceToAuthoritative(client, generation, v.sourceDigest);
  console.log(`  ✓ PG 状态推进 prepared → pg_authoritative(generation=${generation})`);
  // 铁律(R4):PG 事务 commit 成功后才写 manifest。
  writeManifestAtomic(manifestPath, { authority: "pg_authoritative", generation: Number(generation), cutoverId });
  console.log(`  ✓ manifest 已原子写入 ${manifestPath}`);
}

// ─────────────────────────── 子命令 ───────────────────────────
async function cmdInitial(args: Args, client: pg.Client, sqliteDb: Database.Database): Promise<void> {
  console.log("══ initial:首次割接 ══");
  assertMasterStopped();
  await assertPgTablesExist(client);
  const st = await readState(client);
  if (st !== null) {
    throw new Error(`前置失败:PG 状态表已有行(authority=${st.authority}, generation=${st.generation})。initial 只允许无行首建;` +
      `首灌失败重试用 retry-initial,灾难反灌后用 re-cutover-from-sqlite。`);
  }
  for (const spec of SPECS) {
    const n = await countRows(client, spec.table);
    if (n !== 0) throw new Error(`前置失败:目标表 ${spec.table} 非空(${n} 行)。initial 要求六表全空。`);
  }
  const cutoverId = randomBytes(16).toString("hex");
  console.log(`  · 分配 generation=1 cutover_id=${cutoverId}`);
  await prepareTx(client, { kind: "insert", cutoverId });
  console.log("  ✓ 起手事务:写 prepared(gen=1)commit");
  await runCutover(client, sqliteDb, "1", cutoverId, args.manifest);
  console.log("✓ initial 割接完成。");
}

async function cmdRetryInitial(args: Args, client: pg.Client, sqliteDb: Database.Database): Promise<void> {
  console.log("══ retry-initial:首灌失败重试 ══");
  assertMasterStopped();
  await assertPgTablesExist(client);
  const st = await readState(client);
  if (!st) throw new Error("前置失败:PG 状态表无行。首次割接请用 initial。");
  if (st.authority !== "prepared") {
    throw new Error(`前置失败:authority=${st.authority}(retry-initial 仅允许 prepared)。` +
      (st.authority === "pg_authoritative" ? "已割接完成,无需重试。" : "灾难反灌后请用 re-cutover-from-sqlite。"));
  }
  const newGen = (BigInt(st.generation) + 1n).toString();
  const cutoverId = randomBytes(16).toString("hex");
  console.log(`  · 推进 generation ${st.generation} → ${newGen} cutover_id=${cutoverId}(同事务清六表)`);
  await prepareTx(client, {
    kind: "update",
    expectedAuthority: "prepared",
    expectedGeneration: st.generation,
    newGeneration: newGen,
    cutoverId,
  });
  console.log("  ✓ 起手事务:prepared(gen+1)+ 清六表 commit");
  await runCutover(client, sqliteDb, newGen, cutoverId, args.manifest);
  console.log("✓ retry-initial 重灌完成。");
}

async function cmdReCutover(args: Args, client: pg.Client, sqliteDb: Database.Database): Promise<void> {
  console.log("══ re-cutover-from-sqlite:灾难反灌后重割接 ══");
  assertMasterStopped();
  await assertPgTablesExist(client);
  const st = await readState(client);
  if (!st) throw new Error("前置失败:PG 状态表无行。");
  if (st.authority !== "sqlite_disaster_recovered") {
    throw new Error(`前置失败:authority=${st.authority}(re-cutover 仅允许 sqlite_disaster_recovered)。` +
      "该状态由 deploy-v5.sh 的灾难反灌流程产生;正常割接用 initial/retry-initial。");
  }
  // 清理前打印六表 count + digest,要求交互确认。
  console.log("── 清理前 PG 六表现状(re-cutover 将清空后用 SQLite 全量覆盖)──");
  for (const spec of SPECS) {
    const pgMap = await buildPgMap(client, spec);
    console.log(`  · ${spec.table}: ${pgMap.size} 行 tableDigest=${tableDigestOf(pgMap).slice(0, 16)}`);
  }
  if (!args.yes) {
    const ok = await confirmYes(`\n确认清空以上 PG 六表并用 SQLite(${args.sqlite})全量覆盖?输入 yes 继续: `);
    if (!ok) {
      console.error("✗ 用户未确认(未输入 yes),已取消。PG 未改动。");
      process.exit(1);
    }
  } else {
    console.log("  [--yes] 跳过交互确认(演练自动化)");
  }
  const newGen = (BigInt(st.generation) + 1n).toString();
  const cutoverId = randomBytes(16).toString("hex");
  console.log(`  · 推进 generation ${st.generation} → ${newGen} cutover_id=${cutoverId}(同事务清六表)`);
  await prepareTx(client, {
    kind: "update",
    expectedAuthority: "sqlite_disaster_recovered",
    expectedGeneration: st.generation,
    newGeneration: newGen,
    cutoverId,
  });
  console.log("  ✓ 起手事务:sqlite_disaster_recovered → prepared(gen+1)+ 清六表 commit");
  await runCutover(client, sqliteDb, newGen, cutoverId, args.manifest);
  console.log("✓ re-cutover-from-sqlite 重割接完成。");
}

async function cmdRepairManifest(args: Args, client: pg.Client): Promise<void> {
  console.log("══ repair-manifest:收敛 manifest 到已验证 PG 状态行(永不改 PG、永不提升 authority)══");
  assertMasterStopped();
  await assertPgTablesExist(client);
  if (!args.cutoverId) throw new Error("repair-manifest 必须带 --cutover-id <hex>(须与 PG 状态行 cutover_id 一致,防误修)。");
  const st = await readState(client);
  if (!st) throw new Error("前置失败:PG 状态表无行,无可收敛的目标。");
  if (st.cutover_id !== args.cutoverId) {
    throw new Error(`--cutover-id 与 PG 状态行不一致:传入=${args.cutoverId} PG=${st.cutover_id}。拒绝修复(永不猜测)。`);
  }
  const manifest: Manifest = { authority: st.authority, generation: Number(st.generation), cutoverId: st.cutover_id };
  const before = readManifest(args.manifest);
  console.log(`  · PG 状态行: authority=${st.authority} generation=${st.generation} cutover_id=${st.cutover_id}`);
  console.log(`  · 现 manifest: ${before ? JSON.stringify(before) : "(不存在)"}`);
  writeManifestAtomic(args.manifest, manifest);
  console.log(`  ✓ manifest 已收敛到 PG 状态行 → ${args.manifest}: ${JSON.stringify(manifest)}`);
  console.log("✓ repair-manifest 完成(PG 未改动,authority 未提升)。");
}

async function cmdStatus(args: Args, client: pg.Client): Promise<void> {
  console.log("══ status:只读核查 ══");
  await assertPgTablesExist(client);
  const st = await readState(client);
  console.log("── PG 状态行 ──");
  console.log(st ? JSON.stringify(st, null, 2) : "  (无行 → 尚未割接,基建先行期)");
  console.log("── 本地 manifest ──");
  const mf = readManifest(args.manifest);
  console.log(`  路径: ${args.manifest}`);
  console.log(mf ? JSON.stringify(mf, null, 2) : "  (不存在)");
  if (st && mf) {
    const agree = mf.authority === st.authority && String(mf.generation) === st.generation && mf.cutoverId === st.cutover_id;
    console.log(agree ? "  ✓ manifest 与 PG 状态行一致" : "  ✗ manifest 与 PG 状态行不一致(用 repair-manifest 收敛)");
  }
  console.log("── 六表 counts(PG)──");
  for (const spec of SPECS) {
    console.log(`  · ${spec.table}: ${await countRows(client, spec.table)} 行`);
  }
}

// ─────────────────────────── main ───────────────────────────
function openSqliteReadonly(path: string): Database.Database {
  if (!existsSync(path)) throw new Error(`SQLite 源不存在: ${path}(--sqlite 覆盖或设 OPENCLAUDE_HOME)`);
  // 只读打开:这六张表在 master 割接后逻辑冻结,读取绝不改源。
  return new Database(path, { readonly: true, fileMustExist: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("缺少 env DATABASE_URL(PG 连接串)。");

  const client = new Client({ connectionString: dbUrl });
  // checked-out client 级 error 监听:idle-in-tx 被服务端强断时不冒成进程级 uncaughtException。
  client.on("error", (err: Error) => {
    console.error("[pg] client error:", err.message);
  });
  await client.connect();

  let sqliteDb: Database.Database | null = null;
  try {
    if (args.sub !== "repair-manifest" && args.sub !== "status") {
      sqliteDb = openSqliteReadonly(args.sqlite);
    }
    switch (args.sub) {
      case "initial":
        await cmdInitial(args, client, sqliteDb!);
        break;
      case "retry-initial":
        await cmdRetryInitial(args, client, sqliteDb!);
        break;
      case "re-cutover-from-sqlite":
        await cmdReCutover(args, client, sqliteDb!);
        break;
      case "repair-manifest":
        await cmdRepairManifest(args, client);
        break;
      case "status":
        await cmdStatus(args, client);
        break;
    }
  } finally {
    if (sqliteDb) sqliteDb.close();
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

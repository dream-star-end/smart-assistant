/**
 * v3 反关联根治 0072 — One-shot backfill: chat_session_account_pin
 *
 * **目的**:扫 usage_records 历史,为每个 (user_id, session_id) 写入持久化 pin。
 *   - 历史上只接触过一个账号(distinct_n=1)→ status='active',account_id=那个账号
 *   - 接触过多个账号(distinct_n>1)→ status='unbound',account_id=最近一个
 *     (account_id NOT NULL FK 必须填值;status=unbound 时 scheduler 直接拒绝,
 *      具体填哪个不影响行为,选最近一个便于审计)
 *
 * 必须在 scheduler 切到 enforce 之前跑完,否则第一天所有活跃 session 都会触发
 * `pin miss → INSERT new pin` 路径,把"既往足迹优先"的反扩散策略架空。
 *
 * **运行**:
 *   set -a; . /etc/openclaude/commercial.env; set +a
 *   cd /opt/openclaude/openclaude
 *   # 1) 总是先 dry-run 看报告
 *   npx tsx packages/commercial/scripts/backfill-session-pins.ts
 *   # 2) 据报告做决策,然后 apply。--acknowledge-reset 必须等于 dry-run 报告的
 *   #    unbound_active_last_24h 数字(漂移即 abort,保证 boss 看的报告就是
 *   #    实际应用的报告)。
 *   #
 *   #    **闸门精度语义(Codex 终审 WARN 4)**: 报告的 unbound_active_last_24h
 *   #    是从 usage_records 聚合算的、与 csap 现状无关的"理论应被 unbound 的
 *   #    活跃 session 数"。apply 用 `ON CONFLICT (user_id, session_id) DO NOTHING`,
 *   #    若 csap 已有该 (user, session) 行(运行时已写 / 前次部分 apply),实际
 *   #    `unbound` 写入数会 ≤ 报告数。即 ack-gate 给出的是**上限保证**(实际 unbound
 *   #    数不会超过 boss 确认的数字)而非精确等于。这对"保护用户不被 surprise
 *   #    reset"的语义足够 —— 用户被告知最坏情况,实际更少。
 *   #
 *   #    首次空表 backfill(预期主要 use case)时报告精确等于实际写入,无偏差。
 *   npx tsx packages/commercial/scripts/backfill-session-pins.ts \
 *     --apply --acknowledge-reset <unbound_active_last_24h>
 *
 *   --limit N    候选 cap(canary 用),strict decimal,1..1_000_000
 *
 * **设计要点**:
 *   - usage_records 是 append-only 计费表(0002),所有 chat 成功 turn 一行,
 *     权威 (user, session, account) 历史源。codex chat / agent_chat 也在此表
 *     (mode 列),但 v3 反关联只对 mode='chat' 生效(claude OAuth 路径);
 *     mode='agent_chat' 走不同的账号绑定语义。
 *   - account_id NULL 的行(0044 SET NULL on delete,或 DeepSeek 路径)直接跳过。
 *   - session_id 长度 1..256 配 0072 CHECK;空串/超长当损坏跳过。
 *   - 候选账号必须存在于 claude_accounts(JOIN 校验)且 provider='claude'。
 *     - usage_records.account_id 是 SET NULL on delete,但极端 race / 老数据残留
 *       可能有指向不存在 id 的行,直接 INSERT 会触发 FK violation 把整批 backfill 炸掉。
 *     - v3 反关联 root cure 只覆盖 claude OAuth 池的指纹关联;codex provider 的
 *       账号绑定语义不同(走 CC external endpoint / 不同 SDK 指纹路径),不应被
 *       pin 表治理。即使 mode='chat' + codex 账号的历史行存在(老路径或误标),
 *       backfill 也跳过 — 避免给 codex session 写无意义 pin 阻碍未来其独立演进。
 *   - latest_account 选最新接触的账号(`ORDER BY created_at DESC, id DESC`,Codex
 *     Round 5 feedback:加 id DESC tiebreaker 保证同毫秒 created_at 时确定性)。
 *   - apply 走 batched INSERT (10 行/批,VALUES expansion);ON CONFLICT
 *     (user_id, session_id) DO NOTHING 让运行时已写的 pin 行胜出。
 *
 * **退出码**:
 *   - 0 dry-run 结束 / apply 成功
 *   - 1 apply 时 --acknowledge-reset 与实际报告 unbound_active_last_24h 不一致
 *   - 2 fatal(参数错 / DB 不可达 / FK 校验失败 / 未捕获异常)
 */

import { createHash } from "node:crypto";

import { closePool } from "../src/db/index.js";
import { query } from "../src/db/queries.js";

// 24h 报告窗口
const REPORT_WINDOW = "24 hours";

// 批 INSERT 大小。usage_records 几千行级别,批不需要太大;
// 中等批让 ON CONFLICT 冲突局部化 + 错误定位准 + 单批 prepared statement 数量合理。
const INSERT_BATCH_SIZE = 50;

interface Args {
  apply: boolean;
  limit: number | null;
  acknowledgeReset: number | null;
}

function safeErrMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>")
    .slice(0, 200);
}

/**
 * Codex Round 5 feedback — top-N report 必须脱敏 user_id。
 * 哈希 user_id::text,取 8 hex,足够在 ops 沟通中说"这个用户最多"而不
 * 暴露真实 uid → 跨日志关联用户行为的能力。
 */
function hashUid(uid: string): string {
  return createHash("sha1").update(uid).digest("hex").slice(0, 8);
}

function parseDecimal(value: string, ctx: string, min: number, max: number): number {
  // 严格十进制:不允许前导 0(except "0"),不允许负号,不允许小数,不允许 e-notation。
  // 拒绝任何能 sneak 进 SQL 的字符。
  if (!/^[1-9][0-9]*$|^0$/.test(value)) {
    throw new Error(`${ctx} must be a non-negative decimal integer, got: ${value}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${ctx} out of range [${min}, ${max}], got: ${value}`);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let limit: number | null = null;
  let acknowledgeReset: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
    } else if (a === "--limit") {
      const next = argv[i + 1];
      if (!next) throw new Error("--limit requires <N>");
      limit = parseDecimal(next, "--limit", 1, 1_000_000);
      i += 1;
    } else if (a.startsWith("--limit=")) {
      limit = parseDecimal(a.slice("--limit=".length), "--limit", 1, 1_000_000);
    } else if (a === "--acknowledge-reset") {
      const next = argv[i + 1];
      if (!next) throw new Error("--acknowledge-reset requires <N>");
      acknowledgeReset = parseDecimal(next, "--acknowledge-reset", 0, 10_000_000);
      i += 1;
    } else if (a.startsWith("--acknowledge-reset=")) {
      acknowledgeReset = parseDecimal(
        a.slice("--acknowledge-reset=".length),
        "--acknowledge-reset",
        0,
        10_000_000,
      );
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx packages/commercial/scripts/backfill-session-pins.ts " +
          "[--apply --acknowledge-reset <N>] [--limit <N>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { apply, limit, acknowledgeReset };
}

interface SessionAggRow {
  user_id: string;
  session_id: string;
  distinct_n: number;
  latest_account: string;
  last_seen: string; // ISO
}

interface Report {
  total_sessions: number;
  active_pins: number;
  unbound_pins: number;
  affected_users: number;
  unbound_active_last_24h: number;
  top_users_by_session_count: ReadonlyArray<{ uid_hash: string; session_count: number }>;
}

/**
 * 一次性扫 usage_records,把每个 (user_id, session_id) 折叠成 SessionAggRow。
 *
 * Codex Round 5 feedback:
 *   - 加 `id DESC` tiebreaker 让 latest_account 同毫秒 created_at 时确定。
 *   - JOIN claude_accounts ca 确保 account_id 仍存在(0044 SET NULL on delete 之后
 *     usage_records 不会有 dangling id,但保险起见 LEFT JOIN 过滤)。
 */
async function collectAgg(limit: number | null): Promise<SessionAggRow[]> {
  const sql = `
    WITH valid AS (
      SELECT ur.user_id, ur.session_id, ur.account_id, ur.created_at, ur.id
        FROM usage_records ur
        JOIN claude_accounts ca ON ca.id = ur.account_id
       WHERE ur.session_id IS NOT NULL
         AND length(ur.session_id) BETWEEN 1 AND 256
         AND ur.account_id IS NOT NULL
         AND ur.mode = 'chat'
         AND ca.provider = 'claude'
    ),
    agg AS (
      SELECT user_id, session_id,
             count(DISTINCT account_id) AS distinct_n,
             max(created_at) AS last_seen,
             (array_agg(account_id ORDER BY created_at DESC, id DESC))[1] AS latest_account
        FROM valid
       GROUP BY user_id, session_id
    )
    SELECT user_id::text AS user_id,
           session_id,
           distinct_n::int AS distinct_n,
           latest_account::text AS latest_account,
           last_seen
      FROM agg
     ORDER BY user_id, session_id
     ${limit !== null ? `LIMIT ${limit}` : ""}
  `;
  // limit 已严格校验为整数,字面量拼接安全(parseDecimal 拒绝任何非纯数字)。
  const r = await query<SessionAggRow>(sql);
  return r.rows;
}

function buildReport(rows: ReadonlyArray<SessionAggRow>): Report {
  const total = rows.length;
  let active = 0;
  let unbound = 0;
  let unboundLast24h = 0;
  const userSet = new Set<string>();
  const userSessionCount = new Map<string, number>();
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;

  for (const r of rows) {
    userSet.add(r.user_id);
    userSessionCount.set(r.user_id, (userSessionCount.get(r.user_id) ?? 0) + 1);
    if (r.distinct_n === 1) {
      active += 1;
    } else {
      unbound += 1;
      const ts = Date.parse(r.last_seen);
      if (!Number.isNaN(ts) && now - ts <= windowMs) {
        unboundLast24h += 1;
      }
    }
  }

  const topUsers = [...userSessionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uid, n]) => ({ uid_hash: hashUid(uid), session_count: n }));

  return {
    total_sessions: total,
    active_pins: active,
    unbound_pins: unbound,
    affected_users: userSet.size,
    unbound_active_last_24h: unboundLast24h,
    top_users_by_session_count: topUsers,
  };
}

function printReport(r: Report): void {
  console.log("");
  console.log("[backfill-session-pins] REPORT");
  console.log(`  total_sessions          : ${r.total_sessions}`);
  console.log(`  active_pins             : ${r.active_pins}`);
  console.log(`  unbound_pins            : ${r.unbound_pins}`);
  console.log(`  affected_users          : ${r.affected_users}`);
  console.log(
    `  unbound_active_last_${REPORT_WINDOW.replace(/\s+/g, "_")}: ${r.unbound_active_last_24h}`,
  );
  console.log(`  top_users_by_session_count (hashed uid):`);
  for (const t of r.top_users_by_session_count) {
    console.log(`    - uid=${t.uid_hash} sessions=${t.session_count}`);
  }
  console.log("");
}

interface InsertResult {
  attempted: number;
  inserted: number;
  conflicted: number; // ON CONFLICT DO NOTHING 命中,即运行时已写
}

/**
 * 批 INSERT。VALUES expansion ($1,$2,$3,$4),($5,$6,$7,$8),...
 * status='active' / 'unbound' 由 distinct_n 决定。
 */
async function applyBatch(rows: ReadonlyArray<SessionAggRow>): Promise<InsertResult> {
  const parts: string[] = [];
  const vals: unknown[] = [];
  let p = 1;
  for (const r of rows) {
    const status = r.distinct_n === 1 ? "active" : "unbound";
    parts.push(`($${p}::bigint, $${p + 1}::text, $${p + 2}::bigint, $${p + 3}::text)`);
    vals.push(r.user_id, r.session_id, r.latest_account, status);
    p += 4;
  }
  const sql = `
    INSERT INTO chat_session_account_pin (user_id, session_id, account_id, status)
    VALUES ${parts.join(", ")}
    ON CONFLICT (user_id, session_id) DO NOTHING
    RETURNING user_id
  `;
  const res = await query<{ user_id: string }>(sql, vals);
  const inserted = res.rowCount ?? 0;
  return {
    attempted: rows.length,
    inserted,
    conflicted: rows.length - inserted,
  };
}

async function applyAll(rows: ReadonlyArray<SessionAggRow>): Promise<InsertResult> {
  const total: InsertResult = { attempted: 0, inserted: 0, conflicted: 0 };
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const r = await applyBatch(batch);
    total.attempted += r.attempted;
    total.inserted += r.inserted;
    total.conflicted += r.conflicted;
    console.log(
      `  - batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}: ` +
        `attempted=${r.attempted} inserted=${r.inserted} conflicted=${r.conflicted}`,
    );
  }
  return total;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set (source /etc/openclaude/commercial.env first)");
  }
  if (args.apply && args.acknowledgeReset === null) {
    throw new Error(
      "--apply requires --acknowledge-reset <N>; run without --apply first to see N",
    );
  }

  console.log(
    `[backfill-session-pins] scanning usage_records${
      args.limit !== null ? ` (limit ${args.limit})` : ""
    }${args.apply ? " [APPLY]" : " [DRY-RUN]"}`,
  );
  const rows = await collectAgg(args.limit);

  const report = buildReport(rows);
  printReport(report);

  if (!args.apply) {
    console.log(
      `[backfill-session-pins] DRY-RUN complete. To apply:\n` +
        `  --apply --acknowledge-reset ${report.unbound_active_last_24h}`,
    );
    await closePool();
    return;
  }

  // Apply 路径:严格 ack 校验
  if (args.acknowledgeReset !== report.unbound_active_last_24h) {
    console.error(
      `[backfill-session-pins] ACK MISMATCH: --acknowledge-reset=${args.acknowledgeReset} ` +
        `but report unbound_active_last_24h=${report.unbound_active_last_24h}. ` +
        `Re-run dry-run, update ack to the new value, then retry.`,
    );
    await closePool();
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("[backfill-session-pins] no candidate rows; nothing to apply.");
    await closePool();
    return;
  }

  console.log(`[backfill-session-pins] applying ${rows.length} row(s) in batches...`);
  const t = await applyAll(rows);
  console.log("");
  console.log(`[backfill-session-pins] APPLY done. ${t.attempted} attempted`);
  console.log(`  inserted   : ${t.inserted}`);
  console.log(`  conflicted : ${t.conflicted} (runtime pin row preserved)`);

  await closePool();
}

main().catch((err) => {
  console.error(`[backfill-session-pins] FATAL ${safeErrMsg(err)}`);
  process.exit(2);
});

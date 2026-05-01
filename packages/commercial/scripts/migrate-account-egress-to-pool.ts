/**
 * One-shot data migration — claude_accounts.egress_proxy (raw text, 0010)
 * → claude_accounts.egress_proxy_id (FK to egress_proxies, 0053).
 *
 * 决策(boss 拍板,阶段 2):
 *   - 所有 row 必须满足 (egress_proxy IS NULL AND egress_proxy_id IS NOT NULL)
 *   - migration 0055 用 CHECK CONSTRAINT 锁死该状态,前置 RAISE EXCEPTION 兜底
 *   - 本脚本必须在 0055 apply 前跑完,否则 service 启动 → auto-migrate → 0055 抛错
 *
 * 处理逻辑(对齐 0055 RAISE EXCEPTION 的 WHERE 条件):
 *   SELECT id, label, egress_proxy, egress_proxy_id
 *     FROM claude_accounts
 *    WHERE egress_proxy IS NOT NULL OR egress_proxy_id IS NULL;
 *   for each:
 *     - 如果 egress_proxy_id IS NULL → 补 pool_id 并清 raw
 *     - 如果 egress_proxy_id IS NOT NULL(且 raw 非空)→ 只清 raw
 *   写 admin_audit(action='account.migrate_to_pool')
 *
 * 走 raw SQL 不调 admin/store layer:本 PR 同步把 egress_proxy 入参从 store/admin
 * 删了,无法用业务 API 既写 NULL raw 又保持 id NOT NULL。这是状态边界一次性 tool。
 *
 * Usage(在 commercial-v3 直接 ssh 跑,DATABASE_URL 由 /etc/openclaude/commercial.env 提供):
 *   set -a; source /etc/openclaude/commercial.env; set +a
 *   tsx packages/commercial/scripts/migrate-account-egress-to-pool.ts \
 *        --pool-id=1 [--admin-id=1] [--dry-run]
 *
 * pool-id 必填:把 raw 没 id 的 row 都绑到这个池条目上(本次 d1 = 1 = iproyal-multi-202)。
 * admin-id 默认 1(boss);仅写 admin_audit 用,不影响数据正确性。
 */

import { Pool } from "pg";

interface Args {
  poolId: string;
  adminId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let poolId: string | null = null;
  let adminId = "1";
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--pool-id=")) poolId = a.slice("--pool-id=".length);
    else if (a.startsWith("--admin-id=")) adminId = a.slice("--admin-id=".length);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx packages/commercial/scripts/migrate-account-egress-to-pool.ts " +
          "--pool-id=<id> [--admin-id=<id>] [--dry-run]",
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (poolId === null) throw new Error("--pool-id=<id> is required");
  if (!/^[1-9][0-9]{0,19}$/.test(poolId)) throw new Error(`invalid pool-id: ${poolId}`);
  if (!/^[1-9][0-9]{0,19}$/.test(adminId)) throw new Error(`invalid admin-id: ${adminId}`);
  return { poolId, adminId, dryRun };
}

interface Row {
  id: string;
  label: string;
  egress_proxy: string | null;
  egress_proxy_id: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set (source /etc/openclaude/commercial.env first)");

  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  try {
    // 校验 pool entry 存在(不校验 active:被绑后 disabled 不影响 chk constraint,
    // 仅运行时 fallback 到 master 出口,与 0053 决策一致)
    const ep = await pool.query<{ id: string; label: string; status: string }>(
      `SELECT id::text AS id, label, status FROM egress_proxies WHERE id = $1::bigint`,
      [args.poolId],
    );
    if (ep.rowCount === 0) {
      throw new Error(`egress_proxies entry id=${args.poolId} not found`);
    }
    console.log(
      `[migrate] target pool: id=${ep.rows[0].id} label=${ep.rows[0].label} status=${ep.rows[0].status}`,
    );

    const rows = await pool.query<Row>(
      `SELECT id::text AS id, label, egress_proxy,
              egress_proxy_id::text AS egress_proxy_id
         FROM claude_accounts
        WHERE egress_proxy IS NOT NULL OR egress_proxy_id IS NULL
        ORDER BY id`,
    );
    console.log(`[migrate] found ${rows.rowCount} row(s) violating 0055 invariant`);
    if (rows.rowCount === 0) {
      console.log("[migrate] no rows to migrate. you can apply migration 0055 now.");
      return;
    }
    for (const r of rows.rows) {
      const action =
        r.egress_proxy_id === null
          ? `bind pool=${args.poolId} + clear raw`
          : `clear raw (id already=${r.egress_proxy_id})`;
      const rawMask = r.egress_proxy
        ? r.egress_proxy.replace(/:\/\/[^@]+@/, "://***@")
        : "(null)";
      console.log(`  - id=${r.id} label=${r.label} raw=${rawMask} → ${action}`);
    }

    if (args.dryRun) {
      console.log("[migrate] --dry-run, no writes.");
      return;
    }

    // 单事务:UPDATE + admin_audit 同 tx,失败一起回滚。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows.rows) {
        const before = {
          egress_proxy_masked: r.egress_proxy
            ? r.egress_proxy.replace(/:\/\/[^@]+@/, "://***@")
            : null,
          egress_proxy_id: r.egress_proxy_id,
        };
        let after: Record<string, unknown>;
        // WHERE 加 invariant guard(egress_proxy IS NOT NULL OR egress_proxy_id IS NULL):
        // 防 admin 在另一窗 patch 同行后被本脚本静默覆盖。rowCount === 0 → 中止整个 tx。
        if (r.egress_proxy_id === null) {
          const u = await client.query(
            `UPDATE claude_accounts
                SET egress_proxy = NULL,
                    egress_proxy_id = $1::bigint,
                    updated_at = NOW()
              WHERE id = $2::bigint
                AND (egress_proxy IS NOT NULL OR egress_proxy_id IS NULL)`,
            [args.poolId, r.id],
          );
          if (u.rowCount !== 1) {
            throw new Error(
              `[migrate] concurrent modification on id=${r.id}: rowCount=${u.rowCount}, ` +
                `expected 1. Re-run after pausing admin writes.`,
            );
          }
          after = { egress_proxy_masked: null, egress_proxy_id: args.poolId };
        } else {
          const u = await client.query(
            `UPDATE claude_accounts
                SET egress_proxy = NULL,
                    updated_at = NOW()
              WHERE id = $1::bigint
                AND (egress_proxy IS NOT NULL OR egress_proxy_id IS NULL)`,
            [r.id],
          );
          if (u.rowCount !== 1) {
            throw new Error(
              `[migrate] concurrent modification on id=${r.id}: rowCount=${u.rowCount}, ` +
                `expected 1. Re-run after pausing admin writes.`,
            );
          }
          after = { egress_proxy_masked: null, egress_proxy_id: r.egress_proxy_id };
        }
        // admin_audit:ip=NULL(脚本上下文,无 HTTP 请求 IP),user_agent='migrate-script/0055'
        await client.query(
          `INSERT INTO admin_audit(admin_id, action, target, before, after, ip, user_agent)
           VALUES ($1::bigint, 'account.migrate_to_pool', $2, $3::jsonb, $4::jsonb, NULL, $5)`,
          [
            args.adminId,
            `account:${r.id}`,
            JSON.stringify(before),
            JSON.stringify(after),
            "migrate-script/0055",
          ],
        );
        console.log(`  ✓ id=${r.id} migrated`);
      }
      await client.query("COMMIT");
      console.log(`[migrate] committed ${rows.rowCount} row(s).`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // verify
    const v = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
         FROM claude_accounts
        WHERE egress_proxy IS NOT NULL OR egress_proxy_id IS NULL`,
    );
    const remaining = Number(v.rows[0].c);
    if (remaining !== 0) {
      throw new Error(
        `[migrate] post-verify FAILED: ${remaining} row(s) still violate. abort before deploy.`,
      );
    }
    console.log("[migrate] post-verify OK. you can apply migration 0055 now.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`[migrate] FATAL:`, e instanceof Error ? e.message : e);
  process.exit(1);
});

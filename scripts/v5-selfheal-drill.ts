#!/usr/bin/env -S npx tsx
/**
 * v5-selfheal-drill — 自愈闭环合成 transport 演练(operator CLI,root 在
 * kl-mirror 生产库上运行)。
 *
 * 演练什么:condition(write_alert_condition)→ reconciler 开 incident →
 * sweeper 派单(drill policy 临时 auto_repair=TRUE)→ 隧道 → 个人版执行侧
 * context/report → done → verifying → 探测翻 false → sweeper 以
 * resolve_source='codex' 收口。九个检查点全绿 = 自愈闭环 transport 面健康。
 *
 * 不演练什么:verify/cutover/deploy(个人版 broker 对 drill repair 服务端
 * 拒绝这三类——drill 无部署面;Tier2 release 演练是单独的低峰专项)。
 *
 * 用法(kl-mirror,release 树内):
 *   set -a && . /etc/openclaude/commercial-v5.env && set +a
 *   npx tsx scripts/v5-selfheal-drill.ts            # 完整演练
 *   npx tsx scripts/v5-selfheal-drill.ts --cleanup  # 中断后清场(kill -9 等)
 *
 * 纪律(设计审裁定,勿破):
 *   - 全程单一 PG 连接持 advisory lock(多连接=锁形同虚设);
 *   - 正常收尾:condition→false → 等归因终态 → auto_repair→false;
 *   - 异常清场:auto_repair→false **先行**(防新 repair 再生),再 condition→false;
 *   - 演练键只认精确常量 SELFHEAL_DRILL_TRANSPORT(cooldown 豁免/broker 白名单
 *     同一契约),严禁前缀化。
 */
import process from "node:process";
import { Client } from "pg";
import { SELFHEAL_DRILL_TRANSPORT } from "../packages/commercial/src/selfheal/conditionKeys.js";
import { ACTIVE_REPAIR_STATUSES } from "../packages/commercial/src/selfheal/repairDispatcher.js";

const LOCK_NS = "v5-selfheal-drill";
const CLEANUP = process.argv.includes("--cleanup");

const STEP_TIMEOUTS_MS = {
  incidentOpen: 40_000, // reconciler tick 10s
  repairDispatched: 90_000, // sweeper tick + 隧道 POST
  repairAcked: 180_000, // 个人版 receiver→jobWorker 接单
  repairVerifying: 15 * 60_000, // codex 会话跑 drill 两步(含模型排队)
  resolvedByCodex: 120_000, // 探测翻 false 后 sweeper 收口
} as const;

function log(msg: string): void {
  process.stdout.write(`[drill ${new Date().toISOString()}] ${msg}\n`);
}
function fail(msg: string): never {
  process.stderr.write(`[drill][FAIL] ${msg}\n`);
  process.exit(1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 轮询直到 probe 返回非 null(带截止);超时返回 null。 */
async function pollUntil<T>(
  deadlineMs: number,
  intervalMs: number,
  probe: () => Promise<T | null>,
): Promise<T | null> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() >= until) return null;
    await sleep(intervalMs);
  }
}

async function writeCondition(c: Client, firing: boolean): Promise<void> {
  await c.query(
    `SELECT * FROM write_alert_condition($1, 'probe', $2, 'warning',
       $3::jsonb, now())`,
    [
      SELFHEAL_DRILL_TRANSPORT,
      firing,
      JSON.stringify({ kind: "drill", note: "transport drill, operator-orchestrated" }),
    ],
  );
}

async function setDrillAutoRepair(c: Client, on: boolean): Promise<void> {
  const r = await c.query(
    `UPDATE incident_policies SET auto_repair = $2, updated_at = NOW()
      WHERE match_kind = 'exact' AND match_key = $1`,
    [SELFHEAL_DRILL_TRANSPORT, on],
  );
  if (r.rowCount !== 1) fail(`drill policy 不存在或不唯一(0155 未 apply?)rowCount=${r.rowCount}`);
}

/** 异常清场:auto_repair 先关(防再派),再翻 condition false。 */
async function emergencyCleanup(c: Client): Promise<void> {
  try {
    await setDrillAutoRepair(c, false);
  } catch (e) {
    process.stderr.write(`[drill][cleanup] auto_repair=false 失败:${String(e)}\n`);
  }
  try {
    await writeCondition(c, false);
  } catch (e) {
    process.stderr.write(`[drill][cleanup] condition=false 失败:${String(e)}\n`);
  }
  const dump = await c.query(
    `SELECT r.id, r.status, r.attempt, r.updated_at
       FROM codex_repairs r JOIN incidents i ON i.id = r.incident_id
      WHERE i.condition_key = $1
      ORDER BY r.updated_at DESC LIMIT 5`,
    [SELFHEAL_DRILL_TRANSPORT],
  );
  process.stderr.write(
    `[drill][cleanup] drill repairs 现状:${JSON.stringify(dump.rows)}\n` +
      `[drill][cleanup] 残留活跃 repair 会被 incident resolve/cancel 流自然收口;必要时到 admin 自愈页处置。\n`,
  );
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) fail("DATABASE_URL 未设置(先 source /etc/openclaude/commercial-v5.env)");
  const c = new Client({ connectionString: dbUrl });
  await c.connect();

  // 单连接会话锁:连接断开自动释放,无需手动 unlock。
  const lock = await c.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
    [LOCK_NS],
  );
  if (!lock.rows[0]?.ok) fail("另一个 drill 会话持锁中 —— 同一时刻只允许一场演练");

  if (CLEANUP) {
    log("--cleanup:执行安全清场(auto_repair=false 先行 → condition=false)");
    await emergencyCleanup(c);
    await c.end();
    return;
  }

  try {
    // ── 检查点 1:预检 ─────────────────────────────────────────────
    const active = await c.query(
      `SELECT id, status FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 3`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (active.rows.length > 0)
      fail(`存在活跃 repair(singleflight 会互抢):${JSON.stringify(active.rows)}`);
    const rival = await c.query(
      `SELECT i.id, i.condition_key FROM incidents i
         JOIN incident_policies p ON p.id = i.policy_id
        WHERE i.status IN ('open','repairing')
          AND p.auto_repair = TRUE AND p.enabled = TRUE
          AND p.match_key <> $1 LIMIT 3`,
      [SELFHEAL_DRILL_TRANSPORT],
    );
    if (rival.rows.length > 0)
      fail(`存在其它可派单 incident(会与 drill 抢 singleflight 槽):${JSON.stringify(rival.rows)}`);
    const pol = await c.query<{ enabled: boolean; user_notice_enabled: boolean }>(
      `SELECT enabled, user_notice_enabled FROM incident_policies
        WHERE match_kind = 'exact' AND match_key = $1`,
      [SELFHEAL_DRILL_TRANSPORT],
    );
    if (pol.rows.length !== 1 || !pol.rows[0].enabled || pol.rows[0].user_notice_enabled)
      fail(`drill policy 姿态异常:${JSON.stringify(pol.rows)}(期望 enabled=t, user_notice=f)`);
    log("✓ 1/9 预检通过:无活跃 repair、无竞争 incident、drill policy 姿态正确");

    // ── 检查点 2:condition firing ────────────────────────────────
    await setDrillAutoRepair(c, true);
    await writeCondition(c, true);
    const cond = await c.query<{ firing: boolean }>(
      `SELECT firing FROM admin_alert_rule_state WHERE rule_id = $1`,
      [SELFHEAL_DRILL_TRANSPORT],
    );
    if (cond.rows[0]?.firing !== true) fail("write_alert_condition 后 condition 未 firing");
    log("✓ 2/9 condition firing=true 已落(经 write_alert_condition 单写权威)");

    // ── 检查点 3:reconciler 开 incident ──────────────────────────
    const incident = await pollUntil(STEP_TIMEOUTS_MS.incidentOpen, 2_000, async () => {
      const r = await c.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM incidents
          WHERE condition_key = $1 AND status IN ('open','repairing')
          ORDER BY opened_at DESC LIMIT 1`,
        [SELFHEAL_DRILL_TRANSPORT],
      );
      return r.rows[0] ?? null;
    });
    if (!incident) fail("reconciler 未在时限内打开 drill incident(查 selfheal_reconcile 日志)");
    const incidentId = incident.id;
    log(`✓ 3/9 incident #${incidentId} 已打开(纯内部账本,无用户广播)`);

    // ── 检查点 4:派单 → dispatched ───────────────────────────────
    const repair = await pollUntil(STEP_TIMEOUTS_MS.repairDispatched, 2_000, async () => {
      const r = await c.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM codex_repairs
          WHERE incident_id = $1::bigint AND status <> 'pending'
          ORDER BY id DESC LIMIT 1`,
        [incidentId],
      );
      return r.rows[0] ?? null;
    });
    if (!repair) fail("sweeper/dispatcher 未在时限内派单(闸门 DISPATCH_DISABLED?隧道 18795?)");
    const repairId = repair.id;
    log(`✓ 4/9 repair #${repairId} 已派出(${repair.status})`);

    // ── 检查点 5:执行侧接单(ack/progress 回调)───────────────────
    const acked = await pollUntil(STEP_TIMEOUTS_MS.repairAcked, 3_000, async () => {
      const r = await c.query<{ kind: string }>(
        `SELECT kind FROM codex_repair_events
          WHERE repair_id = $1::bigint AND kind IN ('ack','progress') LIMIT 1`,
        [repairId],
      );
      return r.rows[0] ?? null;
    });
    if (!acked) fail("执行侧未回 ack/progress(个人版 receiver/jobWorker 日志、隧道 18796)");
    log("✓ 5/9 执行侧已接单并回报(双向隧道 + broker 通路活)");

    // ── 检查点 6:done → verifying(绝不直达 succeeded)────────────
    const verifying = await pollUntil(STEP_TIMEOUTS_MS.repairVerifying, 5_000, async () => {
      const r = await c.query<{ status: string; verify_after: Date | null }>(
        `SELECT status, verify_after FROM codex_repairs WHERE id = $1::bigint`,
        [repairId],
      );
      const row = r.rows[0];
      if (!row) return null;
      if (["failed", "timeout", "verification_failed", "cancelled"].includes(row.status))
        fail(`repair 进入失败终态 ${row.status} —— 查 codex_repair_events + 个人版 selfheal 日志`);
      if (row.status === "succeeded")
        fail("repair 未经 verifying 直达 succeeded —— done→verifying 状态机被破坏");
      return row.status === "verifying" && row.verify_after ? row : null;
    });
    if (!verifying) fail("repair 未在时限内进入 verifying(codex 会话卡住?)");
    log("✓ 6/9 repair=verifying,verify_after 已冻结(模型自述 done ≠ 完成证据)");

    // ── 检查点 7:无用户侧副作用 ──────────────────────────────────
    const sideEffects = await c.query<{ deliveries: string; proposals: string }>(
      `SELECT
         (SELECT COUNT(*) FROM incident_deliveries WHERE incident_id = $1::bigint)::text AS deliveries,
         (SELECT COUNT(*) FROM selfheal_user_notice_proposals WHERE incident_id = $1::bigint)::text AS proposals`,
      [incidentId],
    );
    if (sideEffects.rows[0]?.deliveries !== "0" || sideEffects.rows[0]?.proposals !== "0")
      fail(`出现用户侧副作用:${JSON.stringify(sideEffects.rows[0])}(drill 必须零触达)`);
    log("✓ 7/9 零用户侧副作用(无 delivery、无 user-notice proposal)");

    // ── 检查点 8:新鲜恢复观测(observed_at > verify_after)────────
    await pollUntil(30_000, 1_000, async () => {
      const r = await c.query<{ fresh: boolean }>(
        `SELECT clock_timestamp() > verify_after AS fresh FROM codex_repairs WHERE id = $1::bigint`,
        [repairId],
      );
      return r.rows[0]?.fresh ? true : null;
    });
    await writeCondition(c, false);
    const obs = await c.query<{ fresh: boolean }>(
      `SELECT s.observed_at > r.verify_after AS fresh
         FROM admin_alert_rule_state s, codex_repairs r
        WHERE s.rule_id = $1 AND r.id = $2::bigint`,
      [SELFHEAL_DRILL_TRANSPORT, repairId],
    );
    if (obs.rows[0]?.fresh !== true) fail("恢复观测未晚于 verify_after(freshness fence 语义破坏)");
    log("✓ 8/9 恢复观测已写入且晚于 verify_after(probe 不会抢跑归因)");

    // ── 检查点 9:codex 归因收口 ──────────────────────────────────
    const final = await pollUntil(STEP_TIMEOUTS_MS.resolvedByCodex, 2_000, async () => {
      const r = await c.query<{ rstatus: string; istatus: string; source: string | null }>(
        `SELECT r.status AS rstatus, i.status AS istatus, i.resolve_source AS source
           FROM codex_repairs r JOIN incidents i ON i.id = r.incident_id
          WHERE r.id = $1::bigint`,
        [repairId],
      );
      const row = r.rows[0];
      return row && row.rstatus === "succeeded" && row.istatus === "resolved" ? row : null;
    });
    if (!final) fail("sweeper 未在时限内完成 succeeded+resolved 收口");
    if (final.source !== "codex")
      fail(`resolve_source='${final.source}',期望 'codex' —— probe 抢跑了归因(P3 守卫回归?)`);
    log("✓ 9/9 修复成功归因 codex(repair=succeeded ∧ incident=resolved ∧ source=codex)");

    // ── 正常收尾:等终态后才翻回 auto_repair ───────────────────────
    await setDrillAutoRepair(c, false);
    const leftover = await c.query(
      `SELECT id, status FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 3`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (leftover.rows.length > 0)
      fail(`收尾后仍有活跃 repair:${JSON.stringify(leftover.rows)}`);
    log("演练通过:9/9 全绿,drill policy 已回 auto_repair=false,无残留。可立即重跑回归。");
  } catch (err) {
    process.stderr.write(`[drill][ERROR] ${String((err as Error)?.stack ?? err)}\n`);
    await emergencyCleanup(c);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

await main();

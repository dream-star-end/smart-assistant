#!/usr/bin/env -S npx tsx
/**
 * v5-selfheal-drill — 自愈闭环合成演练(operator CLI,root 在 kl-mirror 生产库上运行)。
 *
 * 两类演练:
 *  ① transport(默认,无参):condition→incident→派单→隧道→个人版 context/report→done→
 *     verifying→探测翻 false→codex 归因收口。九检查点全绿 = transport 面健康。**不含部署面**。
 *  ② release(批1b,`--release` + `--approve`,两段人工确认):transport 全链之上再走
 *     verify/cutover→pending_release→boss 一键放行(真实 admin API)→真部署→/version 翻转→
 *     repair verifying→codex 归因。低峰监督专项,验收真跑一次(docs-only commit 载荷)。
 *
 * 用法(kl-mirror,release 树内;先 `set -a && . /etc/openclaude/commercial-v5.env && set +a`):
 *   npx tsx scripts/v5-selfheal-drill.ts                 # transport 完整演练
 *   npx tsx scripts/v5-selfheal-drill.ts --cleanup       # 中断后清场(transport+release 残留)
 *   npx tsx scripts/v5-selfheal-drill.ts --release       # release 段①:武装→轮询 pending_release→退出待放行
 *   npx tsx scripts/v5-selfheal-drill.ts --approve <repairId>
 *                                                        # release 段②:stdin 读 admin bearer→放行→
 *                                                        # 轮询真部署+/version+verifying→翻 condition→归因
 *   npx tsx scripts/v5-selfheal-drill.ts --help          # 用法(不连库)
 *
 * env(release 段):V5_ADMIN_BASE_URL(默认 http://127.0.0.1:18790;P3 active slot=B 时传 18795)。
 *
 * 纪律(设计审 + RFC §5,勿破):
 *   - 全程单一 PG 连接持 advisory lock(多连接=锁形同虚设);
 *   - 演练键只认精确常量(SELFHEAL_DRILL_TRANSPORT / SELFHEAL_DRILL_RELEASE);cooldown 豁免/
 *     broker 白名单同一契约,严禁前缀化;
 *   - 异常清场:auto_repair→false **先行**(防新 repair 再生),再 condition→false;
 *   - release 段:condition 必须保持 firing,直到同时确认 /version==候选 sha ∧ deployed 落库 ∧
 *     repair=verifying —— 才写 false(提前翻 false 会让 probe 抢跑归因,演练失真)。
 */
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import {
  SELFHEAL_DRILL_TRANSPORT,
  SELFHEAL_DRILL_RELEASE,
} from "../packages/commercial/src/selfheal/conditionKeys.js";
import { ACTIVE_REPAIR_STATUSES } from "../packages/commercial/src/selfheal/repairDispatcher.js";

const execFileAsync = promisify(execFile);
// 仓库根 = 本脚本(scripts/v5-selfheal-drill.ts)上一级,与 operator 的 cwd 无关(release 树内跑更稳)。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCK_NS = "v5-selfheal-drill";
const ARGV = process.argv.slice(2);
const HELP = ARGV.includes("--help") || ARGV.includes("-h");
const CLEANUP = ARGV.includes("--cleanup");
const RELEASE = ARGV.includes("--release");
const APPROVE = ARGV.includes("--approve");
const ADMIN_BASE = (process.env.V5_ADMIN_BASE_URL ?? "http://127.0.0.1:18790").replace(/\/+$/, "");

/** --approve <repairId> 或 --approve=<repairId> 取值。 */
function approveRepairId(): string | null {
  const eq = ARGV.find((a) => a.startsWith("--approve="));
  if (eq) return eq.slice("--approve=".length).trim() || null;
  const i = ARGV.indexOf("--approve");
  if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith("-")) return ARGV[i + 1].trim();
  return null;
}

const STEP_TIMEOUTS_MS = {
  incidentOpen: 40_000, // reconciler tick 10s
  repairDispatched: 90_000, // sweeper tick + 隧道 POST
  repairAcked: 180_000, // 个人版 receiver→jobWorker 接单
  repairVerifying: 15 * 60_000, // codex 会话跑 drill 两步(含模型排队)
  resolvedByCodex: 120_000, // 探测翻 false 后 sweeper 收口
  // ── release 段专属 ──
  pendingRelease: 30 * 60_000, // codex 跑 context/report/verify/cutover 到 pending_release
  releaseDeployed: 90 * 60_000, // 放行→真部署(build+activate+smoke)+ deployed 回调落库(对齐 lane timeout)
} as const;

function log(msg: string): void {
  process.stdout.write(`[drill ${new Date().toISOString()}] ${msg}\n`);
}
/** 演练期断言失败:必须 throw(进 catch 走 emergencyCleanup),绝不 process.exit。 */
function fail(msg: string): never {
  throw new Error(`[drill-assert] ${msg}`);
}
/** 进入临界区(翻 policy)之前的硬退出:此时无任何生产副作用需要清理。 */
function abort(msg: string): never {
  process.stderr.write(`[drill][ABORT] ${msg}\n`);
  process.exit(1);
}

/** 在仓库根跑 git(只读:ls-remote / rev-parse)。失败抛 Error(含 stderr),由调用方 fail()。 */
async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT, maxBuffer: 4 << 20 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(" ")} 失败:${(err?.stderr || err?.message || String(e)).trim()}`);
  }
}

/** `git ls-remote origin <ref>` 解析出的 sha(空=ref 不存在)。 */
async function lsRemoteSha(ref: string): Promise<string> {
  const out = await git(["ls-remote", "origin", ref]);
  return out.split(/\s+/)[0] ?? "";
}

/**
 * canonical 分支来源(F13②):本仓无既定常量/env,deploy-v5.sh 亦仅用 `git rev-parse --abbrev-ref HEAD`
 * 作分支判定。故取运行时最稳妥源:优先当前工作树**上游跟踪分支**短名(origin/<b>→<b>),无上游则回退
 * HEAD 分支名(与 deploy-v5.sh 同源);detached 且无上游则 fail(candidate/canonical head 断言需分支名)。
 */
async function resolveCanonicalBranch(): Promise<string> {
  try {
    const up = await git(["rev-parse", "--abbrev-ref", "@{u}"]); // e.g. origin/feat/v5-aurora-rewrite
    const slash = up.indexOf("/");
    if (slash > 0) return up.slice(slash + 1); // 去掉首段 remote 名(分支名本身可含 /)
  } catch {
    /* 无上游跟踪分支 → 回退 HEAD 分支名 */
  }
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head && head !== "HEAD") return head;
  fail("无法确定 canonical 分支(工作树 detached 且无上游跟踪分支;candidate/canonical head 断言需要分支名)");
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

/** 写演练 condition(参数化 key + note,transport / release 共用单写权威 write_alert_condition)。 */
async function writeCondition(c: Client, key: string, firing: boolean, note: string): Promise<void> {
  await c.query(
    `SELECT * FROM write_alert_condition($1, 'probe', $2, 'warning', $3::jsonb, now())`,
    [key, firing, JSON.stringify({ kind: "drill", note })],
  );
}

async function setDrillAutoRepair(c: Client, key: string, on: boolean): Promise<void> {
  const r = await c.query(
    `UPDATE incident_policies SET auto_repair = $2, updated_at = NOW()
      WHERE match_kind = 'exact' AND match_key = $1`,
    [key, on],
  );
  if (r.rowCount !== 1)
    fail(`drill policy 不存在或不唯一(迁移未 apply?)key=${key} rowCount=${r.rowCount}`);
}

/** 异常清场:auto_repair 先关(防再派),再翻 condition false。参数化 key,可对指定演练键收敛。 */
async function emergencyCleanup(c: Client, key: string): Promise<void> {
  try {
    await setDrillAutoRepair(c, key, false);
  } catch (e) {
    process.stderr.write(`[drill][cleanup] ${key} auto_repair=false 失败:${String(e)}\n`);
  }
  try {
    await writeCondition(c, key, false, "cleanup");
  } catch (e) {
    process.stderr.write(`[drill][cleanup] ${key} condition=false 失败:${String(e)}\n`);
  }
  const dump = await c.query(
    `SELECT r.id, r.status, r.attempt, r.updated_at
       FROM codex_repairs r JOIN incidents i ON i.id = r.incident_id
      WHERE i.condition_key = $1
      ORDER BY r.updated_at DESC LIMIT 5`,
    [key],
  );
  process.stderr.write(
    `[drill][cleanup] ${key} repairs 现状:${JSON.stringify(dump.rows)}\n` +
      `[drill][cleanup] 残留活跃 repair 会被 incident resolve/cancel 流自然收口;必要时到 admin 自愈页处置。\n`,
  );
}

/** 清场后终态校验:auto_repair 与 firing 都必须已放平,否则返回 false。 */
async function assertCleanPosture(c: Client, key: string): Promise<boolean> {
  const r = await c.query<{ auto_repair: boolean; firing: boolean | null }>(
    `SELECT p.auto_repair, s.firing
       FROM incident_policies p
       LEFT JOIN admin_alert_rule_state s ON s.rule_id = p.match_key
      WHERE p.match_kind = 'exact' AND p.match_key = $1`,
    [key],
  );
  const row = r.rows[0];
  const clean = !!row && row.auto_repair === false && row.firing !== true;
  if (!clean) process.stderr.write(`[drill][cleanup] ${key} 终态未放平:${JSON.stringify(r.rows)}\n`);
  return clean;
}

function usage(): void {
  process.stdout.write(
    [
      "v5-selfheal-drill — 自愈闭环演练(transport 默认 / release 两段)",
      "",
      "  npx tsx scripts/v5-selfheal-drill.ts                 transport 完整演练",
      "  npx tsx scripts/v5-selfheal-drill.ts --cleanup       中断后清场(transport+release)",
      "  npx tsx scripts/v5-selfheal-drill.ts --release       release 段①:武装→pending_release→待放行",
      "  npx tsx scripts/v5-selfheal-drill.ts --approve <id>  release 段②:放行→真部署→归因",
      "  npx tsx scripts/v5-selfheal-drill.ts --help          本用法",
      "",
      "env:DATABASE_URL(必需,先 source commercial-v5.env);V5_ADMIN_BASE_URL(release 段,默认 :18790)",
      "",
      "release 段纪律:condition 保持 firing 直到 /version==候选sha ∧ deployed 落库 ∧ repair=verifying;",
      "归因必须 source=codex(不被 probe 抢跑);清场后 policy auto_repair=false、无活跃 release request、无熔断。",
      "",
    ].join("\n"),
  );
}

// ─────────────────────── transport 演练主体(九检查点,原样保留)───────────────────────
async function runTransportDrill(c: Client): Promise<void> {
  const KEY = SELFHEAL_DRILL_TRANSPORT;
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
      [KEY],
    );
    if (rival.rows.length > 0)
      fail(`存在其它可派单 incident(会与 drill 抢 singleflight 槽):${JSON.stringify(rival.rows)}`);
    const pol = await c.query<{ enabled: boolean; user_notice_enabled: boolean }>(
      `SELECT enabled, user_notice_enabled FROM incident_policies
        WHERE match_kind = 'exact' AND match_key = $1`,
      [KEY],
    );
    if (pol.rows.length !== 1 || !pol.rows[0].enabled || pol.rows[0].user_notice_enabled)
      fail(`drill policy 姿态异常:${JSON.stringify(pol.rows)}(期望 enabled=t, user_notice=f)`);
    log("✓ 1/9 预检通过:无活跃 repair、无竞争 incident、drill policy 姿态正确");

    // ── 检查点 2:condition firing ────────────────────────────────
    await setDrillAutoRepair(c, KEY, true);
    await writeCondition(c, KEY, true, "transport drill, operator-orchestrated");
    const cond = await c.query<{ firing: boolean }>(
      `SELECT firing FROM admin_alert_rule_state WHERE rule_id = $1`,
      [KEY],
    );
    if (cond.rows[0]?.firing !== true) fail("write_alert_condition 后 condition 未 firing");
    log("✓ 2/9 condition firing=true 已落(经 write_alert_condition 单写权威)");

    // ── 检查点 3:reconciler 开 incident ──────────────────────────
    const incident = await pollUntil(STEP_TIMEOUTS_MS.incidentOpen, 2_000, async () => {
      const r = await c.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM incidents
          WHERE condition_key = $1 AND status IN ('open','repairing')
          ORDER BY opened_at DESC LIMIT 1`,
        [KEY],
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
    await assertNoUserSideEffects(c, incidentId);
    log("✓ 7/9 零用户侧副作用(无 delivery、无 inbox 落信、无 user-notice proposal)");

    // ── 检查点 8:新鲜恢复观测(observed_at > verify_after)────────
    await pollUntil(30_000, 1_000, async () => {
      const r = await c.query<{ fresh: boolean }>(
        `SELECT clock_timestamp() > verify_after AS fresh FROM codex_repairs WHERE id = $1::bigint`,
        [repairId],
      );
      return r.rows[0]?.fresh ? true : null;
    });
    await writeCondition(c, KEY, false, "transport drill recovery");
    const obs = await c.query<{ fresh: boolean }>(
      `SELECT s.observed_at > r.verify_after AS fresh
         FROM admin_alert_rule_state s, codex_repairs r
        WHERE s.rule_id = $1 AND r.id = $2::bigint`,
      [KEY, repairId],
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
    await setDrillAutoRepair(c, KEY, false);
    const leftover = await c.query(
      `SELECT id, status FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 3`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (leftover.rows.length > 0)
      fail(`收尾后仍有活跃 repair:${JSON.stringify(leftover.rows)}`);
    log("演练通过:9/9 全绿,drill policy 已回 auto_repair=false,无残留。可立即重跑回归。");
  } catch (err) {
    process.stderr.write(`[drill][ERROR] ${String((err as Error)?.stack ?? err)}\n`);
    await emergencyCleanup(c, KEY);
    throw err;
  }
}

/** incident 无 delivery / inbox / user-notice proposal 副作用(transport 检查点7 + release 清场复用)。 */
async function assertNoUserSideEffects(c: Client, incidentId: string): Promise<void> {
  const se = (
    await c.query<{ deliveries: string; proposals: string; inbox: string }>(
      `SELECT
         (SELECT COUNT(*) FROM incident_deliveries WHERE incident_id = $1::bigint)::text AS deliveries,
         (SELECT COUNT(*) FROM selfheal_user_notice_proposals WHERE incident_id = $1::bigint)::text AS proposals,
         (SELECT COUNT(*) FROM inbox_messages
           WHERE source_type = 'incident' AND source_id = $1::bigint)::text AS inbox`,
      [incidentId],
    )
  ).rows[0];
  if (se?.deliveries !== "0" || se?.proposals !== "0" || se?.inbox !== "0")
    fail(`出现用户侧副作用:${JSON.stringify(se)}(drill 必须零触达)`);
}

// ─────────────────────────── release 段① --release(武装 → pending_release)───────────────
async function runReleaseDrill(c: Client): Promise<void> {
  const KEY = SELFHEAL_DRILL_RELEASE;
  try {
    // 预检:无活跃 repair、无竞争 incident、release drill policy 姿态(tier2、user_notice=f、enabled=t)。
    const active = await c.query(
      `SELECT id, status FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 3`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (active.rows.length > 0) fail(`存在活跃 repair:${JSON.stringify(active.rows)}`);
    const rival = await c.query(
      `SELECT i.id, i.condition_key FROM incidents i
         JOIN incident_policies p ON p.id = i.policy_id
        WHERE i.status IN ('open','repairing')
          AND p.auto_repair = TRUE AND p.enabled = TRUE AND p.match_key <> $1 LIMIT 3`,
      [KEY],
    );
    if (rival.rows.length > 0)
      fail(`存在其它可派单 incident(会抢 singleflight 槽):${JSON.stringify(rival.rows)}`);
    const pol = await c.query<{ enabled: boolean; user_notice_enabled: boolean; execution_class: string }>(
      `SELECT enabled, user_notice_enabled, execution_class FROM incident_policies
        WHERE match_kind = 'exact' AND match_key = $1`,
      [KEY],
    );
    const prow = pol.rows[0];
    if (
      pol.rows.length !== 1 ||
      !prow.enabled ||
      prow.user_notice_enabled ||
      prow.execution_class !== "tier2"
    )
      fail(`release drill policy 姿态异常:${JSON.stringify(pol.rows)}(期望 enabled=t,user_notice=f,tier2)`);
    // 熔断预检:全局 release 熔断 engaged 时禁演练(会被 intake/admin 挡)。
    const fuse0 = await c.query<{ engaged: boolean }>(
      `SELECT engaged FROM selfheal_release_fuse WHERE id = 1`,
    );
    if (fuse0.rows[0]?.engaged) fail("selfheal_release_fuse 已 engaged —— 先人工审计清熔断再演练");
    log("✓ 预检通过:无活跃 repair、无竞争 incident、release drill policy=tier2 姿态正确、熔断未 engaged");

    // 武装:auto_repair=TRUE + condition firing(与 transport 同,派单需 auto_repair)。
    await setDrillAutoRepair(c, KEY, true);
    await writeCondition(c, KEY, true, "release drill, operator-orchestrated(段①武装)");
    log("· release drill 已武装(auto_repair=true, condition firing)");

    // 轮询链:incident → repair → pending_release 事件(结构化 detail)。
    const incident = await pollUntil(STEP_TIMEOUTS_MS.incidentOpen, 2_000, async () => {
      const r = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM incidents
          WHERE condition_key = $1 AND status IN ('open','repairing')
          ORDER BY opened_at DESC LIMIT 1`,
        [KEY],
      );
      return r.rows[0] ?? null;
    });
    if (!incident) fail("reconciler 未打开 release drill incident");
    const incidentId = incident.id;
    log(`· incident #${incidentId} 已打开`);

    const repair = await pollUntil(STEP_TIMEOUTS_MS.repairDispatched, 2_000, async () => {
      const r = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM codex_repairs
          WHERE incident_id = $1::bigint AND status <> 'pending' ORDER BY id DESC LIMIT 1`,
        [incidentId],
      );
      return r.rows[0] ?? null;
    });
    if (!repair) fail("sweeper 未派单(DISPATCH_DISABLED?隧道?)");
    const repairId = repair.id;
    log(`· repair #${repairId} 已派出;等待 codex 跑 context/report/verify/cutover → pending_release …`);

    // pending_release:kind='progress' 且 detail.phase='pending_release',结构化字段齐全。
    const pending = await pollUntil(STEP_TIMEOUTS_MS.pendingRelease, 5_000, async () => {
      const r = await c.query<{ rstatus: string }>(
        `SELECT status AS rstatus FROM codex_repairs WHERE id = $1::bigint`,
        [repairId],
      );
      const rs = r.rows[0]?.rstatus;
      if (rs && ["failed", "timeout", "verification_failed", "cancelled"].includes(rs))
        fail(`repair 进入失败终态 ${rs} —— 查 codex_repair_events + 个人版 selfheal 日志`);
      const e = await c.query<{ sha: string | null; dph: string | null; mh: string | null }>(
        `SELECT detail->>'sha' AS sha, detail->>'deployPlanHash' AS dph, detail->>'manifestHash' AS mh
           FROM codex_repair_events
          WHERE repair_id = $1::bigint AND kind = 'progress'
            AND detail->>'phase' = 'pending_release'
          ORDER BY id DESC LIMIT 1`,
        [repairId],
      );
      const row = e.rows[0];
      if (!row) return null;
      if (!row.sha || !/^[0-9a-f]{40}$/.test(row.sha)) fail(`pending_release 事件 sha 形态非法:${row.sha}`);
      if (!row.dph || !row.mh) fail("pending_release 事件缺 deployPlanHash/manifestHash(结构化契约破坏)");
      return row;
    });
    if (!pending) fail("repair 未在时限内到达结构化 pending_release(codex 卡住 / verify/cutover 失败?)");

    // 无用户侧副作用(pending_release 阶段也须零触达)。
    await assertNoUserSideEffects(c, incidentId);

    // ── 武装完成:保持 policy 翻开 + condition firing,退出待人工 --approve(不清场)──
    log("");
    log(`✓ release drill 段① 完成:repair #${repairId} 已抵达 pending_release(待放行)。`);
    log(`  候选 SHA:${pending.sha}`);
    log(`  deployPlanHash:${pending.dph}`);
    log(`  manifestHash:${pending.mh}`);
    log("");
    log("  ── 后续人工步(段②)──");
    log(`  低峰监督下执行(stdin 会提示输入 admin bearer,不回显):`);
    log(`    npx tsx scripts/v5-selfheal-drill.ts --approve ${repairId}`);
    log("");
    log("  ⚠ condition 保持 firing、policy 保持 auto_repair=true(供段②归因)。");
    log("  ⚠ 若放弃演练:npx tsx scripts/v5-selfheal-drill.ts --cleanup(会自动回滚 policy/condition)。");
    log("  ⚠ 长时间不放行:该 pending_release 停留 running 姿态,不会自动部署,但请及时 --approve 或 --cleanup。");
    // 正常返回(clean exit,不触发 emergencyCleanup)。
  } catch (err) {
    process.stderr.write(`[drill][release ERROR] ${String((err as Error)?.stack ?? err)}\n`);
    await emergencyCleanup(c, KEY);
    throw err;
  }
}

// ─────────────────── release 段② --approve <repairId>(放行 → 真部署 → 归因)───────────────
async function runApproveDrill(c: Client, repairId: string): Promise<void> {
  const KEY = SELFHEAL_DRILL_RELEASE;
  if (!/^[1-9][0-9]{0,19}$/.test(repairId)) abort(`--approve <repairId> 非法:${repairId}`);
  try {
    // 复核 repair 处于 pending_release 姿态,取候选 sha / incident。
    const rep = await c.query<{ status: string; incident_id: string }>(
      `SELECT status, incident_id::text AS incident_id FROM codex_repairs WHERE id = $1::bigint`,
      [repairId],
    );
    if (rep.rows.length === 0) abort(`repair #${repairId} 不存在`);
    if (rep.rows[0].status !== "running")
      abort(`repair #${repairId} 状态=${rep.rows[0].status}(期望 running/pending_release 姿态)`);
    const incidentId = rep.rows[0].incident_id;
    const inc = await c.query<{ condition_key: string }>(
      `SELECT condition_key FROM incidents WHERE id = $1::bigint`,
      [incidentId],
    );
    if (inc.rows[0]?.condition_key !== KEY)
      abort(`repair #${repairId} 不属于 release drill(condition_key=${inc.rows[0]?.condition_key})`);
    const pe = await c.query<{ sha: string }>(
      `SELECT detail->>'sha' AS sha FROM codex_repair_events
        WHERE repair_id = $1::bigint AND kind = 'progress' AND detail->>'phase' = 'pending_release'
        ORDER BY id DESC LIMIT 1`,
      [repairId],
    );
    const approvedSha = pe.rows[0]?.sha;
    if (!approvedSha || !/^[0-9a-f]{40}$/.test(approvedSha))
      abort(`未取到合法 pending_release 候选 sha(repair #${repairId} 是否已过 pending_release?)`);
    log(`· repair #${repairId} 处于 pending_release,候选 SHA=${approvedSha}`);

    // admin bearer 从 stdin 读(不回显;禁 env/文件)。
    const token = await readAdminBearer();
    if (!token) abort("未读到 admin bearer(stdin 为空)");

    // POST 放行(真实 admin 身份 API)→ 202 releaseRequestId(或 409 已有活跃请求 → 复用)。
    const rrid = await postReleaseApproval(repairId, token);
    log(`· 放行已受理:releaseRequestId=${rrid}(202 queued)`);

    // 轮询三条件(RFC §5:全部满足才翻 condition false):
    //   ① release request status='deployed';② /version==候选 sha 前缀;③ repair status='verifying'。
    const deployed = await pollUntil(STEP_TIMEOUTS_MS.releaseDeployed, 10_000, async () => {
      const rr = await c.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason FROM selfheal_release_requests WHERE release_request_id = $1`,
        [rrid],
      );
      const st = rr.rows[0]?.status;
      if (st && ["deploy_failed", "manual_required", "cancelled"].includes(st))
        fail(`release request 进入失败终态 ${st}(reason=${rr.rows[0]?.failure_reason ?? ""})`);
      if (st === "deploy_unknown") fail("release request=deploy_unknown(全局熔断已拉起)—— 人工按 /version/ref 裁决");
      return st === "deployed" ? rr.rows[0] : null;
    });
    if (!deployed) fail("release request 未在时限内到 deployed(查交付/回调/个人版 releaseWorker 日志)");
    log("· ① release request=deployed(deployed 回调已落库)");

    const versionOk = await pollUntil(STEP_TIMEOUTS_MS.repairVerifying, 5_000, async () => {
      const v = await fetchVersionShort();
      return v && approvedSha.startsWith(v) ? v : null;
    });
    if (!versionOk) fail(`/version 未翻转到候选 sha 前缀(base=${ADMIN_BASE};检查 active slot 端口/公有路由)`);
    log(`· ② /version 已翻转到候选 sha(short=${versionOk})`);

    const verifying = await pollUntil(STEP_TIMEOUTS_MS.repairVerifying, 3_000, async () => {
      const r = await c.query<{ status: string }>(
        `SELECT status FROM codex_repairs WHERE id = $1::bigint`,
        [repairId],
      );
      return r.rows[0]?.status === "verifying" ? r.rows[0] : null;
    });
    if (!verifying) fail("deployed 回调后 repair 未进 verifying(handleDone 收口回归?)");
    log("· ③ repair=verifying(deployed 回调同事务 running→verifying 收口)");

    // 三条件齐 → 翻 condition false(此前保持 firing,防 probe 抢跑归因)。
    await writeCondition(c, KEY, false, "release drill recovery(段②三条件齐)");
    log("· 三条件齐,已写 condition=false;等待 codex 归因收口 …");

    // 归因:repair succeeded + incident resolved + source=codex。
    const final = await pollUntil(STEP_TIMEOUTS_MS.resolvedByCodex, 3_000, async () => {
      const r = await c.query<{ rstatus: string; istatus: string; source: string | null }>(
        `SELECT r.status AS rstatus, i.status AS istatus, i.resolve_source AS source
           FROM codex_repairs r JOIN incidents i ON i.id = r.incident_id WHERE r.id = $1::bigint`,
        [repairId],
      );
      const row = r.rows[0];
      return row && row.rstatus === "succeeded" && row.istatus === "resolved" ? row : null;
    });
    if (!final) fail("sweeper 未在时限内完成 succeeded+resolved 收口");
    if (final.source !== "codex")
      fail(`resolve_source='${final.source}',期望 'codex' —— probe 抢跑了归因`);
    log("✓ 归因 codex(repair=succeeded ∧ incident=resolved ∧ source=codex)");

    // ── 清场断言(RFC §5)──
    await setDrillAutoRepair(c, KEY, false);
    const activeReq = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM selfheal_release_requests
        WHERE repair_id = $1::bigint AND status IN ('queued','accepted','deploying')`,
      [repairId],
    );
    if (activeReq.rows[0]?.n !== "0") fail(`清场:仍有活跃 release request(${activeReq.rows[0]?.n})`);
    const fuse = await c.query<{ engaged: boolean }>(`SELECT engaged FROM selfheal_release_fuse WHERE id = 1`);
    if (fuse.rows[0]?.engaged) fail("清场:selfheal_release_fuse engaged(deploy_unknown 熔断残留,人工审计清)");
    await assertNoUserSideEffects(c, incidentId);
    const leftover = await c.query(
      `SELECT id, status FROM codex_repairs WHERE status = ANY($1::text[]) LIMIT 3`,
      [ACTIVE_REPAIR_STATUSES as unknown as string[]],
    );
    if (leftover.rows.length > 0) fail(`清场:仍有活跃 repair:${JSON.stringify(leftover.rows)}`);

    // ── candidate ref / canonical head 精确性断言(F13②;git ls-remote origin,只读网络操作)──
    // drill 是 docs-only ff:approvedSha 应同时(a)被钉在不可变 candidate ref,(b)成为 canonical 分支新 head。
    // 任一与 approvedSha 不**精确**相等 = ff/推送异常(sha 漂移 / 推错分支 / 未 ff / 候选 ref 缺失)→ fail。
    const candRef = `refs/heads/selfheal/candidates/${repairId}-${approvedSha.slice(0, 12)}`;
    let candSha: string;
    try {
      candSha = await lsRemoteSha(candRef);
    } catch (e) {
      fail(`candidate ref 复核失败:${(e as Error).message}`);
    }
    if (candSha !== approvedSha)
      fail(`candidate ref ${candRef} 实际 head=${candSha || "<不存在>"},期望 approvedSha=${approvedSha}`);
    log(`· candidate ref 精确钉在 approvedSha(${candRef})`);

    const canonicalBranch = await resolveCanonicalBranch();
    let canonSha: string;
    try {
      canonSha = await lsRemoteSha(`refs/heads/${canonicalBranch}`);
    } catch (e) {
      fail(`canonical 分支复核失败:${(e as Error).message}`);
    }
    if (canonSha !== approvedSha)
      fail(
        `canonical 分支 ${canonicalBranch} 实际 head=${canonSha || "<不存在>"},期望 approvedSha=${approvedSha}` +
          "(docs-only ff 后应精确相等)",
      );
    log(`· canonical 分支 ${canonicalBranch} head 精确 == approvedSha`);

    log("");
    log("演练通过:release 段② 全绿。清场断言:policy auto_repair=false、无活跃 release request、无熔断、零用户触达。");
    log("  ── candidate / canonical / /version 关系(人工核对)──");
    log(`  候选 SHA(approvedSha)= ${approvedSha}`);
    log(`  线上 /version short  = ${versionOk}(应为 approvedSha 前缀)`);
    log(`  不可变候选 ref        = refs/heads/selfheal/candidates/${repairId}-${approvedSha.slice(0, 12)}`);
    log(`  releaseRequestId      = ${rrid}`);
    log("  说明:'代码已部署'(deployed)≠ '事故已由 probe 验证恢复'(resolved);二者本演练均已确认。");
  } catch (err) {
    process.stderr.write(`[drill][approve ERROR] ${String((err as Error)?.stack ?? err)}\n`);
    // 段②失败:不擅自翻 condition/auto_repair(可能真部署已改生产)。仅提示人工按 --cleanup + /version 裁决。
    process.stderr.write(
      "[drill][approve] 段② 失败未自动清场:真部署可能已改生产。请人工核对 /version、deploy_state、" +
        "selfheal_release_requests、selfheal_release_fuse,再决定 --cleanup 或走 fuse-clear 审计流。\n",
    );
    throw err;
  }
}

/** 从 stdin 读 admin bearer,不回显(TTY 走 raw no-echo;非 TTY 读一行)。禁 env/文件。 */
async function readAdminBearer(): Promise<string> {
  const stdin = process.stdin;
  const isTTY = stdin.isTTY === true;
  process.stderr.write("请输入 admin bearer token(不回显,回车结束):");
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          done();
          return;
        }
        if (code === 3) {
          // Ctrl-C(raw 模式下不产生 SIGINT,手动中断)
          cleanup();
          reject(new Error("stdin 输入被中断(Ctrl-C)"));
          return;
        }
        if (code === 127 || code === 8) {
          // DEL / Backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (isTTY) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      stdin.pause();
    };
    const done = () => {
      cleanup();
      process.stderr.write("\n");
      resolve(buf.trim());
    };
    stdin.setEncoding("utf8");
    if (isTTY) {
      try {
        stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** POST 放行 → 202 返回 releaseRequestId;409 已有活跃请求 → 复用 PG 中的活跃 rrid。 */
async function postReleaseApproval(repairId: string, token: string): Promise<string> {
  const url = `${ADMIN_BASE}/api/admin/selfheal/repairs/${repairId}/release`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const text = await res.text();
  if (res.status === 202) {
    const body = JSON.parse(text) as { releaseRequestId?: string };
    if (!body.releaseRequestId) fail(`202 但缺 releaseRequestId:${text}`);
    return body.releaseRequestId;
  }
  fail(`放行 API 非 202(status=${res.status}):${text.slice(0, 300)}`);
}

/** GET /version → 短 sha(commit 字段;缺则从 tag=v5-<short> 提取)。失败返回 null。 */
async function fetchVersionShort(): Promise<string | null> {
  try {
    const res = await fetch(`${ADMIN_BASE}/version`, { method: "GET" });
    if (!res.ok) return null;
    const j = (await res.json()) as { commit?: string; tag?: string };
    if (j.commit && /^[0-9a-f]{7,40}$/.test(j.commit)) return j.commit;
    const m = /v5-([0-9a-f]{7,40})/.exec(j.tag ?? "");
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (HELP) {
    usage();
    process.exit(0);
  }
  if (RELEASE && APPROVE) abort("--release 与 --approve 互斥,分两次执行");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) abort("DATABASE_URL 未设置(先 source /etc/openclaude/commercial-v5.env)");
  const c = new Client({ connectionString: dbUrl });
  await c.connect();

  // 单连接会话锁:连接断开自动释放,无需手动 unlock。
  const lock = await c.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
    [LOCK_NS],
  );
  if (!lock.rows[0]?.ok) abort("另一个 drill 会话持锁中 —— 同一时刻只允许一场演练");

  // SIGINT/SIGTERM → 清场后退出(kill -9 无法拦截,由 --cleanup 兜)。清场覆盖两演练键。
  let signalled = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (signalled) return;
      signalled = true;
      process.stderr.write(`[drill] ${sig} — 执行安全清场后退出\n`);
      void (async () => {
        await emergencyCleanup(c, SELFHEAL_DRILL_TRANSPORT).catch(() => {});
        await emergencyCleanup(c, SELFHEAL_DRILL_RELEASE).catch(() => {});
      })()
        .catch(() => {})
        .finally(() => process.exit(1));
    });
  }

  if (CLEANUP) {
    log("--cleanup:执行安全清场(auto_repair=false 先行 → condition=false),覆盖 transport + release");
    await emergencyCleanup(c, SELFHEAL_DRILL_TRANSPORT);
    await emergencyCleanup(c, SELFHEAL_DRILL_RELEASE);
    const t = await assertCleanPosture(c, SELFHEAL_DRILL_TRANSPORT);
    const r = await assertCleanPosture(c, SELFHEAL_DRILL_RELEASE);
    // release 残留额外报告:活跃 release request + 熔断(不自动清熔断,需审计流)。
    const rr = await c.query(
      `SELECT release_request_id, status FROM selfheal_release_requests
        WHERE status IN ('queued','accepted','deploying') ORDER BY id DESC LIMIT 10`,
    );
    const fuse = await c.query(`SELECT engaged, reason, release_request_id FROM selfheal_release_fuse WHERE id = 1`);
    if (rr.rows.length > 0)
      process.stderr.write(`[drill][cleanup] 活跃 release request(需 incident cancel 流收口):${JSON.stringify(rr.rows)}\n`);
    if (fuse.rows[0]?.engaged)
      process.stderr.write(`[drill][cleanup] ⚠ selfheal_release_fuse engaged:${JSON.stringify(fuse.rows[0])} —— 走 fuse-clear 审计流,勿在此自动清\n`);
    await c.end();
    process.exit(t && r && !fuse.rows[0]?.engaged ? 0 : 1);
  }

  try {
    if (RELEASE) {
      await runReleaseDrill(c);
    } else if (APPROVE) {
      const rid = approveRepairId();
      if (!rid) abort("--approve 需 <repairId>(取自 --release 段① 输出)");
      await runApproveDrill(c, rid);
    } else {
      await runTransportDrill(c);
    }
    await c.end();
    process.exit(0);
  } catch {
    // 各 drill 已在自身 catch 里 emergencyCleanup(release 段②除外,已明确不自动清)。
    await c.end();
    process.exit(1);
  }
}

await main();

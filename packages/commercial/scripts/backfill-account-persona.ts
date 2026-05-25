/**
 * v3 反关联根治 0073/0074 — One-shot backfill: claude_accounts.persona
 *
 * **目的**:为现有 claude_accounts 行(persona IS NULL)生成稳定的伪装客户端
 * persona,持久化到 DB。运行完后才能跑 0074 migration(SET NOT NULL +
 * shape CHECK),否则 ALTER 会因 NULL 行直接失败。
 *
 * **覆盖范围**:**所有 provider**(claude + codex)。0074 是表级 NOT NULL,
 * codex 行也必须有 persona。运行时只有 claude OAuth 池路径 (upstream.ts
 * makeOAuthPoolUpstream) 读取并注入到 HTTP header — codex 行的 persona 是
 * 哑数据,纯粹满足 DB 约束。
 *
 * **运行(commercial-v3 master / kl-mirror)**:
 *   set -a; . /etc/openclaude/commercial.env; set +a
 *   cd /opt/openclaude/openclaude
 *   npx tsx packages/commercial/scripts/backfill-account-persona.ts [--dry-run]
 *
 *   --dry-run    全流程跑但不 UPDATE,只打印候选数 + 计数汇总
 *
 * **运行策略**:
 *   - 纯本地:randomBytes + UPDATE,无 HTTP,无节流,14 账号 < 1 秒。
 *   - 幂等:`WHERE persona IS NULL` 条件复述在 UPDATE 子句,race 失败方
 *     rowCount=0 视为 skipped_race,不计 failure。
 *   - 不用 generatePersona(seed):persona 持久化到 DB,rerun idempotency
 *     由 SQL guard 提供;额外的 determinism 没有收益且要求 caller 选种子,
 *     反而引入"种子源稳定性"耦合。
 *
 * **日志安全**:
 *   - 只输出 account_id + provider + kind + 错误 detail(脱敏后)
 *   - **禁止**输出 persona 内容明文(虽然 persona 不算 secret,但 UA / OS /
 *     accept_language 组合写日志会方便横向比对账号,降低反关联效果;
 *     只打 kind 汇总而非每行 persona 细节)
 *
 * **退出码**:
 *   - 0 全部成功(或全部 skip,无 hard failure)
 *   - 1 至少一个 UPDATE rowCount=0 而非预期 race(意味着实际 failure)
 *   - 2 fatal(参数错 / DB 不可达 / 未捕获异常)
 */

import { closePool } from "../src/db/index.js";
import { query } from "../src/db/queries.js";
import { generatePersona, assertPersona } from "../src/account-pool/persona.js";

interface Args {
  dryRun: boolean;
}

function safeErrMsg(err: unknown): string {
  // 同 backfill-account-uuid.ts:safeErrMsg。persona backfill 不发 HTTP,
  // 但 PG 错误也可能透 column/row 值;保持同一脱敏标准。
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>")
    .slice(0, 200);
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx packages/commercial/scripts/backfill-account-persona.ts [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { dryRun };
}

// Codex Round 5 WARN: rowCount=0 是良性 race(另一进程或前一次 backfill 已写完
// persona,0074 NOT NULL 仍能满足),不当 failure。真正的 failure 是 try/catch 抓到
// 的异常(SQL 报错 / generatePersona 异常等),用独立 kind 'failed' 区分,
// 只有它进 exit code 1 的计数。
type OutcomeKind = "ok" | "skipped_race" | "failed";

interface Outcome {
  account_id: string;
  provider: string;
  kind: OutcomeKind;
  detail?: string;
}

interface CandidateRow {
  id: string;
  provider: string;
}

async function processOne(row: CandidateRow, dryRun: boolean): Promise<Outcome> {
  const persona = generatePersona();
  // 内部不变量校验:即使 generatePersona() 当前永远返合法 persona,也防御性地
  // assert,避免未来变体池/字段重构悄悄破坏 0074 CHECK。
  assertPersona(persona);

  if (dryRun) {
    return { account_id: row.id, provider: row.provider, kind: "ok", detail: "dry_run" };
  }

  // race-safe: WHERE persona IS NULL 重申过滤,避免覆盖运行时其他写入
  // (本字段无人写,但保持 backfill-account-uuid 的 race-safe 模式一致)。
  const upd = await query(
    `UPDATE claude_accounts
        SET persona = $1::jsonb
      WHERE id = $2::bigint
        AND persona IS NULL`,
    [JSON.stringify(persona), row.id],
  );
  if (upd.rowCount === 0) {
    return {
      account_id: row.id,
      provider: row.provider,
      kind: "skipped_race",
      detail: "row_changed_under_us",
    };
  }
  return { account_id: row.id, provider: row.provider, kind: "ok" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set (source /etc/openclaude/commercial.env first)");
  }

  // 候选集:全 provider,只过滤 persona IS NULL。
  // 不限 status —— banned/disabled 账号也得有 persona,否则 0074 ALTER 失败。
  const res = await query<CandidateRow>(
    `SELECT id::text AS id, provider
       FROM claude_accounts
      WHERE persona IS NULL
      ORDER BY id`,
  );

  if (res.rows.length === 0) {
    console.log("[backfill-persona] no candidates (all rows already have persona); nothing to do.");
    await closePool();
    return;
  }

  console.log(
    `[backfill-persona] processing ${res.rows.length} candidate(s)${
      args.dryRun ? " (DRY-RUN)" : ""
    }`,
  );

  const outcomes: Outcome[] = [];
  for (const row of res.rows) {
    try {
      const o = await processOne(row, args.dryRun);
      outcomes.push(o);
      // 单条日志:account_id + provider + kind(+ detail)。**不**打 persona 内容。
      console.log(
        `  - account=${o.account_id} provider=${o.provider} kind=${o.kind}` +
          (o.detail ? ` (${o.detail})` : ""),
      );
    } catch (err) {
      // generatePersona / assertPersona / SQL 抛错。记 failure 并继续 —— 单账号
      // 失败不阻塞池中其他账号 backfill,跟 uuid backfill 一致语义。
      console.error(
        `  - account=${row.id} provider=${row.provider} kind=FAILED ` +
          `(${safeErrMsg(err)})`,
      );
      outcomes.push({
        account_id: row.id,
        provider: row.provider,
        kind: "failed",
        detail: `error: ${safeErrMsg(err)}`,
      });
    }
  }

  // 汇总
  const tally = new Map<OutcomeKind, number>();
  for (const o of outcomes) {
    tally.set(o.kind, (tally.get(o.kind) ?? 0) + 1);
  }
  console.log("");
  console.log(`[backfill-persona] done. ${outcomes.length} account(s) processed`);
  for (const [k, v] of [...tally.entries()].sort()) {
    console.log(`  ${k}: ${v}`);
  }

  await closePool();

  // skipped_race(rowCount=0)是良性的:意味着 row 已经有 persona,0074 NOT NULL
  // 不会因此卡;只有 'failed'(try/catch 抓到的异常)进 exit 1。
  const failed = outcomes.filter((o) => o.kind === "failed").length;
  if (failed > 0) {
    console.error(
      `[backfill-persona] ${failed} account(s) hit hard errors during backfill — ` +
        `review log + retry (0074 ALTER will fail until those rows have persona)`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[backfill-persona] FATAL ${safeErrMsg(err)}`);
  process.exit(2);
});

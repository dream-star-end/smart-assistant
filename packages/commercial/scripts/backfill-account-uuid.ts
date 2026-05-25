/**
 * Phase 6 — One-shot backfill: claude_accounts.account_uuid (0070 migration).
 *
 * **目的**:把 `provider='claude' AND status='active' AND account_uuid IS NULL`
 * 的现存账号回填真 Anthropic OAuth account UUID(`GET /api/oauth/profile`
 * → `profile.account.uuid`),让 Phase 6 hook 在 `fail_closed` 模式下能选中。
 *
 * **新建账号**:本脚本只回填**存量**;新建 claude 账号的 OAuth login flow
 * 自动写 uuid 留到 Phase 6.5。Phase 6 稳态下新加账号必须显式跑本脚本
 * `--canary <id>` 才会被 scheduler 选中(见 plan §3.2 SOP)。
 *
 * **运行(commercial-v3 master)**:
 *   set -a; . /etc/openclaude/commercial.env; set +a
 *   cd /opt/openclaude/openclaude
 *   npx tsx packages/commercial/scripts/backfill-account-uuid.ts \
 *     [--canary <account_id>] [--dry-run]
 *
 *   --canary <id>   只处理该单一账号(其它跳过),用于 deploy 1 上线后验证
 *   --dry-run       全流程跑但不 UPDATE,仅打印应写入的统计
 *
 * **运行策略**:
 *   - 顺序跑(不并发),每次请求间 sleep 3000ms,避免触发 Anthropic 风控
 *   - HTTP 走账号专属 egress(`getDispatcherForAccount`,与 chat 路径同一出口),
 *     维持"账号出口稳定"的现有设计
 *   - token 过期 / 临近过期 → 先尝试 refresh;refresh 失败不当 hard fail
 *   - HTTP 4xx/5xx 仅 log + 跳过,不抛(账号坏不应阻塞回填池里其它账号)
 *   - 幂等:已有 account_uuid 的账号在初始 SELECT 就被过滤,重跑安全
 *
 * **日志安全**(plan §2.2):
 *   - 只输出 account_id、HTTP status、错误类别(token_expired / http_4xx /
 *     http_5xx / bad_shape / network)、计数
 *   - **禁止**输出 token、refresh、profile body、email、uuid 明文 ——
 *     uuid 写入 DB 是必要持久化,但日志里不复述
 *
 * **退出码**:
 *   - 0 全部成功(或全部 skip,无失败)
 *   - 1 至少一个账号失败(failed > 0);其他账号已尽力处理,人工 follow up
 *   - 2 fatal(参数错 / DB 不可达 / 未捕获异常)
 */

import { Buffer } from "node:buffer";

import { closePool } from "../src/db/index.js";
import { query } from "../src/db/queries.js";
import {
  getTokenForUse,
  type AccountToken,
} from "../src/account-pool/store.js";
import { getDispatcherForAccount } from "../src/account-pool/egressDispatcher.js";
import {
  refreshAccountToken,
  shouldRefresh,
  DEFAULT_REFRESH_SKEW_MS,
} from "../src/account-pool/refresh.js";
import {
  fetchAnthropicAccountUuid,
  safeErrMsg,
} from "../src/account-pool/anthropicProfile.js";

// 节流间隔:plan §2.2 1 req / 3 s。改成更激进(如 1/1s)前需评估 Anthropic 端
// 风控阈值;保守值给 ops 留余量。
const THROTTLE_MS = 3_000;

interface Args {
  canary: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let canary: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--canary") {
      const next = argv[i + 1];
      if (!next) throw new Error("--canary requires <account_id>");
      if (!/^[1-9][0-9]{0,19}$/.test(next)) {
        throw new Error(`invalid --canary value: ${next}`);
      }
      canary = next;
      i += 1;
    } else if (a.startsWith("--canary=")) {
      const v = a.slice("--canary=".length);
      if (!/^[1-9][0-9]{0,19}$/.test(v)) throw new Error(`invalid --canary value: ${v}`);
      canary = v;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx packages/commercial/scripts/backfill-account-uuid.ts " +
          "[--canary <account_id>] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { canary, dryRun };
}

type OutcomeKind =
  | "ok"
  | "skipped_no_token"
  | "skipped_refresh_failed"
  | "skipped_token_invalid"
  | "skipped_http_4xx"
  | "skipped_http_5xx"
  | "skipped_network"
  | "skipped_bad_shape";

interface Outcome {
  account_id: string;
  kind: OutcomeKind;
  status?: number;
  detail?: string;
}

interface CandidateRow {
  id: string;
}

function zero(buf: Buffer | null): void {
  if (!buf) return;
  try {
    buf.fill(0);
  } catch {
    /* ignore */
  }
}

/**
 * 把 helper `FetchAccountUuidResult` 的 kind 映射到本脚本的 outcome 枚举。
 * 历史上 OutcomeKind 用 `skipped_*` 前缀,helper 用裸 kind;映射在此处一次性完成。
 * `token_invalid` 是 helper 新分出的细分(原归入 4xx),outcome 同步加 `skipped_token_invalid`
 * 让 ops 一眼区分"admin 输入的 token 坏"和"Anthropic 拒绝(如 429)"。
 */
function mapHelperKindToOutcome(
  k: Exclude<import("../src/account-pool/anthropicProfile.js").FetchAccountUuidResult["kind"], "ok">,
): Exclude<OutcomeKind, "ok" | "skipped_no_token" | "skipped_refresh_failed"> {
  switch (k) {
    case "token_invalid": return "skipped_token_invalid";
    case "http_4xx":      return "skipped_http_4xx";
    case "http_5xx":      return "skipped_http_5xx";
    case "network":       return "skipped_network";
    case "bad_shape":     return "skipped_bad_shape";
  }
}

/**
 * 调 helper 拿 uuid;路径专属 dispatcher 由本脚本构造(账号已存在 → 用真 accountId)。
 *
 * 注意 backfill 不开 `retryOnTransient`:存量回填是无人值守,已有 3s 节流,
 * 单次失败继续下一个就行;admin 路径才需要 retry。
 */
async function fetchAccountUuid(tok: AccountToken) {
  // 账号专属出口(与 chat 路径同),失败 fail-soft 回默认出口(不抛)
  const dispatcher = await getDispatcherForAccount(
    tok.id,
    tok.egress_proxy,
    tok.egress_target,
  );
  const accessToken = tok.token.toString("utf8");
  return fetchAnthropicAccountUuid(accessToken, dispatcher);
}

/**
 * 单账号回填:
 *   1. getTokenForUse → 解密 access_token
 *   2. token 即将过期(skew=DEFAULT_REFRESH_SKEW_MS)→ refreshAccountToken;失败 → skip
 *   3. fetch profile → 取 uuid
 *   4. dry-run skip / 否则 UPDATE
 *   5. 始终零化 token / refresh Buffer
 */
async function processOne(accountId: string, dryRun: boolean): Promise<Outcome> {
  let tok: AccountToken | null = null;
  try {
    tok = await getTokenForUse(accountId);
    if (!tok) {
      // 账号在 SELECT 后被删 / 不可用 — 不当 hard error
      return { account_id: accountId, kind: "skipped_no_token", detail: "vanished" };
    }

    // 若 token 即将到期(或已过期)→ 主动 refresh;失败不 hard fail,继续后续账号
    if (tok.expires_at && shouldRefresh(tok.expires_at, new Date(), DEFAULT_REFRESH_SKEW_MS)) {
      try {
        // 复用脚本进程的默认 refresh path(无 health 注入 — 不在 refresh 失败时
        // 把账号 disable,因为可能只是网络抖动;真坏 chat 路径会自然 disable)。
        const r = await refreshAccountToken(accountId);
        // 替换 token / refresh,旧的零化
        zero(tok.token);
        zero(tok.refresh);
        tok = {
          ...tok,
          token: r.token,
          refresh: r.refresh,
          expires_at: r.expires_at,
        };
      } catch (err) {
        return {
          account_id: accountId,
          kind: "skipped_refresh_failed",
          detail: safeErrMsg(err),
        };
      }
    }

    const r = await fetchAccountUuid(tok);
    if (r.kind !== "ok") {
      const out: Outcome = { account_id: accountId, kind: mapHelperKindToOutcome(r.kind) };
      if (r.status !== undefined) out.status = r.status;
      if (r.detail) out.detail = r.detail;
      return out;
    }

    if (dryRun) {
      return { account_id: accountId, kind: "ok", detail: "dry_run" };
    }

    // UPDATE 直接写 SQL —— store.updateAccount 没 expose account_uuid 列
    // (是新 0070 加的,不进 UpdateAccountPatch 是好事:权威源就这一个脚本)。
    // WHERE 子句重申过滤条件,避免 race condition 下覆盖其他 status 的行。
    const upd = await query(
      `UPDATE claude_accounts
          SET account_uuid = $1::uuid
        WHERE id = $2::bigint
          AND provider = 'claude'
          AND status = 'active'
          AND account_uuid IS NULL`,
      [r.uuid, accountId],
    );
    if (upd.rowCount === 0) {
      // 行在 SELECT 和 UPDATE 之间被其他进程修改(或被 admin 新建路径抢先回填)
      // —— 当 skip 不当失败
      return {
        account_id: accountId,
        kind: "skipped_bad_shape",
        detail: "row_changed_under_us",
      };
    }
    return { account_id: accountId, kind: "ok" };
  } finally {
    if (tok) {
      zero(tok.token);
      zero(tok.refresh);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set (source /etc/openclaude/commercial.env first)");
  }

  // 候选集:统一过滤 provider='claude' + status='active' + account_uuid IS NULL,
  // --canary 只是在此基础上**额外**限定 id —— 不替换上述任一条件。
  // (plan §5.5.2:错 provider / inactive 的 --canary id 返 0 行 candidates,
  //  脚本打印 "no candidates" 退出,不发 HTTP。)
  const sqlBase = `SELECT id::text AS id
                     FROM claude_accounts
                    WHERE provider = 'claude'
                      AND status = 'active'
                      AND account_uuid IS NULL`;
  const res = args.canary !== null
    ? await query<CandidateRow>(`${sqlBase} AND id = $1::bigint ORDER BY id`, [args.canary])
    : await query<CandidateRow>(`${sqlBase} ORDER BY id`);

  if (res.rows.length === 0) {
    console.log(
      `[backfill] no candidates (provider='claude' active uuid-null${
        args.canary !== null ? ` AND id=${args.canary}` : ""
      }); nothing to do.`,
    );
    await closePool();
    return;
  }

  console.log(
    `[backfill] processing ${res.rows.length} candidate(s)${args.dryRun ? " (DRY-RUN)" : ""}` +
      (args.canary !== null ? ` canary=${args.canary}` : ""),
  );

  const outcomes: Outcome[] = [];
  for (let i = 0; i < res.rows.length; i += 1) {
    const row = res.rows[i];
    const o = await processOne(row.id, args.dryRun);
    outcomes.push(o);
    // 单条日志:account_id + kind(+ HTTP status if any + 简短 detail)。不打 uuid。
    console.log(
      `  - account=${o.account_id} kind=${o.kind}` +
        (o.status !== undefined ? ` status=${o.status}` : "") +
        (o.detail ? ` (${o.detail})` : ""),
    );
    // 节流:除最后一条外都 sleep(避免 burst)
    if (i < res.rows.length - 1) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  // 汇总
  const tally = new Map<OutcomeKind, number>();
  for (const o of outcomes) {
    tally.set(o.kind, (tally.get(o.kind) ?? 0) + 1);
  }
  console.log("");
  console.log(`[backfill] done. ${outcomes.length} account(s) processed`);
  for (const [k, v] of [...tally.entries()].sort()) {
    console.log(`  ${k}: ${v}`);
  }

  await closePool();

  const failed = outcomes.filter((o) => o.kind !== "ok").length;
  if (failed > 0) {
    console.error(
      `[backfill] ${failed} account(s) did NOT receive a uuid — review log + retry`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // 第二参数原本是 raw err(Node 会 inspect 出 stack + cause),含 UUID/email 风险。
  // 用 safeErrMsg 脱敏 + drop stack。FATAL 的根因排查依赖 kind/category,不靠
  // stack —— 真要看 stack 走 journalctl 看 stderr inspect 输出更稳。
  console.error(`[backfill] FATAL ${safeErrMsg(err)}`);
  process.exit(2);
});

/**
 * 用户激活/留存的自动 inbox 触达(R1..R6)。
 *
 * ## 触发规则
 *   R1 — 注册 +0..1h:欢迎 + Chat 与 Agent 模式介绍
 *   R2 — 注册 +30min..24h 且未验邮箱:邮箱验证补救
 *   R3 — 注册 +1h..24h 且 0 条 usage_records:5 个示例 prompt(Chat vs Agent 对比)
 *   R4 — 注册 +24h..7d 且仍未验邮箱:最后一次验证提醒
 *   R5 — 订单 status='expired' updated_at +1h..7d 且用户从未付过任何单:支付帮助召回
 *   R6 — 注册 +6h..7d,有 chat usage 但从未 agent usage:Agent 模式 upsell
 *
 * ## 幂等
 * 每条 inbox_messages.body_md 末尾带 marker `<!-- ob:Rk -->`。SQL `NOT EXISTS`
 * 排除已发用户,因此同用户同规则永远只发一次。marker 不带 user_id —— SQL 已在
 * `m.user_id = u.id` 上索引过滤,marker 只需区分规则。
 *
 * ## 跨进程并发
 * 整个 tick 套 `pg_try_advisory_xact_lock(0x4F4E_424F, 0x4152_4400)`(ASCII 'ONBO'/'ARD\\0')。
 * 拿不到 lock = 另一进程在跑 = 当前 tick 直接 no-op,事务结束自动释放。
 * 双 int4 形态因为单 int8 形态 0x4F4E424F41524400 超出 JS Number.MAX_SAFE_INTEGER。
 *
 * ## 失败语义
 * 整 tick 一个事务,任意 rule 失败 → 全部回滚,60s 后下次 tick 重试。
 * 我们的 SQL 都是简单参数化 INSERT-SELECT,失败概率主要是 PG 连接/超时,
 * 整体回滚比 SAVEPOINT-per-rule 更干净(避免部分插入留下半套消息)。
 *
 * ## 开关
 *   - `onboarding_enabled` = false → tick 立即返回 ran=false
 *   - `onboarding_dry_run` = true → 走完整 INSERT 然后整事务 ROLLBACK,
 *     仍能从 RETURNING 拿到"会写入多少条",但实际不留下任何行
 *
 * ## 回滚
 *   - 关 enabled 即停止
 *   - 物理清空: `DELETE FROM inbox_messages WHERE body_md LIKE '%<!-- ob:R%';`
 *
 * ## 关于 `created_by`
 * inbox_messages.created_by 是 NOT NULL 的 user_id。我们用 `MIN(id) FROM users WHERE role='admin' AND status='active'`
 * 作为 system 发件人,**每次 tick 重新解析**(不缓存,这样 admin 被禁/删除/新增时下次 tick 自然反映)。
 * 集群无 active admin → tick 返回 ran=false skipReason='no-admin'。
 */

import type { PoolClient } from "pg";
import { getSystemSetting } from "../admin/systemSettings.js";
import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";

// ─── 常量 ────────────────────────────────────────────────────────────

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;

// 'ONBO' / 'ARD\0' 双 int4 advisory lock key
const LOCK_KEY_HI = 0x4f4e_424f;
const LOCK_KEY_LO = 0x4152_4400;

// ─── 文案 ────────────────────────────────────────────────────────────
// 末尾的 marker 由 buildBody() 自动追加,不要手写在这里。

const R1_TITLE = "欢迎使用 — Chat 与 Agent 两种模式怎么选";
const R1_BODY = `欢迎来到 ClaudeAI Chat。

你这里有两种模式:

- **Chat 模式**(已默认开启,按 token 计费)— 适合问问题、解释代码、写代码片段、文档总结、翻译。和 ChatGPT 类似。
- **Agent 模式**(¥29/30 天订阅)— 你会拿到一个独立 Linux 容器,Claude 可以**真在里面**写文件、装依赖、跑命令、跑测试。容器订阅期内保留,订阅过期后再保 30 天才 GC。

不知道现在该怎么开始?试这两条:

- Chat 试一下:\`帮我看看这段代码为什么会无限循环 [贴代码]\`
- Agent 试一下(开通后):\`新建一个 Vite + React 项目,做个待办列表,本地起服务并把 URL 给我\`
`;

const R2_TITLE = "邮箱还没验证 — 这里是重发链接";
const R2_BODY = `我们注意到你还没完成邮箱验证。

验证邮箱的目的:

- 找回密码、绑定支付、收到余额提醒,都需要邮箱
- 没验证不会限制你试用 Chat 模式,但充值/订阅会要求先验证

如果没收到邮件,**先看垃圾箱/促销文件夹**,我们的发件域名是 \`claudeai.chat\`。
仍然没有 → 在「设置 → 账号」里点「重发验证邮件」,每 60 秒可以重发一次。
`;

const R3_TITLE = "试试这 5 个示例 prompt";
const R3_BODY = `还没动手?这里有 5 个能立刻试的 prompt。

**Chat 模式(直接发就行,默认就在用):**

1. \`解释下这段 SQL 在做什么:[粘贴 SQL]\`
2. \`我想学系统设计,推荐 5 本入门书并简短说每本侧重\`

**Agent 模式(需先订阅 ¥29/30 天,会给你一个独立 Linux 容器):**

3. \`创建一个最小 Node.js 项目,写一个 add(a,b) 函数,加测试,跑通测试并贴输出\`
4. \`新建一个 Python FastAPI 项目,加一个 /healthz 路由,写好测试,本地跑通把 curl 输出贴出来\`
5. \`我把一份 CSV 上传到容器了,按城市分组统计,生成柱状图保存成 chart.png\`

第 3-5 条 Chat 给不了 — 它没有你的文件系统、没法执行命令、没法把结果留下来。
这就是 Agent 模式存在的理由。
`;

const R4_TITLE = "邮箱验证最后一次提醒";
const R4_BODY = `这是关于邮箱验证的最后一次提醒。

你的账号已经创建超过 24 小时,但邮箱还没验证。账号本身仍可用,只是:

- 没验证 → 充值/订阅无法走通
- 没验证 → 找回密码不可用,账号丢失就找不回来了

如果一直没收到邮件,可能是邮箱服务商把我们标黑了。可以:

1. 检查垃圾箱、促销邮件、广告标签
2. 把 \`@claudeai.chat\` 加白名单,然后在「设置 → 账号」重发
3. 实在不行,把这条问题贴到「反馈」入口,我们人工核对

之后这条提醒不再发。
`;

const R5_TITLE = "你刚才下单没完成 — 需要支付帮助吗?";
const R5_BODY = `我们注意到你刚才创建了一笔订单,但订单已经过期没有完成支付。

如果是因为:

- 二维码扫不出来 / 跳转白屏 → 试一下换个浏览器或手机微信直接扫
- 不确定金额 / 套餐 → 现在的最低门槛是 ¥10,先充小额试用没压力
- 担心安全 → 我们走「虎皮椒」聚合支付,微信/支付宝官方通道,款项原路返回

需要的话,你可以直接回到「充值」页重新下单,**没扣过钱**,过期单不影响。
如果还有问题,在「反馈」入口告诉我们,会人工跟。
`;

const R6_TITLE = "你只用了 Chat 模式 — Agent 模式才是这里的核心";
const R6_BODY = `注意到你已经用了 Chat 模式发了几条消息了。你试过 Agent 模式吗?

简单对比:

| 任务 | Chat | Agent |
|------|------|-------|
| 解释一段代码、回答问题、写代码片段 | ✅ | ✅ |
| 把代码真写到文件、装依赖、跑起来看输出 | ❌ | ✅ |
| 跑测试 → 看报错 → 改代码 → 再跑(循环到通过) | ❌ | ✅ |
| 操作一个属于你的 Linux 容器 | ❌ | ✅(订阅期内 + 到期后 30 天 GC) |

Chat 给你的是文本建议,Agent 才能在你的真实容器里执行/保存/验证。
¥29/30 天,在「订阅」入口开通。
`;

// ─── Rule 规约 ──────────────────────────────────────────────────────

interface UserRule {
  /** R1..R4, R6 这类:从 users 表筛 user_id。 */
  kind: "user";
  id: string;
  marker: string;
  title: string;
  level: "info" | "notice" | "promo" | "warning";
  body: string;
  /** SQL fragment,引用别名 `u`(users)。仅常量字符串(无用户输入),拼接安全。 */
  whereClause: string;
}

interface OrderRule {
  /** R5:从 orders 表筛 user_id(DISTINCT),outer NOT EXISTS 用 marker 防重发。 */
  kind: "order";
  id: string;
  marker: string;
  title: string;
  level: "info" | "notice" | "promo" | "warning";
  body: string;
  whereClause: string; // 引用别名 `o`(orders)
}

type Rule = UserRule | OrderRule;

const RULES: readonly Rule[] = [
  {
    kind: "user",
    id: "R1",
    marker: "<!-- ob:R1 -->",
    title: R1_TITLE,
    level: "info",
    body: R1_BODY,
    whereClause: `u.created_at > now() - interval '1 hour'`,
  },
  {
    kind: "user",
    id: "R2",
    marker: "<!-- ob:R2 -->",
    title: R2_TITLE,
    level: "notice",
    body: R2_BODY,
    whereClause: `u.email_verified = false
       AND u.created_at < now() - interval '30 minutes'
       AND u.created_at > now() - interval '24 hours'`,
  },
  {
    kind: "user",
    id: "R3",
    marker: "<!-- ob:R3 -->",
    title: R3_TITLE,
    level: "info",
    body: R3_BODY,
    whereClause: `u.created_at < now() - interval '1 hour'
       AND u.created_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM usage_records ur WHERE ur.user_id = u.id)`,
  },
  {
    kind: "user",
    id: "R4",
    marker: "<!-- ob:R4 -->",
    title: R4_TITLE,
    level: "warning",
    body: R4_BODY,
    whereClause: `u.email_verified = false
       AND u.created_at < now() - interval '24 hours'
       AND u.created_at > now() - interval '7 days'`,
  },
  {
    kind: "order",
    id: "R5",
    marker: "<!-- ob:R5 -->",
    title: R5_TITLE,
    level: "notice",
    body: R5_BODY,
    whereClause: `o.status = 'expired'
       AND o.updated_at < now() - interval '1 hour'
       AND o.updated_at > now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM orders op
          WHERE op.user_id = o.user_id AND op.status = 'paid'
       )`,
  },
  {
    kind: "user",
    id: "R6",
    marker: "<!-- ob:R6 -->",
    title: R6_TITLE,
    level: "promo",
    body: R6_BODY,
    whereClause: `u.created_at < now() - interval '6 hours'
       AND u.created_at > now() - interval '7 days'
       AND EXISTS (
         SELECT 1 FROM usage_records ur1
          WHERE ur1.user_id = u.id AND ur1.mode = 'chat'
       )
       AND NOT EXISTS (
         SELECT 1 FROM usage_records ur2
          WHERE ur2.user_id = u.id AND ur2.mode = 'agent'
       )`,
  },
] as const;

function buildBody(rule: Rule): string {
  // marker 放末尾,用户看到的内容到此为止;listMyInbox 不渲染 HTML 注释。
  return `${rule.body.trimEnd()}\n\n${rule.marker}`;
}

// ─── 单条 rule 执行 ──────────────────────────────────────────────────

async function runUserRule(
  client: PoolClient,
  rule: UserRule,
  adminId: string,
): Promise<number> {
  // role='user':admin 自己不收 onboarding(他们是发件人,且不需要引导/转化文案)
  const sql = `
    INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
    SELECT 'user', u.id, $1, $2, $3, $4::bigint
      FROM users u
     WHERE u.status = 'active'
       AND u.role = 'user'
       AND ${rule.whereClause}
       AND NOT EXISTS (
         SELECT 1 FROM inbox_messages m
          WHERE m.user_id = u.id
            AND m.body_md LIKE $5
       )
    RETURNING id
  `;
  const r = await client.query(sql, [
    rule.title,
    buildBody(rule),
    rule.level,
    adminId,
    `%${rule.marker}%`,
  ]);
  return r.rowCount ?? 0;
}

async function runOrderRule(
  client: PoolClient,
  rule: OrderRule,
  adminId: string,
): Promise<number> {
  // 同用户多个 expired 单只发一条:DISTINCT user_id,然后用 marker NOT EXISTS 防跨 tick 重发。
  const sql = `
    INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
    SELECT 'user', x.user_id, $1, $2, $3, $4::bigint
      FROM (
        SELECT DISTINCT o.user_id
          FROM orders o
          JOIN users u ON u.id = o.user_id
                       AND u.status = 'active'
                       AND u.role = 'user'
         WHERE ${rule.whereClause}
      ) x
     WHERE NOT EXISTS (
       SELECT 1 FROM inbox_messages m
        WHERE m.user_id = x.user_id
          AND m.body_md LIKE $5
     )
    RETURNING id
  `;
  const r = await client.query(sql, [
    rule.title,
    buildBody(rule),
    rule.level,
    adminId,
    `%${rule.marker}%`,
  ]);
  return r.rowCount ?? 0;
}

async function runRule(
  client: PoolClient,
  rule: Rule,
  adminId: string,
): Promise<number> {
  if (rule.kind === "user") return runUserRule(client, rule, adminId);
  return runOrderRule(client, rule, adminId);
}

// ─── system 发件人 ──────────────────────────────────────────────────

/** 取最小的 admin user id 当 system 发件人。无 admin → null,scheduler 退化 no-op。 */
async function resolveSystemAdminId(): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}

// ─── tick ────────────────────────────────────────────────────────────

export interface RuleResult {
  rule: string;
  inserted: number;
}

export interface TickResult {
  /** false → 被开关关闭、无 admin 发件人、advisory lock 没拿到、或异常被吞。 */
  ran: boolean;
  /** dry-run 模式:走完 INSERT 但事务回滚,results 仍反映"会写入"的条数。 */
  dryRun: boolean;
  results: RuleResult[];
  /** ran=false 时给出原因,便于运维查日志。 */
  skipReason?: "disabled" | "no-admin" | "lock-busy" | "error";
  error?: unknown;
}

export interface RunTickOptions {
  /** 测试用注入。生产省略。 */
  enabled?: boolean;
  dryRun?: boolean;
  systemAdminId?: string | null;
}

/**
 * 跑一次 onboarding tick。生产路径走 system_settings,测试可显式注入。
 *
 * 失败语义:tick 内任意 rule 失败 → 整个事务回滚 → 返回 ran=false + skipReason='error'。
 * 调度器侧只记 warn,不抛,下一 tick 自动重试。
 */
export async function runOnboardingTick(opts: RunTickOptions = {}): Promise<TickResult> {
  const enabled = opts.enabled ?? (await getSystemSetting("onboarding_enabled")).value;
  if (!enabled) {
    return { ran: false, dryRun: false, results: [], skipReason: "disabled" };
  }
  const dryRun =
    opts.dryRun ?? (await getSystemSetting("onboarding_dry_run")).value;

  const adminId =
    opts.systemAdminId !== undefined ? opts.systemAdminId : await resolveSystemAdminId();
  if (!adminId) {
    return { ran: false, dryRun, results: [], skipReason: "no-admin" };
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS ok",
      [LOCK_KEY_HI, LOCK_KEY_LO],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { ran: false, dryRun, results: [], skipReason: "lock-busy" };
    }

    const results: RuleResult[] = [];
    try {
      for (const rule of RULES) {
        const inserted = await runRule(client, rule, adminId);
        results.push({ rule: rule.id, inserted });
      }
    } catch (err) {
      await client.query("ROLLBACK");
      return { ran: false, dryRun, results: [], skipReason: "error", error: err };
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    return { ran: true, dryRun, results };
  } finally {
    client.release();
  }
}

// ─── scheduler ──────────────────────────────────────────────────────

export interface OnboardingSchedulerHandle {
  stop(): void;
  /** 测试用:立即跑一次 tick,返回 TickResult。 */
  runNow(): Promise<TickResult>;
}

export interface OnboardingSchedulerOptions {
  intervalMs?: number;
  /** 默认 false:setInterval 第一发要等 intervalMs 后,避免 boot 风暴。 */
  runOnStart?: boolean;
  /** 默认 console.warn,可注入 logger。 */
  onError?: (err: unknown) => void;
}

function defaultOnError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("[inbox/onboarding] tick failed:", err);
}

export function startOnboardingScheduler(
  opts: OnboardingSchedulerOptions = {},
): OnboardingSchedulerHandle {
  const interval = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const onError = opts.onError ?? defaultOnError;
  const runOnStart = opts.runOnStart ?? false;
  let stopped = false;
  let inflight = false;

  async function tickOnce(): Promise<TickResult> {
    if (inflight) {
      return { ran: false, dryRun: false, results: [], skipReason: "lock-busy" };
    }
    inflight = true;
    try {
      const r = await runOnboardingTick();
      if (r.skipReason === "error") onError(r.error);
      return r;
    } catch (err) {
      onError(err);
      return { ran: false, dryRun: false, results: [], skipReason: "error", error: err };
    } finally {
      inflight = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void tickOnce();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  if (runOnStart) void tickOnce();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: tickOnce,
  };
}

// ─── 测试钩子 ────────────────────────────────────────────────────────

/** 测试用:暴露规则元数据(只读)。 */
export const _internal = { RULES, LOCK_KEY_HI, LOCK_KEY_LO } as const;

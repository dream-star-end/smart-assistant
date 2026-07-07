/**
 * 企业版(P3.1 三期 · 批次 H) — org 低水位预警(§17.2)。
 *
 * master 侧 sweeper 第三域(并入 billing/subscriptionRolloverSweeper 同 5min tick,不造新 timer):
 * 扫 active org 的总可用(org 钱包 credits + 有效期内池 period_credits),低于阈值且未预警
 * (low_balance_notified_at IS NULL)→ 给 owner(uq_org_owner 行)发**站内信 + 邮件**(best-effort)
 * → 打 low_balance_notified_at 去重。充值/续费/加席/正向调额 fulfill 时清戳,允许再次触发。
 *
 * 阈值 = max(2000, 池满值×10%);池满值 = seats × 每席积分(monthly_credits);无订阅 → 池满值 0
 * → 阈值 2000(钱包型/超管代建 org 的下界)。
 *
 * **通知面而非运维告警**:走用户站内信 + 邮件(createInboxMessage / mailer),**不走 wecom
 * 运维告警通道**(那是 ops 面;§17.2 裁决)。
 *
 * **fail-open 铁律**:预警本身与计费主流程完全解耦,任何一步失败(邮件/站内信/单个 org)都
 * 不得中断 sweeper,更不影响扣费(sweeper 域内独立 try/catch,见 subscriptionRolloverSweeper)。
 *
 * **mailer 取舍**:sweeper 无 deps 注入形态(直接 import rolloverExpired* 函数,内部 getPool),
 * index.ts:3215 启动时不传 deps 且本批次不改 index.ts(文件所有权)。故本域**自建 mailer**——
 * 从 env(RESEND_API_KEY / MAIL_FROM)构造一次并 memoize,与 index.ts:1700-1704 同款选择逻辑
 * (env 已配 → Resend,否则 stub 打 stdout)。已知小重复,登记债:后续若 index.ts 改为给 sweeper
 * 注入 deps.mailer,把这里换成注入即可(测试已用 deps.mailer 注入,切换零成本)。
 */

import { query } from "../db/queries.js";
import { createInboxMessage } from "../inbox/inbox.js";
import { stubMailer, createResendMailer, type Mailer } from "../auth/mail.js";

/** memoize 的自建 mailer(与 index.ts 同款 env 选择)。 */
let cachedMailer: Mailer | null = null;
function envMailer(): Mailer {
  if (cachedMailer) return cachedMailer;
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const mailFrom = process.env.MAIL_FROM?.trim() || "auth@claudeai.chat";
  cachedMailer = resendKey ? createResendMailer({ apiKey: resendKey, from: mailFrom }) : stubMailer;
  return cachedMailer;
}

export interface SweepOrgLowBalanceDeps {
  /** 覆盖 mailer(测试注入;缺省从 env 构造)。 */
  mailer?: Mailer;
  /** 覆盖站内信写入(测试注入;缺省 createInboxMessage)。 */
  sendInbox?: typeof createInboxMessage;
  /** 每批扫描上限(默认 500;低水位 org 稀有,单 tick 内 drain 完)。 */
  batchLimit?: number;
}

interface LowOrgRow {
  org_id: string;
  org_name: string;
  spendable: string;
  owner_id: string;
  owner_email: string;
  owner_name: string | null;
}

/**
 * 扫一批低于阈值且未预警的 active org,逐个通知 owner + 打戳。返回本次预警的 org 数。
 *
 * 口径(SQL 内一次算阈值,只取真正低于阈值的行,避免拉全表):
 *   spendable = orgs.credits + COALESCE(有效期内池, 0)
 *   threshold = GREATEST(2000, seats × monthly_credits / 10)   -- 无订阅 → 2000
 *   命中 = status='active' AND low_balance_notified_at IS NULL AND spendable < threshold
 *
 * 通知顺序(§17.2:站内信 + 邮件 → 打戳):
 *   1) createInboxMessage(owner,warning)—— best-effort(可靠 DB 写)
 *   2) mailer.send(owner_email)          —— best-effort(可失败)
 *   3) UPDATE low_balance_notified_at = NOW()(WHERE 仍 IS NULL,幂等)
 * 单个 org 处理抛错被 try/catch 吞(fail-open),不影响其它 org / 不影响计费。
 */
export async function sweepOrgLowBalance(deps: SweepOrgLowBalanceDeps = {}): Promise<number> {
  const mailer = deps.mailer ?? envMailer();
  const sendInbox = deps.sendInbox ?? createInboxMessage;
  const batch = Math.min(Math.max(deps.batchLimit ?? 500, 1), 5000);

  let alerted = 0;
  for (;;) {
    const r = await query<LowOrgRow>(
      `SELECT o.id::text AS org_id, o.name AS org_name,
              (o.credits + COALESCE(os.period_credits, 0))::text AS spendable,
              ow.user_id::text AS owner_id, u.email AS owner_email, u.display_name AS owner_name
         FROM orgs o
         LEFT JOIN org_subscriptions os
           ON os.org_id = o.id AND os.status = 'active' AND os.period_end > NOW()
         LEFT JOIN subscription_plans sp
           ON sp.code = os.plan_code AND sp.scope = 'org'
         JOIN org_memberships ow
           ON ow.org_id = o.id AND ow.org_role = 'owner'
         JOIN users u ON u.id = ow.user_id
        WHERE o.status = 'active'
          AND o.low_balance_notified_at IS NULL
          AND (o.credits + COALESCE(os.period_credits, 0)) <
              GREATEST(2000::bigint,
                       (COALESCE(os.seats, 0)::bigint * COALESCE(sp.monthly_credits, 0)) / 10)
        ORDER BY o.id
        LIMIT $1`,
      [batch],
    );
    if (r.rows.length === 0) break;

    for (const row of r.rows) {
      try {
        await notifyOne(row, mailer, sendInbox);
        alerted += 1;
      } catch (err) {
        // fail-open:单 org 通知失败不打戳(下 tick 可重试)、不中断其它 org。
        // eslint-disable-next-line no-console
        console.warn(`[orgLowBalance] notify failed for org ${row.org_id}:`, err);
      }
    }
    if (r.rows.length < batch) break; // 不足一批 → 已排空
  }
  return alerted;
}

async function notifyOne(
  row: LowOrgRow,
  mailer: Mailer,
  sendInbox: typeof createInboxMessage,
): Promise<void> {
  const balance = row.spendable;
  const title = `组织「${row.org_name}」余额偏低`;
  const bodyMd =
    `你的组织「${row.org_name}」当前可用余额为 **${balance}** 积分(组织钱包 + 有效期内池),已低于预警阈值。\n\n` +
    `为避免成员使用受影响,请及时在「组织中心 → 计费」为组织充值或续费订阅。`;

  // 1) 站内信(可靠 DB 写)。created_by = owner 自身(无平台操作者,同邀请流用 actor id 语义)。
  await sendInbox(row.owner_id, {
    audience: "user",
    user_id: row.owner_id,
    title,
    body_md: bodyMd,
    level: "warning",
  });

  // 2) 邮件(best-effort;失败不阻断打戳——站内信已送达为主渠道)。
  try {
    await mailer.send({
      to: row.owner_email,
      subject: `[OpenClaude] 组织「${row.org_name}」余额偏低`,
      text:
        `${row.owner_name ? row.owner_name + ",\n\n" : "你好,\n\n"}` +
        `你的组织「${row.org_name}」当前可用余额为 ${balance} 积分(组织钱包 + 有效期内池),已低于预警阈值。\n\n` +
        `为避免成员使用受影响,请及时登录 OpenClaude,在「组织中心 → 计费」为组织充值或续费订阅。\n`,
    });
  } catch {
    /* best-effort */
  }

  // 3) 打去重戳(WHERE 仍 IS NULL,幂等;充值/续费/调额时被清空以再次触发)。
  await query(
    `UPDATE orgs SET low_balance_notified_at = NOW()
      WHERE id = $1::bigint AND low_balance_notified_at IS NULL`,
    [row.org_id],
  );
}

#!/usr/bin/env -S npx tsx
/**
 * Ops 脚本: 站内信广播(可选邮件推送)CLI 外壳。
 *
 * 复用 inbox.createInboxMessage 权威链路 —— 同事务写 message + 收件人快照
 * (active + email_verified + 未删),邮件由线上 master 的 inboxEmail worker
 * durable drain(600ms/封,挡 Resend 免费档速率)。本脚本**不自建**任何第二套
 * 群发/发信机制,只是 CLI 触发器;发送进度看 inbox_messages.email_summary。
 *
 * 用法(必须在 kl-mirror 本机、以 v5 环境跑):
 *   env $(grep -v '^#' /etc/openclaude/commercial-v5.env | xargs) \
 *     npx tsx scripts/v5-inbox-broadcast.ts \
 *       --title "标题(=邮件 subject)" --body-file /path/body.md \
 *       (--all | --user <uid>) [--level info|notice|promo|warning] \
 *       [--notify-email] [--admin <uid>] [--yes]
 *
 * 安全阀:
 *   - 不带 --yes = dry-run,只打印标题/正文摘要与目标收件人数,不落库。
 *   - 先用 --user <自己的测试号> 实发彩排(收邮件核对渲染),再 --all 全量。
 *   - created_by 默认 admin uid 1;审计可见,不要写不存在的 uid。
 */
import { readFileSync } from "node:fs";
import { closePool } from "../packages/commercial/src/db/index.js";
import { query } from "../packages/commercial/src/db/queries.js";
import { createInboxMessage } from "../packages/commercial/src/inbox/inbox.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const title = arg("title");
  const bodyFile = arg("body-file");
  const userId = arg("user");
  const audience = has("all") ? "all" : userId ? "user" : null;
  if (!title || !bodyFile || !audience) {
    console.error("必填: --title --body-file 以及 --all 或 --user <uid>(见文件头用法)");
    return 2;
  }
  const body = readFileSync(bodyFile, "utf-8").trim();
  const level = arg("level") ?? "notice";
  const notifyEmail = has("notify-email");
  const adminId = arg("admin") ?? "1";

  // 与 createInboxMessage 的快照谓词一致的预估口径(仅展示;真快照在事务内取)。
  const est =
    audience === "all"
      ? await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM users
            WHERE status='active' AND email_verified=TRUE AND deleted_at IS NULL AND email<>''`,
        )
      : await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM users
            WHERE id=$1::bigint AND status='active' AND email_verified=TRUE AND deleted_at IS NULL AND email<>''`,
          [userId],
        );
  const recipients = est.rows[0].n;

  console.log(`audience=${audience}${userId ? `(uid=${userId})` : ""} level=${level} notify_email=${notifyEmail}`);
  console.log(`title: ${title}`);
  console.log(`body(${body.length} chars) 首 200 字:\n---\n${body.slice(0, 200)}\n---`);
  console.log(`邮件目标收件人(预估): ${recipients}`);

  if (!has("yes")) {
    console.log("\ndry-run(未落库)。确认无误后加 --yes 实发。");
    return 0;
  }

  const r = await createInboxMessage(adminId, {
    audience,
    ...(audience === "user" ? { user_id: userId } : {}),
    title,
    body_md: body,
    level,
    notify_email: notifyEmail,
  });
  console.log(`已创建 message id=${r.id} email_send_status=${r.email_send_status ?? "-"}`);
  console.log(
    `发送进度查询: SELECT email_send_status, email_summary FROM inbox_messages WHERE id=${r.id};`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closePool().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  });

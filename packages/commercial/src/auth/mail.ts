/**
 * T-12 — sendMail 接口 + MVP stub。
 *
 * MVP 不接 SMTP / 第三方邮件服务,只把"已发邮件"的事实和 token URL 打到 stdout。
 * 后续 task(或运维)接入真实 mailer 时,只换实现,接口不变。
 *
 * 安全规约(05-SEC §16):**不得**把验证 token 完整写进通用 console.log;
 * 这里 stub 路径明确标注 `[mail-stub]` 前缀,部署阶段可让日志聚合层 mask 掉。
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** 纯文本正文 */
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Stub mailer:打到 stdout,带 `[mail-stub]` 前缀。
 *
 * 现在用 `process.stdout.write` 而不是 console.log —— 测试可以重定向 stdout
 * 来观察消息(console.log 走 stderr 在 node:test 下被吞)。
 */
export const stubMailer: Mailer = {
  async send(msg: MailMessage): Promise<void> {
    const line = JSON.stringify({
      _kind: "mail-stub",
      to: msg.to,
      subject: msg.subject,
      // 完整 text 也输出 —— 测试需要看到 token URL
      text: msg.text,
      ts: new Date().toISOString(),
    });
    process.stdout.write(`[mail-stub] ${line}\n`);
  },
};

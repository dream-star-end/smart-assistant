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

/**
 * Resend mailer:走 https://api.resend.com/emails 的 REST API,直接 fetch,
 * 不引第三方 SDK。
 *
 * 失败时抛 Error,register/forgot-password 流程会捕获并把 verify_email_sent 置 false,
 * 用户可走 resend-verification 重发。
 */
export interface ResendMailerOptions {
  apiKey: string;
  /** 发信地址,如 "OpenClaude <auth@claudeai.chat>" 或 "auth@claudeai.chat" */
  from: string;
  /** 测试可注入 fetch */
  fetchImpl?: typeof fetch;
  /** 请求超时 ms,默认 8000 */
  timeoutMs?: number;
}

export function createResendMailer(opts: ResendMailerOptions): Mailer {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? 8000;
  return {
    async send(msg: MailMessage): Promise<void> {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetchFn("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            from: opts.from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let body = "";
          try { body = await res.text(); } catch { /* ignore */ }
          throw new Error(`resend send failed: ${res.status} ${body.slice(0, 300)}`);
        }
        // 成功: 也打一行日志方便排查(只记 to/subject/id,不记正文 token)
        let id = "";
        try {
          const j = await res.clone().json() as { id?: string };
          if (j && typeof j.id === "string") id = j.id;
        } catch { /* ignore */ }
        process.stdout.write(
          `[mail-resend] ${JSON.stringify({ _kind: "mail-resend", to: msg.to, subject: msg.subject, id, ts: new Date().toISOString() })}\n`,
        );
      } finally {
        clearTimeout(t);
      }
    },
  };
}

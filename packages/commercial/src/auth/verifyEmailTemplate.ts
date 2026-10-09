/**
 * 注册邮箱验证码邮件(注册首发 + 重发)的正文模板。
 *
 * OCV5-363(2026-10-09):运营给了一张参考截图,要求改成"浅灰底 + 白色圆角卡片 +
 * 大号间隔验证码框 + 灰色自动邮件页脚"的样式。HTML 只是增强:
 *   - text 与改造前逐字一致(纯文本客户端、测试与运营排障都按它来);
 *   - html 只用 table + 行内样式(Gmail / Outlook / QQ / 163 不认 <style> 里的类、
 *     flex、外链 CSS),不引外链图片(默认被拦,还会泄露打开记录);
 *   - 不放任何链接(与 2026-04-23 "验证码不带 URL" 的约定一致);
 *   - 不插入任何用户输入(邮箱、昵称),只有 6 位数字验证码,无需转义。
 */

export type VerifyEmailKind = "register" | "resend";

export interface VerifyEmailInput {
  kind: VerifyEmailKind;
  /** 6 位数字验证码 */
  code: string;
  /** 有效期(分钟) */
  ttlMinutes: number;
}

export interface VerifyEmailContent {
  subject: string;
  text: string;
  html: string;
}

const BRAND = "OpenClaude";
const SITE = "claudeai.chat";

function renderText(input: VerifyEmailInput): string {
  const { kind, code, ttlMinutes } = input;
  const tail =
    `请不要把验证码转发给任何人(包括自称客服的联系人)。\n\n` +
    `📬 若未在收件箱看到此邮件,请检查「垃圾邮件 / Spam」文件夹,\n` +
    `   并把 ${BRAND} 寄件地址加入联系人 / 白名单,以免后续被误判。\n\n` +
    `如果这不是你本人操作,忽略此邮件即可,账号不会被激活。\n\n` +
    `—— ${BRAND} 团队\n` +
    `${SITE}`;
  if (kind === "register") {
    return (
      `你好,欢迎使用 ${BRAND}。\n\n` +
      `这是一封由 ${BRAND}（${SITE}）发出的邮箱验证邮件。你的验证码是:\n\n` +
      `    ${code}\n\n` +
      `请在有效期内回到注册页输入此验证码完成验证。\n` +
      `验证码 ${ttlMinutes} 分钟内有效,一次性使用。若验证码过期,可在注册页点「重新发送」。\n\n` +
      tail
    );
  }
  return (
    `你好,这是一封由 ${BRAND}（${SITE}）发出的邮件。\n\n` +
    `你的新邮箱验证码是:\n\n` +
    `    ${code}\n\n` +
    `请在有效期内回到注册页输入此验证码完成验证。\n` +
    `验证码 ${ttlMinutes} 分钟内有效,一次性使用。此前发出的旧验证码已作废。\n` +
    `若验证码过期,可在注册页点「重新发送」。\n\n` +
    tail
  );
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";

function renderHtml(input: VerifyEmailInput): string {
  const { kind, code, ttlMinutes } = input;
  const title = kind === "register" ? "注册邮箱验证码" : "新的邮箱验证码";
  const lead =
    kind === "register"
      ? `欢迎使用 ${BRAND}。请在注册页输入以下验证码，完成邮箱验证。`
      : `这是你重新获取的验证码，此前发出的旧验证码已作废。`;
  const preheader = `你的 ${BRAND} 邮箱验证码，${ttlMinutes} 分钟内有效。`;
  // 字间距让 6 位数字更好抄;最后一位后面的 letter-spacing 用 padding-left 抵消,视觉居中。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 4px 16px 4px;font-family:${FONT};font-size:15px;font-weight:700;color:#111827;letter-spacing:0.2px;">${BRAND}</td></tr>
<tr><td style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:#111827;padding:0 0 12px 0;">${title}</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:24px;color:#4b5563;padding:0 0 24px 0;">${lead}</td></tr>
<tr><td style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:24px 12px 20px 12px;" align="center">
<div style="font-family:${FONT};font-size:36px;font-variant-numeric:tabular-nums;line-height:42px;font-weight:700;color:#0f172a;letter-spacing:10px;padding-left:10px;">${code}</div>
<div style="font-family:${FONT};font-size:13px;line-height:20px;color:#6b7280;padding-top:12px;">有效期：${ttlMinutes} 分钟，一次性使用。过期可在注册页点「重新发送」。</div>
</td></tr>
<tr><td style="font-family:${FONT};font-size:14px;line-height:22px;color:#4b5563;padding:24px 0 0 0;">请不要把验证码转发给任何人，包括自称客服的联系人。</td></tr>
<tr><td style="font-family:${FONT};font-size:14px;line-height:22px;color:#4b5563;padding:8px 0 0 0;">如果这不是你本人操作，忽略此邮件即可，账号不会被激活。</td></tr>
</table>
</td></tr>
<tr><td style="padding:24px 8px 0 8px;" align="center">
<div style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;height:1px;">&nbsp;</div>
</td></tr>
<tr><td align="center" style="font-family:${FONT};font-size:12px;line-height:20px;color:#9ca3af;padding:16px 8px 0 8px;">本邮件由 ${BRAND} 系统自动发送，请勿直接回复。<br>若此邮件被归入垃圾箱，请把寄件地址加入联系人，以免后续邮件被误判。</td></tr>
<tr><td align="center" style="font-family:${FONT};font-size:12px;line-height:20px;color:#9ca3af;padding:8px 8px 0 8px;">© ${BRAND} · ${SITE}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderVerifyEmail(input: VerifyEmailInput): VerifyEmailContent {
  return {
    subject:
      input.kind === "register"
        ? `[${BRAND}] 邮箱验证码 · 完成注册`
        : `[${BRAND}] 新的邮箱验证码（重发）`,
    text: renderText(input),
    html: renderHtml(input),
  };
}

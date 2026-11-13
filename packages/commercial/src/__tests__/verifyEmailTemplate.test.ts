/**
 * OCV5-363 — 注册验证码邮件模板单测。
 *
 *   - text 与改造前逐字一致(这里的期望值就是改造前 register.ts / verify.ts 的原文);
 *   - html 含验证码、有效期、忽略提示与自动邮件页脚,不含链接 / 外链图片 / 脚本;
 *   - subject 不含验证码。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderVerifyEmail } from "../auth/verifyEmailTemplate.js";

const LEGACY_REGISTER_TEXT = (code: string): string =>
  `你好,欢迎使用 OpenClaude。\n\n` +
  `这是一封由 OpenClaude（claudeai.chat）发出的邮箱验证邮件。你的验证码是:\n\n` +
  `    ${code}\n\n` +
  `请在有效期内回到注册页输入此验证码完成验证。\n` +
  `验证码 30 分钟内有效,一次性使用。若验证码过期,可在注册页点「重新发送」。\n\n` +
  `请不要把验证码转发给任何人(包括自称客服的联系人)。\n\n` +
  `📬 若未在收件箱看到此邮件,请检查「垃圾邮件 / Spam」文件夹,\n` +
  `   并把 OpenClaude 寄件地址加入联系人 / 白名单,以免后续被误判。\n\n` +
  `如果这不是你本人操作,忽略此邮件即可,账号不会被激活。\n\n` +
  `—— OpenClaude 团队\n` +
  `claudeai.chat`;

const LEGACY_RESEND_TEXT = (code: string): string =>
  `你好,这是一封由 OpenClaude（claudeai.chat）发出的邮件。\n\n` +
  `你的新邮箱验证码是:\n\n` +
  `    ${code}\n\n` +
  `请在有效期内回到注册页输入此验证码完成验证。\n` +
  `验证码 30 分钟内有效,一次性使用。此前发出的旧验证码已作废。\n` +
  `若验证码过期,可在注册页点「重新发送」。\n\n` +
  `请不要把验证码转发给任何人(包括自称客服的联系人)。\n\n` +
  `📬 若未在收件箱看到此邮件,请检查「垃圾邮件 / Spam」文件夹,\n` +
  `   并把 OpenClaude 寄件地址加入联系人 / 白名单,以免后续被误判。\n\n` +
  `如果这不是你本人操作,忽略此邮件即可,账号不会被激活。\n\n` +
  `—— OpenClaude 团队\n` +
  `claudeai.chat`;

describe("auth.verifyEmailTemplate", () => {
  test("register: subject and text unchanged from the plain-text version", () => {
    const m = renderVerifyEmail({ kind: "register", code: "205872", ttlMinutes: 30 });
    assert.equal(m.subject, "[OpenClaude] 邮箱验证码 · 完成注册");
    assert.equal(m.text, LEGACY_REGISTER_TEXT("205872"));
  });

  test("resend: subject and text unchanged from the plain-text version", () => {
    const m = renderVerifyEmail({ kind: "resend", code: "013579", ttlMinutes: 30 });
    assert.equal(m.subject, "[OpenClaude] 新的邮箱验证码（重发）");
    assert.equal(m.text, LEGACY_RESEND_TEXT("013579"));
  });

  for (const kind of ["register", "resend"] as const) {
    test(`${kind}: html card carries code, validity, ignore note and footer`, () => {
      const m = renderVerifyEmail({ kind, code: "205872", ttlMinutes: 30 });
      assert.doesNotMatch(m.subject, /\d{6}/, "subject 不得含验证码");
      assert.match(m.html, /^<!DOCTYPE html>/);
      assert.equal(m.html.split("205872").length - 1, 1, "验证码在 html 里只出现一次(不进预览文字)");
      assert.match(m.html, /有效期：30 分钟/);
      assert.match(m.html, /不要把验证码转发/);
      assert.match(m.html, /账号不会被激活/);
      assert.match(m.html, /本邮件由 OpenClaude 系统自动发送，请勿直接回复/);
      assert.match(m.html, /claudeai\.chat/);
      assert.match(m.html, kind === "register" ? /注册邮箱验证码/ : /旧验证码已作废/);
      assert.doesNotMatch(m.html, /https?:\/\//, "不带链接");
      assert.doesNotMatch(m.html, /<(img|script|link|style|a)\b/i, "不带外链图片/脚本/样式表/链接");
    });
  }

  test("ttl minutes flow into both bodies", () => {
    const m = renderVerifyEmail({ kind: "register", code: "111111", ttlMinutes: 10 });
    assert.match(m.text, /验证码 10 分钟内有效/);
    assert.match(m.html, /有效期：10 分钟/);
  });
});

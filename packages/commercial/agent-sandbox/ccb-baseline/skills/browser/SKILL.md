---
name: browser
description: 用官方 Playwright CLI 操作真实浏览器：打开网页、抓 accessibility 快照、按 ref 点击/输入、管理标签页、截图和复用持久化登录态。用户要操作动态网页、填表、登录或视觉确认时使用。
tags: [browser, playwright, automation, web]
priority: 5
---

# 浏览器操作（Playwright CLI）

当用户要**打开网页、点击、填表单、登录、操作页面或抓取动态内容**时，用 Bash 调 `oc-browser`。它是平台为每个 Agent 隔离的官方 `playwright-cli` 启动器，跨调用共享同一个真实 Chrome 会话与持久化 Profile（Cookie/登录态在 `close`、闲置回收与容器重启后自动保留，无需额外传 `--persistent`）。

## 两条核心原则

1. **除高风险操作外，任何情况下先自己尝试操作**
   - 仅读取无需交互/登录的公开网页时，优先用 `oc-web extract`（见 `skill_view("web-context")`）。
   - 需要打开页面、导航、检索、筛选、填表或点击交互时，一律先用 `oc-browser` 自己尝试推进；先直接访问业务页检查是否已处于登录态，绝不未尝试就甩手给用户。
   - 仅对**高风险操作**（支付、删除、不可逆外部提交/发布）在最终确认前主动停下，交由用户确认或接管。
2. **尝试操作仍无法推进时，发卡片请用户接管，点完成后继续**
   - 当你尝试操作后仍卡在人工门禁（账号登录 / SSO / 2FA / 验证码、高风险最终确认，或页面交互连续失败无法自行恢复）时：
     1. **保持页面停留在当前位置，切勿执行 `oc-browser close`**；
     2. **严禁**回复“不支持实时接管”或向用户索要账号、密码、验证码；
     3. 直接输出一张简洁的 `browser_handoff` 交互卡片，请用户在右侧实时云端浏览器接管操作；用户操作完毕后点击「完成并继续」或「我已完成，继续任务」，系统会通知你继续执行。

```ui
{"type":"browser_handoff","title":"请完成 GitHub 登录","url":"https://github.com/login","reason":"当前页面需要登录验证，请在右侧实时浏览器中完成登录后点击完成，我会继续后续步骤。","continue_prompt":"我已完成 GitHub 登录，请继续刚才的任务。"}
```

## 核心流程：open → snapshot → 按 ref 操作

```bash
oc-browser open https://example.com
oc-browser snapshot
oc-browser click e7
oc-browser fill e3 "a@b.com"
oc-browser press Enter
oc-browser snapshot
oc-browser screenshot --filename=/home/agent/.openclaude/generated/page.png
oc-browser close
```

- 第一次使用 `open [url]`；已有会话用 `goto <url>` 导航。
- ref 必须来自最近一次 `snapshot`，页面变化后重新 snapshot。
- 输入框优先 `fill <ref> <text>`；已聚焦输入框才用 `type <text>`。
- 优先 snapshot，需视觉确认或交付图片时才 screenshot。
- 正常完成整个任务后再 `close`；请用户接管时**切勿 `close`**。

## 常用命令

```bash
oc-browser goto https://example.com/next
oc-browser snapshot
oc-browser click e12
oc-browser dblclick e12
oc-browser fill e5 "文本" --submit
oc-browser hover e8
oc-browser select e9 "option-value"
oc-browser check e10
oc-browser go-back
oc-browser reload
oc-browser tab-list
oc-browser tab-new https://example.com
oc-browser tab-select 0
oc-browser eval "() => document.title"
oc-browser state-save /home/agent/.openclaude/generated/auth-state.json
```

不要传 `-s`、`--session`、`--profile` 或 `--user-data-dir`，会话与持久化 Profile 目录均由平台按 Agent 自动隔离管理；仅在需要彻底清空登录态时才执行 `oc-browser delete-data`。

## 失败恢复与安全边界

- 若提示浏览器未打开，只执行一次 `open <最后确认的 URL>`，然后重新 snapshot；**绝不自动重放** click/fill/press 等有副作用动作。
- 不绕过 CAPTCHA、登录墙或反爬；尝试受阻时保持页面打开并输出 `browser_handoff` 请用户接管，或改用官方 API / 用户提供的数据源。
- 截图和交付文件写到 `/home/agent/.openclaude/generated/<安全文件名>`，最终回复给出绝对路径。

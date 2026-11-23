---
name: browser
description: 用官方 Playwright CLI 操作真实浏览器：打开网页、抓 accessibility 快照、按 ref 点击/输入、管理标签页、截图和复用持久化登录态。用户要操作动态网页、填表、登录或视觉确认时使用。
tags: [browser, playwright, automation, web]
priority: 5
---

# 浏览器操作（Playwright CLI · Agent-First 闭环）

当用户要**打开网页、点击、填表单、登录、操作页面或抓取动态内容**时，用 Bash 调
`oc-browser`。它是平台为每个 Agent 隔离的官方 `playwright-cli` 启动器：命令语法、
退出码和浏览器状态均来自 Playwright CLI，不经过 Playwright MCP。

## Agent-First 三级升级漏斗（严格遵守）

1. **L0 — 免浏览器优先**：
   - 读取公开网页正文、文档、论文摘要等**无需交互/登录**的任务，优先用 `oc-web extract`（见 `skill_view("web-context")`）、官方 API、CLI 或本地工具；能不开浏览器就不开。
2. **L1 — 复用持久登录态，全自动推进至硬门禁前最后一毫米**：
   - `oc-browser` 默认把每个 Agent 的 Chrome Profile 持久化在持久卷内（`${OPENCLAUDE_HOME:-/home/agent/.openclaude}/browser-profiles/<agent_key>`，支持受限环境变量覆盖），Cookie、localStorage 与登录态在 `oc-browser close`、30 分钟闲置回收与容器重启后均**自动保留**（无需额外传 `--persistent`）。
   - 打开目标站点后，**先直接访问业务页并检查是否已处于登录态**；凡是无需人工干预的导航、检索、筛选、填表、跳转步骤，必须全自动完成，推进到**硬门禁前的最后一毫米**（例如已经打开并停留在待登录/验证/确认页），绝不提前甩手给用户。
3. **L2 — 仅在硬门禁时发 `browser_handoff`**：
   - 仅当遇到以下**真正需要人类亲自介入**的硬门禁时才请求人工接管：
     - 账号登录 / 第三方 SSO / OAuth 授权；
     - 二次验证（2FA / 短信验证码 / 扫码确认）；
     - 人机验证（CAPTCHA / Turnstile / 滑块 / 点选）；
     - 高风险最终确认（支付、删除、外部不可逆发布/提交）；
     - 同一页面交互步骤连续失败且无法靠刷新或修正 ref 恢复。

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

- 第一次使用必须 `open [url]`；已有会话后用 `goto <url>` 导航。
- ref 必须来自最近一次 `snapshot`，不要猜。页面变化后重新 snapshot。
- 输入框优先 `fill <ref> <text>`；当前已聚焦的输入框才用 `type <text>`。
- 截图仅在视觉确认或交付图片时使用；普通理解页面优先 snapshot。
- 正常完成整个任务后再执行 `close`；若需要用户接管登录/验证，**切勿 `close`**。Agent 中断时平台会在 30 分钟无浏览器操作后兜底回收进程（但保留持久化登录态目录）。

## 登录 / SSO / 2FA / 验证码：实时视口人工接管与零 Token 自动继续（重要）

OpenClaude Web 右侧工作台内置**实时云端浏览器视口（支持全屏放大与一键人工接管）**，与 `oc-browser` 共享同一个真实 Chrome 会话、持久化 Profile 与页面状态。

遇到硬门禁时：

1. 让 `oc-browser` 停留在当前待操作页面，**切勿执行 `oc-browser close`**；
2. **严禁**回复“暂不支持实时远程画面接管”或向用户索要账号、密码、验证码；
3. 直接在回复中输出一张 `browser_handoff` 智能 UI 卡片。用户完成操作后，平台网关会通过零 Token 确定性探针自动检测完成状态，静默 2 秒后弹出 3 秒倒计时自动交还助手继续（若未提供 `resume_when`，自动回落内置的登录/SSO 离开、验证码消失、下载完成检测）：

```ui
{"type":"browser_handoff","title":"请完成 GitHub 登录","url":"https://github.com/login","reason":"当前页面需要登录授权，完成后系统将自动检测登录态并交还助手继续执行。","continue_prompt":"我已完成 GitHub 登录，请继续刚才的任务。","resume_when":{"url_leave":["/login","/session","/oauth"],"url_match":["github.com/"],"selector_gone":"input[type='password']","auto_resume_delay_ms":3000}}
```

### 可选 `resume_when` 字段格式

`resume_when` 为可选对象（省略时自动启用内置通用检测），支持以下确定性条件（同时指定多项时需全部满足，且页面不存在可见密码框/OTP/验证码/SSO 拦截态）：

- `url_leave`（`string[]`）：需要离开的 URL 路径或特征片段（例如 `["/login", "/sso", "/oauth"]`；必须先观测到页面曾位于该路径后再离开才会触发）。
- `url_match`（`string[]`）：完成后期望命中的业务 URL 特征片段（例如 `["/dashboard", "github.com/"]`）。
- `selector_appear`（`string`）：完成后页面应出现的 CSS 选择器（例如 `"[data-testid='user-menu']"`）。
- `selector_gone`（`string`）：完成后页面应消失的 CSS 选择器（例如 `"input[type='password']"` 或 `".captcha-modal"`）。
- `wait_download`（`boolean`）：设为 `true` 时等待真实文件下载完成（CDP `completed` 事件）或切入 `application/pdf` 文档视图。
- `auto_resume_delay_ms`（`number`）：检测到完成并满足 2 秒键鼠静默后的自动交还倒计时毫秒数（范围 `500`–`15000`，默认 `3000`）。

## 常用命令

```bash
oc-browser goto https://example.com/next
oc-browser snapshot  # 在输出中定位“登录”对应的 ref
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

## 失败恢复

- 若提示浏览器未打开，只执行一次 `open <最后确认的 URL>`，然后重新 snapshot。
- **绝不自动重放** click/fill/press 等可能产生副作用的动作。
- 命令失败就读取 stderr，修正 ref/参数或如实说明；不要改用 curl/私有接口绕过网页流程。
- 不绕过 CAPTCHA、登录墙或反爬；遇到拦截时发 `browser_handoff` 请用户接管登录或改用官方 API/用户数据。

截图和交付文件写到 `/home/agent/.openclaude/generated/<安全文件名>`，最终回复给出绝对路径。

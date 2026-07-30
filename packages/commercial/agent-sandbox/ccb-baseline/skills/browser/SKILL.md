---
name: browser
description: 用官方 Playwright CLI 操作真实浏览器：打开网页、抓 accessibility 快照、按 ref 点击/输入、管理标签页、截图和保存登录状态。用户要操作动态网页、填表、登录或视觉确认时使用。
tags: [browser, playwright, automation, web]
priority: 5
---

# 浏览器操作（Playwright CLI）

当用户要**打开网页、点击、填表单、登录、操作页面或抓取动态内容**时，用 Bash 调
`oc-browser`。它是平台为每个 Agent 隔离的官方 `playwright-cli` 启动器：命令语法、
退出码和浏览器状态均来自 Playwright CLI，不经过 Playwright MCP。普通公开 URL 正文优先
用 `oc-web extract`（见 `skill_view("web-context")`），需要交互或渲染时才开浏览器。

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
- 完成后执行 `close`。Agent 中断时平台会在 30 分钟无浏览器操作后兜底回收。

## 常用命令

```bash
oc-browser goto https://example.com/next
oc-browser find "登录"
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
oc-browser eval "document.title"
oc-browser state-save /home/agent/.openclaude/generated/auth-state.json
```

如需登录状态跨浏览器重开保留，可在 `open` 时使用 `--persistent`；不要传 `-s`、
`--session` 或 `--profile`，会话与 profile 由平台按 Agent 隔离。

## 失败恢复

- 若提示浏览器未打开，只执行一次 `open <最后确认的 URL>`，然后重新 snapshot。
- **绝不自动重放** click/fill/press 等可能产生副作用的动作。
- 命令失败就读取 stderr，修正 ref/参数或如实说明；不要改用 curl/私有接口绕过网页流程。
- 不绕过 CAPTCHA、登录墙或反爬；遇到拦截时请用户接管登录或改用官方 API/用户数据。

截图和交付文件写到 `/home/agent/.openclaude/generated/<安全文件名>`，最终回复给出绝对路径。

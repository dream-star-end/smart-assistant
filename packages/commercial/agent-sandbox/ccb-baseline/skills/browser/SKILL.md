---
name: browser
description: 用 `oc-browser` 命令行操作真实浏览器(有状态,跨调用共享同一会话):导航、抓 accessibility 快照拿元素 ref、按 ref 点击/输入、截图、等待。用户要打开网页、点按钮、填表单、登录、抓动态页面数据时使用。
tags: [browser, playwright, automation, web]
priority: 5
---

# 浏览器操作（oc-browser CLI）

当用户要**打开网页、点击、填表单、登录、操作页面、抓取需要交互/渲染的动态内容**时,用容器内的 **`oc-browser` 命令行**(Bash 调用)。它背后是一个常驻 daemon,keep-alive 一个 Playwright 浏览器会话——所以**多次 `oc-browser` 调用共享同一个浏览器**(先 navigate/snapshot,再 click,状态连续)。普通"读一个公开 URL 的正文"用 `oc-web extract`(见 `skill_view("web-context")`)更轻;需要点/填/登录/等渲染才用浏览器。

## 核心工作流:先 snapshot 拿 ref,再按 ref 操作

```bash
oc-browser navigate --url https://example.com        # 打开页面
oc-browser snapshot                                  # 拿 accessibility tree + 每个元素的 ref(如 e7)和描述
oc-browser click --ref e7 --element "登录按钮"        # 按 ref 点击(--element 是给人看的元素描述,必填)
oc-browser type --ref e3 --element "邮箱输入框" --text "a@b.com" [--submit]
oc-browser press-key --key Enter
oc-browser wait-for --text "登录成功"                 # 或 --time <秒> / --text-gone <文本>
oc-browser screenshot --path /home/agent/.openclaude/generated/page.png   # 需视觉确认时
```

- **ref 来自 snapshot**:不要凭空编 ref。每次页面变化(导航、点击后)重新 `snapshot` 拿最新 ref。
- `--element` 是必填的人类可读描述(配合 ref 提高稳健性)。
- 优先 `snapshot`(文本、省 token)理解页面;只有需要给用户看视觉效果时才 `screenshot`。
- 加 `--json` 看原始结果(含错误细节)。

## 注意

- 浏览器是 headless 的;会话有 idle 超时(一段时间无操作自动回收),长流程要连续操作。
- 不要绕过 CAPTCHA、登录墙、反爬;遇到拦截如实告知用户并改用官方 API 或用户提供的数据。
- 截图存到 `/home/agent/.openclaude/generated/<安全文件名>` 再把绝对路径写进最终回复,平台会渲染成文件卡片。
- 每个 agent 有独立浏览器会话(独立 profile),互不干扰。

## 工具调用纪律(重要)

- **只用本 skill 对应的命令/工具传参调用**;它已把鉴权、端点、底层请求全封装好,你只需给参数。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token。
- 命令失败时按本 skill 的失败处理重试或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

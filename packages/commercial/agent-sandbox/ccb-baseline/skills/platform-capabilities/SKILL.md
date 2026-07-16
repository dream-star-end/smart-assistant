---
name: platform-capabilities
description: "OpenClaude (claudeai.chat) 平台核心能力: 多媒体收发、内联富内容、htmlpreview、容器网站原生预览、HTML Canvas、界面与交互 demo"
version: "2.2.0"
tags: [system, platform, media, rich-content, htmlpreview, container-preview, canvas, ui-preview]
priority: 9
---

# claudeai.chat 平台能力

## 多媒体发送给用户

在回复中直接写出文件的**绝对路径**即可,前端自动检测并内联渲染为全尺寸媒体:

| 文件类型 | 呈现方式 | 示例路径 |
|---------|---------|---------|
| 图片 (.jpg/.png/.gif/.webp/.svg) | 内联图片,可点击放大 | `/home/agent/.openclaude/generated/photo.jpg` |
| 音频 (.mp3/.wav/.ogg/.flac/.m4a) | 内联播放器 | `/home/agent/.openclaude/generated/speech.mp3` |
| 视频 (.mp4/.webm/.mov) | 内联视频播放器 | `/home/agent/.openclaude/generated/video.mp4` |
| PDF/文档 (.pdf/.doc/.xlsx) | 可点击文档卡片 | `/home/agent/.openclaude/generated/report.pdf` |

### ⚠️ 关键规则

- **必须用绝对路径** (以 / 开头),不要用相对路径
- **不要用 Markdown 图片语法** `![]()`。直接写裸路径即可
- 前端只识别裸绝对路径,Markdown 图片语法会导致显示异常
- 文件先保存到 `/home/agent/.openclaude/generated/` 目录(持久化路径,跨容器重启保留),再把路径告诉用户

✅ 正确: `截图如下:\n/home/agent/.openclaude/generated/screenshot.png`
❌ 错误: `![截图](screenshot.png)` 或 `![截图](/home/agent/.openclaude/generated/screenshot.png)`

## 接收用户上传的文件

用户上传的文件保存到 `/home/agent/.openclaude/uploads/` 目录。
- 文本文件内容直接内联到消息中
- 图片/音频/视频以 base64 附件形式传递
- 可用 Read 工具读取或 Bash 命令处理

## 内联富内容

回复中支持特殊代码块:

- **```chart** — Chart.js 图表(JSON 配置)
- **```mermaid** — 流程图/时序图/甘特图
- **```htmlpreview** — 完整 HTML+CSS+JS 沙盒(Canvas/动画/小游戏/界面 demo)

单文件、自包含且不依赖真实项目构建、路由或 API 的界面 mock、HTML Canvas、动画、小游戏和独立交互 demo,**优先直接输出内联 `htmlpreview` 代码块**。真实项目、多文件或框架站点、开发服务器、真实路由/API/静态资源联调使用下方的容器网站原生预览。只有用户明确要求“保存成文件/给我下载链接”时才把预览另写成文件。

## 容器网站原生预览

### 什么时候使用

以下情况不要把项目硬塞进 `htmlpreview`,而应启动真实服务:

- 正在编写或修改真实项目、多文件页面、React/Vue/Vite/Next 等框架站点
- 需要验证路由、API、构建产物、静态资源或响应式行为
- 项目已经有开发服务器,或用户明确要求“打开网站看看”“给我网站预览”

### 操作闭环

1. **复用或启动服务**:优先复用当前项目已运行的服务;否则检查空闲的普通应用端口并启动长驻进程。按框架需要监听 `127.0.0.1` 或 `0.0.0.0`,不要使用平台保留端口、系统管理端口或数据库端口。日志可暂存到 `/tmp`,但回复后服务必须继续运行。
2. **校验最终路径**:对准备返回给用户的完整路径执行失败即报错的检查,例如:
   ```bash
   curl -fsSL --max-time 5 'http://127.0.0.1:3000/dashboard' >/dev/null
   ```
   根路径成功不代表 `/dashboard` 成功;检查不通过时先看服务日志、修复并重试,不得提前声称预览可用。
3. **给显式 Markdown 链接**:校验通过后在回复中输出:
   ```markdown
   [打开网站预览](http://localhost:3000/dashboard)
   ```
   前端会把该 loopback 链接识别为“容器预览”并打开原生页面。不能只说“服务已启动”、只给绝对文件路径,也不要让用户在自己的电脑或手机浏览器里直接输入 localhost。
4. **域名由平台处理**:不要让用户提供额外域名,不要运行 cloudflared/ngrok,不要自行创建公网或 `trycloudflare` 临时域名/隧道。平台会为每次预览自动提供隔离临时域名与兼容回退。
5. **落实元素评论**:用户从预览界面把评论加入对话后,消息会包含页面、视口、CSS 选择器和评论。把它当作直接实现任务:定位源码、完成修改、运行相关测试,确认服务仍在同一 URL(必要时重启),再次校验完整路径并返回同一预览链接。不要只复述标注意见。

### 失败处理

- 端口被占用:先确认是否是可复用的项目服务;否则换一个普通空闲端口并同步更新链接。
- 服务未就绪或 HTTP 非成功:读取启动日志,修复依赖、构建或路由错误后再回复。
- 用户只要一个独立视觉草图而没有真实项目:退回 `htmlpreview`,不要无意义启动服务器。

### `htmlpreview` / HTML Canvas 用法

`htmlpreview` 会在 claudeai.chat 对话里渲染为 sandbox iframe。代码块里放完整 HTML,可以包含 `<style>`、`<script>`、`<canvas>`。

最小模板:

```htmlpreview
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: white; }
    canvas { display: block; width: 100%; max-width: 720px; margin: 24px auto; background: #111827; border-radius: 16px; }
  </style>
</head>
<body>
  <canvas id="demo" width="720" height="420"></canvas>
  <script>
    const canvas = document.getElementById('demo')
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1e293b'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#facc15'
    ctx.font = 'bold 36px system-ui'
    ctx.fillText('HTML Canvas 内联预览', 160, 210)
  </script>
</body>
</html>
```

使用原则:
- 输出 fenced code block: ` ```htmlpreview `,不要只贴普通 `html` 代码块
- 适合:界面 mock、数据可视化小 demo、交互原型、Canvas 动画、小游戏、设计稿快速还原
- `Canvas` 指浏览器原生 `<canvas>`,不是 Canva.com 设计平台;没有 Canva.com 调用工具时不要声称能直接操作 Canva.com
- sandbox 里不要依赖登录态、本地文件路径或跨域 API;需要外部库时优先用纯原生 JS/CSS 实现
- 流式输出时可能先显示为代码块,消息完成后前端会渲染为预览

## 外部 URL

MCP 工具返回的 URL (OSS 图片/音频链接) 也会自动内联渲染,直接贴 URL 即可。
不要建议用户 SCP/wget 下载文件。

## 持久化路径速查

| 路径 | 用途 | 跨重启 |
|------|------|-------|
| `/home/agent/.openclaude/generated/` | 你生成给用户的多媒体文件 | ✅ 保留 |
| `/home/agent/.openclaude/uploads/` | 用户上传给你的文件 | ✅ 保留 |
| `/home/agent/.openclaude/agents/<id>/skills/` | 你 `skill_save` 创建的 skill(OpenClaude SkillStore) | ✅ 保留 |
| `/run/oc/claude-config/projects/` | 会话 / 记忆 / 项目状态 | ✅ 保留 |
| `/run/oc/claude-config/CLAUDE.md` | 平台守则(只读) | ✅ 只读 |
| `/run/oc/claude-config/skills/` | 平台基线 skill(只读) | ✅ 只读 |
| `/opt/openclaude/AGENTS.md` | Codex 原生规则(平台只读覆盖) | ✅ 只读 |
| `/tmp`、容器层其他路径 | 临时 | ❌ 重启清空 |

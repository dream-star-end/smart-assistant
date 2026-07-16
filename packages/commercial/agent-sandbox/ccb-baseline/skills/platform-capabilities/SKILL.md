---
name: platform-capabilities
description: "OpenClaude (claudeai.chat) 平台核心能力: 多媒体收发规则、内联富内容、htmlpreview、HTML Canvas、界面预览、设计稿还原、交互 demo、小游戏"
version: "2.1.0"
tags: [system, platform, media, rich-content, htmlpreview, canvas, ui-preview]
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

当用户要求可视化、界面预览、交互 demo、HTML Canvas、小游戏、设计稿还原时,**优先直接输出内联代码块**,不要先生成 `.html` 文件。只有用户明确要求“保存成文件/给我下载链接”时才写文件。

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

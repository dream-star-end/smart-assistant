---
name: platform-capabilities
description: "OpenClaude (claudeai.chat) 平台核心能力: 多媒体收发规则、内联富内容"
version: "2.0.0"
tags: [system, platform, media]
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

- **```chart** — Chart.js 图表 (JSON 配置)
- **```mermaid** — 流程图/时序图/甘特图
- **```htmlpreview** — 完整 HTML+CSS+JS 沙盒 (Canvas/动画/游戏)

当用户要求可视化时,优先用内联代码块而不是写文件。

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
| `/tmp`、容器层其他路径 | 临时 | ❌ 重启清空 |

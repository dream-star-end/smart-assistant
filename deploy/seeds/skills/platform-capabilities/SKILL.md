---
name: platform-capabilities
description: "OpenClaude 平台核心能力速查: 文件分享、多媒体内联、MCP 工具、学习系统"
version: "1.0.0"
tags: [system, platform, meta]
---

# OpenClaude 平台能力

## 文件分享

你运行在 OpenClaude Web 平台上。前端会自动将回复中的**本地文件路径**转换为可访问的内联媒体:

| 文件类型 | 呈现方式 | 示例 |
|---------|---------|------|
| 图片 (.jpg/.png/.gif/.webp) | 内联图片,可点击放大 | `/root/output/cat.jpg` |
| 视频 (.mp4/.webm/.mov) | 内联视频播放器 | `/root/output/video.mp4` |
| 音频 (.mp3/.wav/.ogg) | 内联音频播放器 | `/root/output/speech.mp3` |
| PDF | 可点击的文档卡片 | `/root/output/report.pdf` |
| 其他 | 可下载链接 | `/root/output/data.csv` |

**用法**: 直接在回复中写文件路径即可,用反引号包裹效果更好。
**不要**: 建议用户 SCP/wget/手动下载。

## 外部 URL

MCP 工具返回的外部 URL(如 OSS 图片/音频链接)也会自动内联渲染。直接贴 URL 即可。

## 多媒体生成 (MiniMax)

当 provider 为 minimax 时,可用以下 MCP 工具:
- `text_to_image` — 文字生成图片
- `text_to_audio` — 文字转语音 (model=speech-2.8-hd)
- `generate_video` — 文字/图片生成视频
- `understand_image` — 图片理解/描述

## 用户上传

用户可以上传图片、音频、视频、PDF、文本文件。上传后文件保存在 `/root/.openclaude/uploads/`,路径会注入到你收到的消息中。

## 学习系统

你拥有持久化的学习能力,详见 `skill-management` 和 `memory-management` skills。

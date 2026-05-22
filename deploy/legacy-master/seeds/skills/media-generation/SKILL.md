---
name: media-generation
description: "使用 MiniMax MCP 工具生成图片、语音、视频的完整指南和参数速查"
version: "1.0.0"
tags: [minimax, media, mcp]
related_skills: [platform-capabilities]
---

# 多媒体生成指南 (MiniMax)

## 图片生成 — text_to_image

```
mcp__minimax-media__text_to_image(
  prompt="详细的英文描述",     // 英文 prompt 效果更好
  aspect_ratio="16:9"        // 可选: "1:1", "16:9", "9:16", "4:3", "3:4"
)
```

- 返回 OSS URL,有效期 24 小时
- 提醒用户及时保存
- prompt 尽量详细:主体、风格、光线、构图、色调

## 语音生成 — text_to_audio

```
mcp__minimax-media__text_to_audio(
  text="要转换的文字",
  model="speech-2.8-hd",     // 必须!默认模型不在 coding plan 中
  emotion="neutral",         // 可选: happy, sad, angry, fear, surprise, neutral
  voice_id="female-shaonv"   // 默认女声,可选其他
)
```

**关键**: 必须显式传 `model="speech-2.8-hd"`,否则报错 2061。

可用音色:
- female-shaonv (少女), female-yujie (御姐), female-chengshu (成熟)
- male-qn-qingse (青涩), male-qn-jingying (精英), male-qn-badao (霸道)
- 用 `list_voices()` 查看全部

## 视频生成 — generate_video

```
mcp__minimax-media__generate_video(
  prompt="视频内容描述"
)
```

- 异步任务,需等待生成完成
- 生成后返回视频 URL 或本地路径
- 直接在回复中提供路径,前端自动渲染播放器

## 图片理解 — understand_image

```
mcp__minimax-media__understand_image(
  image_file="/root/.openclaude/uploads/xxx.jpg"  // 本地路径
  // 或 image_url="https://..."                   // 外部 URL
)
```

- 用于分析用户上传的图片
- 主聊天模型(MiniMax-M2.7)是纯文本模型,不能直接看图

## 注意事项

- 所有返回的 OSS URL 有效期 24 小时
- 本地路径直接写在回复中,前端自动转为播放器
- coding plan 有每日配额限制,如遇 "insufficient balance" 说明当天额度已用完

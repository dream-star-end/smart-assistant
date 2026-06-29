---
name: minimax-media
description: Use MiniMax Token Plan media capabilities from OpenClaude commercial containers through the safe `mmx` wrapper for image, video, speech, music, and lyrics generation. Use when the user asks to generate MiniMax images, videos, speech/audio, music, lyrics, or asks to use MiniMax CLI/MMX.
---

# MiniMax media in OpenClaude commercial

Use the built-in `mmx` command. It is an OpenClaude-safe, MiniMax-compatible wrapper: it does **not** expose the platform MiniMax Token Plan key in the container. It sends requests to the OpenClaude master, which performs billing and calls MiniMax.

Do not ask for or print API keys. Do not run `mmx auth login` / `mmx config` / `mmx quota`; account commands are intentionally unavailable.

## Common commands

### Image

```bash
mmx image generate --prompt "赛博朋克城市夜景，16:9" --aspect-ratio 16:9 --out minimax-output/city.jpeg
```

### Speech / TTS

```bash
mmx speech synthesize --text "欢迎使用 OpenClaude MiniMax 媒体能力" --model speech-2.8-turbo --out minimax-output/voiceover.mp3
```

### Music

```bash
mmx music generate --prompt "轻快爵士，夏天海边" --lyrics-optimizer --out minimax-output/song.mp3
```

### Lyrics

```bash
mmx lyrics generate --prompt "一首关于夏日海边的轻快情歌" --out minimax-output/lyrics.txt
```

### Video

Submit only:

```bash
mmx video generate --prompt "夕阳下，一只猫坐在窗边望向远方" --model MiniMax-Hailuo-2.3 --duration 6 --resolution 768P
```

Wait and download:

```bash
mmx video generate --prompt "夕阳下，一只猫坐在窗边望向远方" --wait --out minimax-output/video.mp4
```

If you already have IDs:

```bash
mmx video query --task-id <task_id>
mmx video download --file-id <file_id> --out minimax-output/video.mp4
```

## Output convention

The command prints generated file paths. When responding to the user, provide the absolute or relative file paths it created; do not embed API keys or raw bearer tokens.

## 工具调用纪律(重要)

- **只用本 skill 对应的命令/工具传参调用**;它已把鉴权、端点、底层请求全封装好,你只需给参数。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token。
- 命令失败时按本 skill 的失败处理重试或如实告诉用户,**绝不**改用 curl/HTTP 兜底。


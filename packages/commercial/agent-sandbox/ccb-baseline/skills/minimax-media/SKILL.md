---
name: minimax-media
description: Generate ordinary videos with durable local MiniMax H3 jobs and minute-scale projects; use the safe `mmx` wrapper for images, speech, music, lyrics, and explicitly requested Hailuo/MMX cloud video.
priority: 4
---

# MiniMax media in OpenClaude commercial

For ordinary video requests, use `oc-h3` or `oc-video`. For images, speech, music,
lyrics, or an explicitly requested Hailuo/MMX cloud video, use the built-in `mmx`
command. These platform commands keep credentials outside the Agent container.

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

Queue one 5, 10, or 15 second shot and return its job ID immediately:

```bash
oc-h3 generate --prompt "夕阳下，一只猫坐在窗边望向远方" --duration 5 --aspect 16:9
```

First frame, last frame, and reference images may be combined:

```bash
oc-h3 generate --prompt "让人物走向镜头" --duration 10 --aspect 16:9 \
  --first-frame first.png --last-frame last.png --reference person.png
```

Do not block a normal Agent turn while generation runs. Use the durable job ID for
status, cancellation, and download:

```bash
oc-h3 status <job_id>
oc-h3 cancel <job_id>
oc-h3 download <job_id> --out result.mp4
```

For a minute-scale video, write a storyboard JSON, create a draft, show it to the
user, and start only after approval:

```bash
oc-video create --title "项目标题" --storyboard storyboard.json --reference person.png
oc-video status <project_id>
oc-video start <project_id> --expected-rev <rev>
oc-video render <project_id> --expected-rev <rev>
```

### Explicit Hailuo/MMX cloud video

Only use `mmx video` when the user explicitly requests Hailuo, MMX, or the
MiniMax Token Plan cloud service:

```bash
mmx video generate --prompt "夕阳下，一只猫坐在窗边望向远方" \
  --model MiniMax-Hailuo-2.3 --duration 6 --resolution 768P
```

If an H3 command fails, report the exact failure. Do not silently replace H3 with
Hailuo or a locally rendered procedural animation.

## Output convention

The command prints generated file paths. When responding to the user, provide the absolute or relative file paths it created; do not embed API keys or raw bearer tokens.

## 工具调用纪律(重要)

- **只用本 skill 对应的命令/工具传参调用**;它已把鉴权、端点、底层请求全封装好,你只需给参数。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token。
- 命令失败时按本 skill 的失败处理重试或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

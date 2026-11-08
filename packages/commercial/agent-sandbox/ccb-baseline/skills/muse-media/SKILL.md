---
name: muse-media
description: Generate Meta Muse videos (and images, when the Muse bridge supports them) through the platform `oc-muse` CLI — native ~10s clips, first-frame image-to-video, character/style reference video, or narrated composite explainers. Use when the user asks for Muse, a short generated video, image-to-video, or a narrated explainer with burned-in subtitles.
priority: 5
---

# Muse media (OpenClaude platform skill)

Use this skill whenever the user wants a **Muse** image or video, a short generated clip, image-to-video, a character-consistent clip from a reference image, or a longer narrated explainer with burned-in subtitles.

Call the platform CLI `oc-muse`. It already has container identity, credits, queueing, and file delivery. Do **not** call Meta Muse, any `*.trycloudflare.com` URL, or `127.0.0.1:8787` yourself.

## When to use

| User intent | Command |
|---|---|
| Short cinematic / product / nature / story clip (~10 s, native Muse Video) | `oc-muse video "<shot>"` |
| Animate a still (the image should be the opening frame) | `oc-muse video --mode first_frame --image still.png "<what happens next>"` |
| Keep a character / style / scene from reference images, but start in a **new** scene | `oc-muse video --mode reference --image hero.png --image-role character --image mood.png --image-role style "<new scene>"` |
| Longer explainer with word-for-word narration and burned-in subtitles | `oc-muse video --mode composite "<topic, language, and length in the prompt>"` |
| Several native variations of the same shot (max 6) | `oc-muse video --mode native --count 2 "<shot>"` |
| Text-to-image or image edit | `oc-muse image "<prompt>"` (and `--image` for edits) |
| Continue from a previous Muse snapshot | `oc-muse video --resume <snapshot_id> "<what happens next>"` |

If the user just says “做个视频” and does not mention narration, subtitles, or a specific duration, prefer **native**.

Video generation is tried on Muse first. If `oc-muse` reports `MUSE_NOT_ENABLED` or `MUSE_BRIDGE_OFFLINE`, tell the user Muse is unavailable, then follow `skill_view("minimax-media")` (`oc-h3`). A successful `delivery=conversation` / background-queue acknowledgment is still a Muse job: tell the user it will return to this conversation, and **do not** submit H3 or a second Muse job.

## Modes (video)

Native Muse Video (`media.generate_video`) is typically **~10 s, 1280×720 or 720×1280, 24 fps, with ambient audio**. Duration and 1080p are not selectable.

| `--mode` | Images | What Muse is asked to do | Typical output |
|---|---|---|---|
| `native` (default) | none | One continuous native clip | ~10 s, often 720p, ambient sound |
| `first_frame` | exactly 1 | Image-to-video; the image is the starting frame (not a locked keyframe) | Native clip that should open on that still |
| `reference` | 1..N | Images are character / style / scene / object references, **not** the first frame | Native clip of the requested new scene |
| `composite` | optional | Stills/clips + TTS + burned-in subtitles, assembled | Often longer, often 1080p; use only when narration/subtitles/length are required |

`--count` is 1–6 and only applies to native-family modes (`native`, `first_frame`, `reference`). It asks for separate variations, not one longer film.

If `--mode` is omitted:

- no `--image` → `native`
- one `--image` → `first_frame` (image-to-video)
- more than one `--image` → `reference`

`--resume` (snapshot continue) is a hatch/Muse-VM capability. If the worker reports it is unsupported, tell the user honestly; do not invent a continuation by stitching clips yourself.

Last-frame / first+last-frame interpolation is **not** supported. Do not promise it. Do not pass a “last frame” image as if Muse had that parameter.

## How to write the prompt

Write the **subject / shot** only. The platform wraps it with mode instructions. Follow these rules (see `references/prompt-guide.md`):

1. Describe **one continuous shot**: subject + place + lighting + camera move + sound/ambience. Do not send a storyboard list unless `mode=composite`.
2. Do **not** demand an exact duration (e.g. “must be 14 seconds”) or 1920×1080 / 1080p in native-family modes. That pushes Muse into ffmpeg compositing. For vertical video, write “vertical 9:16” or pass `--orientation vertical`.
3. Do **not** ask for burned-in subtitles or a word-for-word narration script unless `mode=composite`. Native audio is ambient/mood; lip-sync and TTS are unreliable.
4. Camera language works: tracking, orbit, push-in, turntable 360°. English technical camera terms are often clearer; Chinese is fine when the on-screen world should feel Chinese.
5. In-world text (a neon sign that reads OPEN) can work. Overlay captions in native mode cannot be trusted.
6. For `first_frame`, describe motion from that still. Do not also say “this is only a style reference.”
7. For `reference`, the CLI labels each image. Still say what must stay consistent (pink bob, yellow glasses, green star hoodie) and that the opening shot is the **new** scene, not the reference still.

Example native prompt:

```
A single continuous shot: a red bicycle rolling slowly through a narrow sunlit alley, slow tracking shot alongside it at wheel height, warm golden afternoon light, cobblestone street, tires on cobblestone and distant birdsong, photorealistic, calm mood. No on-screen captions.
```

## Commands

Finished files are written under `/home/agent/.openclaude/generated/`. Print the absolute path(s) in your reply to the user. Do not use Markdown image syntax `![]()` for the video; a bare absolute path is enough for the UI to inline it.

```bash
# Native text-to-video (default)
oc-muse video "A glass perfume bottle rotating under a shaft of morning light, slow 360 turntable, rim light, faint mist, no on-screen text"

# Vertical native
oc-muse video --orientation vertical "夜市炒锅里的炒面被高高抛起，蒸汽和火花，竖屏 9:16，连续跟拍"

# First-frame image-to-video
oc-muse video --mode first_frame --image still.png "She starts walking toward the camera and waves. Keep the same face, hair, and clothes."

# Character + style references
oc-muse video --mode reference \
  --image hero.png --image-role character \
  --image kitchen.png --image-role style \
  "She sits at the wooden table beside the sunflowers. The first frame is already the painted kitchen, not the studio still."

# Two native variations
oc-muse video --mode native --count 2 "A ceramic coffee cup steaming on a wooden table, soft window light, slow push-in"

# Narrated explainer (composite)
oc-muse video --mode composite "介绍黑洞是什么，中文旁白和字幕，节奏紧凑，大约 20 秒，16:9"

# Image (only if the connected Muse backend supports stills)
oc-muse image "a red fox in a snowy field, cinematic photo"

# Fetch an earlier job (for example after MUSE_TIMEOUT / durable delivery)
oc-muse fetch mj_<uuid>
```

While a job is waiting for a free slot, stderr shows `# Muse queue: position N of M`; tell the user. On success, where Muse is billed, stderr ends with `# charged: N credits`.

If the CLI prints `delivery=conversation` or a background-queue acknowledgment, stop and tell the user the clip will arrive in this conversation. Do not poll in a tight loop in a way that blocks the turn after that acknowledgment, and do not start a second generation.

`oc-muse fetch <job_id>` downloads an earlier job's files when you already have the id.

## Limits

- Native clip: about 10 seconds; resolution is not a menu (observed 1280×720, or 720×1280 when asked for 9:16).
- At most **6** native clips per request (`--count`).
- Source images: png/jpg/webp (gif may be rejected by the server), typically ≤ 10 MiB each, up to 4 via `oc-muse`.
- Site-wide Muse video concurrency is small. Extra jobs queue; they are not parallelized without limit.
- Video credits are charged only when a job **succeeds** (commercial default decision: 50 credits per video job, 10 per image job). Failures are not charged.
- One Muse account / worker pool is shared across users. Do not fire many jobs at once “just in case.”
- Automating Muse can hit Meta usage caps or account limits. If the worker reports a cap or login problem, tell the user; do not retry in a loop.

## Errors

Report the `code` and message from the CLI stderr JSON (`{"ok":false,"code":"MUSE_…",...}`). Common codes:

| Code | What to do |
|---|---|
| `MUSE_NOT_ENABLED` | Muse is not turned on for this account. Tell the user. Then `skill_view("minimax-media")`. |
| `MUSE_BRIDGE_OFFLINE` | No Muse worker is connected. Tell the user. Then consider `oc-h3` only after informing them. |
| `MUSE_BUSY` | Queue full or wait timed out. Suggest retrying later; do not immediately spray more jobs. |
| `MUSE_INSUFFICIENT_CREDITS` | Not enough 积分. Tell the user the shortfall; do not switch providers silently. |
| `MUSE_VIDEO_REGION_BLOCKED` | Do **not** retry. Tell the user Muse video is blocked for this request. |
| `MUSE_TIMEOUT` | The job may still finish on the server. Try `oc-muse fetch <job_id>` if you have an id. Do not submit a duplicate. |
| `MUSE_INVALID_INPUT` / `MUSE_BAD_ARGS` | Fix the prompt, mode, or images; do not retry unchanged. |
| `MUSE_UPSTREAM_ERROR` / `MUSE_UPSTREAM_REJECTED` | Transient or content rejection. Retry at most once if `retryable` is true; otherwise report it. |
| `MUSE_UPLOAD_FAILED` / `MUSE_SOURCE_FETCH_FAILED` / `MUSE_SOURCE_TOO_LARGE` | Source image problem. Resize/re-encode and retry once, or drop the extra references. |
| mode mismatch (native requested, assembled film returned) | The worker already retries once. If the file still looks composited, tell the user and offer `mode=composite` only if they actually wanted narration/subtitles. |

Do not claim a video was generated unless `oc-muse` printed an absolute path or a durable conversation delivery acknowledgment.

## 工具调用纪律

- **只用** `oc-muse`（以及本 skill 写明的 flags）。鉴权、端点、令牌、上游地址都已封装。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP，**绝不**猜测或硬编码 URL、端口、接口路径或 token。
- 不要读取或打印 `/workspace/muse-relay/.env`、bridge token 文件，或任何 `MUSE_RELAY_TOKEN` / `mbr_` 凭据。
- 命令失败时按上表处理或如实告诉用户，**绝不**改用 curl/HTTP 兜底。


## Operator note (not for agents)

Which worker produces the MP4 is an operator choice (`OC_MUSE_VIDEO_BACKEND=hatch|box-exec`, default `hatch`, plus an optional `$OC_MUSE_STATE_ROOT/video-backend` file). Agents should keep using `oc-muse` the same way either way; do not mention or depend on a specific backend.

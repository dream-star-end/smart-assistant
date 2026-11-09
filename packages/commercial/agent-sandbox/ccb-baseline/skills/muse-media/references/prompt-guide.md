# Muse prompt recipes (platform reference)

Condensed from the box relay `PROMPT_GUIDE.md` (research on 2026-11-08, Asia/Taipei). Native clips are Muse Video / `media.generate_video`: typically 10.0s, 1280×720 or 720×1280, 24 fps, AAC mono ~24 kHz, no scene cuts. Composite/explainer clips are longer, often 1920×1080 30 fps AAC 48 kHz with narration and burned-in subtitles.

The CLI/server wraps the user's subject in a per-mode template. The agent still writes the shot.

## Top rules

1. One continuous shot: subject + setting + lighting + camera move + sound.
2. Do not demand an exact duration or 1080p in native-family modes.
3. Do not ask for burned-in subtitles or verbatim narration unless `mode=composite`.
4. Camera words work (tracking, orbit, push-in, turntable). English terms are often clearer.
5. In-world text can work; overlay captions are unreliable.
6. First-frame vs reference is wording + image order, not a Muse API flag.
7. `--count` 2–6 means variations, not a longer film.
8. First+last-frame interpolation is not supported. First-frame matching can be near pixel-perfect at t=0 and then drift.

## Templates

Native (EN):

```
A single continuous shot: [subject] in [place], [time / weather],
[camera move], [lighting], [texture details], [sound/ambience],
[style], [mood]. No on-screen captions.
```

Native (ZH):

```
一个连续镜头：[主体] 在 [场景]，[时间/天气]，[运镜]，[光线]，[材质细节]，[环境声]，[风格]，[情绪]。不要字幕、不要旁白稿。
```

First-frame: upload one image; describe only the motion (“She starts walking toward the camera and waves. Keep the same pink bob, yellow glasses, and green star hoodie.”).

Reference: label each image (`character`, `style`, `scene`, `object`) and say the opening shot is the new scene, not the reference still.

Composite: describe the topic, language, and approximate length (“用大约 15 秒介绍什么是黑洞，中文旁白和字幕，节奏紧凑，16:9”).

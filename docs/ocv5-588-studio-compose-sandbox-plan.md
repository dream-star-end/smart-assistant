# OCV5-588 方案：媒体工作台的 ffmpeg 合成沙箱（master 调度的一次性容器）

- 总票 OCV5-586（媒体工作台第一期，商业版）。用户 2026-10-23 批准 D4：采用合成沙箱容器方案。
- 只改商业版 `feat/v5-aurora-rewrite`。本 PR **只交付可测试的模块和镜像构建脚本**：不接 HTTP，不暴露给容器，也不改动任何现有服务的行为。由 OCV5-591（编排器）接入。

## 1. 为什么

runtime 镜像、v5-dev、kl-mirror 上都没有 ffmpeg。而工作台离不开它：抽尾帧、缩略图、胶片条、波形，以及最终拼接、调色、转场、字幕、混音、响度归一。另外，烧录中文字幕需要 CJK 字体，通用的 ffmpeg 镜像一般不带。

## 2. 镜像 `openclaude/studio-ffmpeg:<tag>`

- `packages/commercial/media-studio/ffmpeg/Dockerfile`：
  - 基于 `debian:bookworm-slim`（按 digest 固定）；
  - `apt-get install --no-install-recommends ffmpeg fonts-noto-cjk fonts-noto-color-emoji`；
  - 创建 uid/gid 1000 的 `media` 用户，`USER 1000`，`WORKDIR /work`；
  - 不装 shell 以外的工具，不带网络工具。
- `packages/commercial/media-studio/ffmpeg/build-image.sh`：
  - 在 kl-mirror 上 `docker build`，打 label `oc.build.input_digest`；
  - 打印镜像 ID（`sha256:...`）；
  - 不推送到任何 registry。
- master 只认镜像 ID：`OC_STUDIO_FFMPEG_IMAGE_ID=sha256:<64hex>`（`config.ts` 校验格式）。不设置时，合成能力报“未配置”，不会退回去用某个 tag。
- 构建镜像和写 env 都是生产变更，随发布一起执行，需要批准。

## 3. 运行器 `media-studio/compose/runner.ts`

```ts
class ComposeRunner {
  constructor(opts: { docker: Docker; imageId: string; root: string; maxConcurrent?: number /*默认 2*/ })
  run(job: ComposeJob): Promise<ComposeResult>   // 全站并发达到上限时排队等待（FIFO），等待超时则抛 COMPOSE_BUSY
}
```

- 每个 job 有自己的工作目录 `<root>/work/<jobId>/{in,out}`：
  - `in/` 由调用方提前放好输入文件。路径只接受 basename，必须是 `[A-Za-z0-9._-]{1,80}`，并经过 `lstat` 检查不是符号链接；
  - `out/` 为空，权限 0700，属主 1000。
- 容器参数照搬 `plugins/localSandbox.ts` 的隔离做法：
  - `NetworkMode: 'none'`、`NetworkDisabled`、`ReadonlyRootfs`、`CapDrop ALL`、`no-new-privileges`；
  - `User 1000:1000`；
  - `Memory` 2 GiB（不允许用 swap）、`NanoCpus` 2e9、`PidsLimit` 256；
  - `Tmpfs /tmp` 256 MiB；
  - `in/` 以只读方式挂到 `/work/in`，`out/` 以读写方式挂到 `/work/out`，挂载传播设为 rprivate；
  - 不写日志（`LogConfig none`），带 label `com.openclaude.studio.compose=1`。
- **命令永远是参数数组**（`Entrypoint: []`、`Cmd: ['ffmpeg', ...]` 或 `['ffprobe', ...]`），不经过 shell，所有参数由下面的类型化规格生成。
- 超时：每种操作都有上限（probe 30 s，抽帧和缩略图 60 s，波形 60 s，成片合成 600 s）。超时就 kill，状态码不是 0 时取 stderr 前 2 KB，作为 `COMPOSE_FAILED`。
- 输出校验：只收 `out/` 里预期的文件名；单个文件 ≤ 512 MiB；用文件头魔数检查 mp4 / png / wav / json。
- **运行期磁盘硬上限**（Codex plan r1 P1-2）：
  1. 每个 ffmpeg 输出都带 `-fs <字节>`（成片 512 MiB，帧和胶片条 20 MiB，`pcm.raw` 16 MiB）。ffmpeg 写到上限就停，所以单个输出不会超过上限（只有一个包大小的余量）。产物大小达到上限的 99% 时，视为被截断，报 `COMPOSE_OUTPUT`。
  2. 每个输入都带时长上限：`waveform_pcm` 和 `probe` 以外的解码都加 `-t`（取剪辑长度，最多 600 s）；`waveform_pcm` 固定 `-t 600`（8 kHz 单声道 s16le 最多约 9.6 MB）。
  3. 磁盘预留（r2 P1-2，覆盖并发和两个进程）：开工前先拿 `<root>/reservations/.lock`（用 O_EXCL 创建的锁文件，里面写 owner；如果 owner 已死就接管这个锁）。持锁期间汇总 `reservations/*.json` 里 owner 仍然活着的预留字节数，满足“`statfs` 可用空间 − 已预留 ≥ 本操作的 `maxOutputBytes`（成片 512 MiB、帧 20 MiB×n、pcm 16 MiB）+ 1 GiB”时，才写入自己的预留文件。写完后释放锁。不满足就返回 `COMPOSE_DISK`，不启动容器。任务结束（无论成功失败）就删除预留文件。owner 已死的预留**不能直接忽略**（plan r3 P1-2）：持锁汇总时如果发现死 owner 的预留，先对该 owner 执行 sweep，把它名下所有带 label 的容器 force remove（容器被删除后就不会再写盘），确认 `docker ps` 里已经没有该 owner 的容器之后，才删除它的预留文件；否则继续计入。因为每个输出都有 `-fs` 硬上限，在途任务的实际写入量不会超过它的预留。
- 不管成功还是失败都 `container.remove({force:true})`；工作目录交给调用方清理，并提供 `cleanup(jobId)`。
- 残留清理（plan r1 P1-1、r2 P1-1：必须**证明** owner 已经失效，不能凭年龄或时钟判断）：A/B 两个 master 都在同一台主机上，共用同一个 Docker daemon。每个容器带 label `com.openclaude.studio.owner=<hostname>:<pid>:<进程 starttime>`，其中 starttime 取 `/proc/<pid>/stat` 的第 22 列，用来防止 pid 被复用。`sweepStale()` 的规则：
  - 容器状态是 `exited` 或 `dead` → 删除，因为已经停止的容器不会再写盘。`created`、`restarting`、`paused` 这几种状态可能下一刻就会运行（例如 A 刚 create 完、还没 start），所以和 running 一样处理，也要先证明 owner 已死（plan r3 P1-1）；
  - 容器在运行，并且 owner 的 hostname 是本机，而 `/proc/<pid>` 不存在或 starttime 对不上 → owner 进程已死 → 删除；
  - 其它情况（owner 还活着、label 无法解析、hostname 不是本机）→ **不碰**。
  完全不依赖墙钟。

## 4. 类型化操作（纯函数生成 argv，重点单测）

| 操作 | 输入 | 产出 | 说明 |
|---|---|---|---|
| `probe` | 一个媒体文件 | `ffprobe -v error -print_format json -show_format -show_streams` 的 stdout JSON | 拿时长、尺寸、帧率、音轨 |
| `frames` | 视频文件，时间点 ≤ 12 个 | `frame-<i>.png` | `-ss t -i f -frames:v 1`；用于抽尾帧和 QA 抽帧 |
| `filmstrip` | 视频文件，帧数 n ≤ 24，高度 | `filmstrip.png` | `fps=n/dur,scale=-2:h,tile=nx1` |
| `waveform_peaks` | 音频文件，peaks ≤ 4000 | `peaks.json` | 先解码成 8 kHz 单声道 s16le 的 `pcm.raw`，再由 node 计算峰值；不让 ffmpeg 画图 |
| `compose` | 见下 | `final.mp4`（以及可选的 `final.srt`） | 最终合成 |

`compose` 的规格：

```ts
{
  width: 1280|1920, height: 720|1080, fps: 24|25|30,
  clips: [{ file, inSec, outSec }],                  // 1..40 段，按顺序；每段 0.5..60 s
  transitions?: { kind: 'cut'|'fade', durSec?: 0.2..1 },
  grade?: 'none'|'warm'|'cool'|'film',               // 预设 → eq/curves 固定参数，不接受任意 filter 字符串
  subtitles?: { file: 'subs.ass', burn: boolean },   // ASS 由 node 端生成（字体、颜色固定），文件名固定
  voice?: [{ file, startSec, gainDb }],              // 0..60 段
  music?: { file, gainDb, duckDb, fadeInSec, fadeOutSec },
  loudness: { targetLufs: -16 },
}
```

- filter_complex 由代码拼装：每段 `trim`/`setpts` → `scale` 加 `pad`（统一分辨率）→ `fps` → 拼接（`concat` 或 `xfade`）→ 调色 → `subtitles=filename=/work/in/subs.ass`（字体目录固定为 `/usr/share/fonts`）。音频：每段旁白先 `adelay`，再 `amix`；音乐经 `afade` 后用 `sidechaincompress` 按旁白压低，再 `amix`，最后 `loudnorm=I=-16`。
- 所有数字参数先做范围钳制，再格式化成固定小数位；文件名只能是 `in/` 下已经校验过的 basename。用户文本**不会**进入 filter 字符串：字幕内容在 ASS 文件里，ASS 生成器会转义 `{}`、`\`，以及换行之外的控制字符。
- 编码：`libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart`，音频 `aac 192k 48 kHz`。

## 5. ASS 字幕生成 `media-studio/compose/ass.ts`

- 输入 `[{ startSec, endSec, text }]`、画幅、样式预设（白字、细描边、底部居中，字体 `Noto Sans CJK SC`）。
- 转义规则：`\` → `\\`，`{` → `\{`，`}` → `\}`，换行 → `\N`，其它控制字符删除；单条不超过 200 字。

## 6. 配置

- `OC_STUDIO_ROOT`：默认 `/var/lib/openclaude-v5/studio`，必须是绝对路径。
- `OC_STUDIO_FFMPEG_IMAGE_ID`：`sha256:<64hex>`，没有默认值。
- `OC_STUDIO_COMPOSE_CONCURRENCY`：默认 2，上限 8。
- 本 PR 只在 `config.ts` 里加校验，不在 `index.ts` 里装配（由编排器 PR 装配）。所以合入后对现网**零行为变化**。

## 7. 测试

- 单测（不需要 Docker）：
  - argv 和 filter_complex 生成：各操作，边界值（0 段、41 段、负时间、in ≥ out、超范围的 gain），文件名注入（`../x`、`a;b`、`a,b`、`a:b`、带空格）一律拒绝；
  - ASS 转义：花括号、反斜杠、换行、控制字符、emoji；
  - 输出校验（魔数）；
  - runner 用假的 dockerode：校验 createContainer 的参数（网络 none、只读根文件系统、cap、user、资源上限、mounts）、超时会 kill、状态码不为 0 时报错、无论成败都 remove、并发上限和排队。
- 真跑 ffmpeg 的冒烟（`media-studio/compose/smoke.test.ts`）：本机和 CI 都没有镜像，所以默认跳过，设置 `OC_STUDIO_FFMPEG_IMAGE_ID` 时才跑。上线前在 kl-mirror 上用新镜像实测一次（3 段 2 秒的测试视频 + 1 段旁白 + 音乐 + 字幕 → 成片，再 probe 核对时长、分辨率、响度）。属于发布步骤，需要批准。

## 8. 风险

- 磁盘：工作目录由编排器在 job 结束后清理，配额见 OCV5-594。
- CPU：kl-mirror 有 16 核，全站最多 2 个合成并发、每个 2 核，不会影响 master 和用户容器。
- 镜像体积：bookworm-slim + ffmpeg + CJK 字体，约 400 MB。

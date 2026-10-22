# DESIGN 2026-10-22 — 个人版接入 Muse 图片/视频生成（Muse bridge）阶段 0 设计 v3.1

- 范围：只改个人版 `feat/v5-selfhost`，不碰商业版 `feat/v5-aurora-rewrite`。
- 状态：**仅设计，未写代码、未建工单分支、无任何服务器变更**。交管家转用户批准后再实现。
- 作者：cc3（2026-10-22）。
- v2 变更（管家 02:31 / 02:32 CST 转达用户意见）：① bridge 先定稿、优先实现，已交付到 `/workspace/muse-bridge/`（见 §16），个人版端的工具以后另行批准；② 视频按正常可用设计，超时默认 300 秒，只有真实返回 `video_not_available` 才报错，删掉 v1 的“地区限制缓存”；③ 分镜加配音的替代路线不做。
- v3 变更（管家 02:58 CST，依据用户提供的 `/workspace/MUSE-MEDIA-CLI-v2.md`，该文档已与 `--help` 逐项核对）：① 源图改为两步：先 `--upload-only --image-file` 拿到 `image_ids`，再把 `{"image":ID}` 项放进 `--conversation-json`，排在文字项之前。v2 用的 `--reference-image-file` 是 legacy 参数，与 media_subagent 混用会报错（退出码 1）。同一路径支持图片编辑和图生视频；② 新增续接生成：job 可带 `resume_snapshot_id`，对应 `--resume-from-snapshot-id`，结果回传新的 `snapshot_id`；③ `--image-output-format` 只用于图片，视频不暴露时长、分辨率参数（单条固定约 10 秒，分辨率由后端或源图决定）；④ 视频地区限制已解除（02:34 实测约 40 秒出一条 10 秒 mp4，约 10.7 MB），64 MiB 的上限足够；⑤ bridge 升到 v0.2.0。
- v3.1 变更（管家 03:38 CST 转达用户在真实 Muse VM 上的确认）：① `--upload-only` 的输出就是 `{"image_ids":[…]}`；同一张图每次上传都拿到新 ID，不能缓存复用，bridge 保持每个任务现传；② 源图加续接可以一起用，能正常出片，输出分辨率跟随新源图（1152×768，而不是原片的 1280×720）；③ 修复 `status`/`stop` 在状态目录不存在时抛 FileNotFoundError 的问题，bridge 升到 v0.2.1。
- 依据：`/workspace/CC3-MUSE-MEDIA-KICKOFF.md`、`/workspace/MUSE-MEDIA-CLI.md`（hatch 0.1.0 / e904e1f8854 实测）及其修订版 `/workspace/MUSE-MEDIA-CLI-v2.md`（v3 起以修订版为准）、个人版 canonical `ec47562a2` 只读调研。

## 0. 本轮授权与硬限制（任务书原话要点）

- 目标：把 Muse 的图片生成、视频生成包装成个人版两个系统工具。
- 方案前提：Muse VM 里跑 bridge，**主动外连**个人版，带密钥鉴权，一次只跑一个任务。
- 视频（v2，用户 02:32）：按正常可用设计，超时给足（≥ 260 秒）。只有真实返回 `video_not_available` 时才如实报错、不重试。分镜加配音的替代方案不做。
- 开放范围默认只给 user 3，做成可配置。
- 规则：每个 PR 过 Codex；上线前过 CI，用测试账号 uid 765 实测；不碰 user 4；不同时发布（v5-dev 空闲、负载 < 6、队列空）；不打印密钥；不读 credentials.enc、unlock/、remote/、/root/.openclaude-v5-remote/；不 pkill/pgrep -f；不删 /tmp/tsx-0；不重置共享测试库；不碰 cc1；不影响走订阅代理的服务。

## 1. 现状调研结论（只读）

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| 容器内平台 CLI → master `/internal/v3/*` → 上游，是现成模式。`oc-minimax`（`mmx`）用容器 token 调 `/internal/v3/minimax`，master `verifyContainerIdentity` 双因子验身，回 `files[{filename,mime,base64}]`，CLI 落盘 | `platform-runtime/bin/oc-minimax.py`、`src/minimax/mediaProxy.ts`、`src/index.ts:2421-2973` | 容器侧完全照抄这个模式，新增 `oc-muse` 和 `/internal/v3/muse-media` |
| 平台 CLI 经 platform bundle 下发，`PLATFORM_LINKED_CLIS` 在 `/usr/local/bin` 和 `~/.local/bin` 建软链，Cursor/Codex/CCB 等引擎都能在 shell 里用，**不需要重建镜像** | `entrypoint.ts:510-530` | `oc-muse` 加进这张表即可，所有引擎通用 |
| 给用户发文件的约定：存到 `/home/agent/.openclaude/generated/`，回复里写裸绝对路径 | `ccb-baseline/AGENTS.md:7` | 成品文件落这个目录，工具输出绝对路径 |
| `/internal/v3/*` 只对容器网络开放（ctx 带 hostUuid/boundIp） | `index.ts` 内部路由 | bridge 不能走 internal，要在公网监听器上开新前缀 |
| 个人版公网入口是 cloudflared **Quick Tunnel**：`--url http://127.0.0.1:18790`，`COMMERCIAL_BASE_URL=https://<随机>.trycloudflare.com`，自 2026-10-15 起未重启 | `deploy/v5-selfhost/cloudflared-v5-selfhost.service`、`/etc/openclaude/commercial-v5-selfhost.env`（只读了这一行） | ① cloudflared 重启后域名会变，bridge 要能换地址；② Cloudflare 单请求体上限 100 MB、空闲约 100 s 断开，决定了长轮询时长和分片大小 |
| GPT Pro 原型（OCV5-551）的开放范围是 uid=3 独占，用 `isBoxGptWebOwnerUid` 在服务端判断；并发是全局 1，忙时快速失败 | `$H/DESIGN-20261021-gpt-astra-web.md` §10 | 开放范围、单槽语义与它对齐，但 uid 从常量改成配置 |
| 最新迁移 `0314_selfhost_box_gpt_6_astra_pro.sql`；保留期登记在 `admin/retentionRegistry.ts` | migrations 目录 | 新增 `0315_selfhost_muse_media.sql`（只增不删），审计表登记保留期 |

## 2. 总体架构

```
agent（任意引擎，shell）
  └─ oc-muse image|video …                              容器内平台 CLI（新增）
       └─ POST /internal/v3/muse-media                  master（容器身份 + uid 白名单 + 限频）
            └─ MuseBridgeHub（master 进程内，单槽 + 短队列）
                 ⇅  HTTPS 长轮询（bridge 主动外连，公网前缀 /api/muse-bridge/*）
            muse-bridge.py（Muse VM 内，纯 Python 标准库单文件）
                 └─ /opt/hatch/bin/media-generation --media-subagent-output-type …
                      └─ 成品文件分片上传回 master → 返回容器 → 写进 generated/ → 对话里给出路径
```

### 2.1 关键决定：外连用 HTTPS 长轮询，不用 WebSocket

任务书写的是“主动外连”，没规定协议。选长轮询的理由：

1. Muse VM 已确认有 `python3`（`muse-gen` 依赖它），但不确定有没有 `websockets` 这类第三方库，VM 重置还会丢掉用户装的东西。长轮询只用 `urllib`，单文件、零依赖。
2. Muse 的出口要经 STEFI 代理。`urllib` 会自动遵守 `HTTPS_PROXY`；WebSocket 要自己处理 CONNECT 隧道，风险更大。
3. Quick Tunnel 和 Cloudflare 对普通 HTTPS 最友好。WS 也能用，但空闲 100 s 会被断开，照样要自己做心跳。
4. 一次只跑一个任务，吞吐不是问题，长轮询多出的几百毫秒延迟可以忽略。

任务书列的“连接保活与断线”在长轮询下仍然适用，具体见 §5。

## 3. bridge 协议（`/api/muse-bridge/v1/*`，挂在 18790 公网监听器上）

所有请求都带 `Authorization: Bearer <bridge token>` 和 `X-Muse-Bridge-Session: <session_id>`。请求体和响应体都是 JSON（分片上传除外）。功能开关 `OC_MUSE_BRIDGE_ENABLED` 不是 `1` 时，整个前缀一律返回 404。

| # | 方法与路径 | 作用 | 要点 |
|---|---|---|---|
| 1 | `POST /hello` | 建立会话 | 请求体 `{bridge_version, hostname_hash, cli_path, cli_version}`。返回 `{session_id, poll_hold_sec:25, heartbeat_sec:15, limits:{…}}`。新 hello 会**顶替**旧 session（旧 session 的后续请求返回 409 `superseded`），保证同一时间只有一个 bridge 在线 |
| 2 | `POST /poll` | 取任务（长轮询） | master 最多挂起 25 s。有任务就返回 `{job}`，没有就 204。每次 poll 都刷新 `last_seen`。job 里带一次性 `job_nonce` |
| 3 | `POST /jobs/{id}/heartbeat` | 任务进行中保活 | 每 15 s 一次，带 `job_nonce`。返回 `{cancel:true}` 表示 master 已放弃这个任务（超时或调用方断开），bridge 要立刻杀掉 CLI |
| 4 | `PUT /jobs/{id}/files/{idx}/chunks/{n}` | 分片上传成品 | 原始字节，`Content-Type: application/octet-stream`，每片 ≤ 4 MiB，头里带 `X-Chunk-Sha256`。master 校验后追加写入临时文件 |
| 5 | `POST /jobs/{id}/result` | 结束任务 | 成功：`{ok:true, files:[{idx, filename, mime, bytes, sha256}], meta:{artifact_ids, snapshot_id, media_type}}`。失败：`{ok:false, error_code, error_message, downstream_status, retryable, exit_code}`。master 核对每个文件的总长度和整体 sha256 |
| 6 | `GET /bridge.py`（可选） | 下载 bridge 脚本 | v2：脚本先以文件形式交付（§16），这个接口推迟到 PR2 视需要再加 |

job 结构：

```json
{"id":"mj_01J…","nonce":"…","kind":"image|video","prompt":"…",
 "orientation":"square|vertical|landscape|null","aspect_ratio":"4:5|7:12|9:16|null",
 "image_format":"png|jpg|webp|null",          // 只限 image；video 带它会被判为 MUSE_INVALID_INPUT
 "timeout_secs":120,                          // 视频至少 300（bridge 会把低于 300 的值提到 300），上限 600
 "source_images":[{"base64":"…"}]|null,       // 0–4 张，每张 ≤ 10 MiB，png/jpg/webp；用于图片编辑或图生视频
 "resume_snapshot_id":"<上次结果的 snapshot_id>"|null,
 "deadline_at":"2026-10-22T…Z"}
```

bridge 端的安全约束：

- argv 只由 job 里白名单字段拼出来；`--conversation-json` 用 `json.dumps([{"image": id}…, {"text": prompt}])` 生成；`subprocess` 不经过 shell。
- 只执行固定路径 `/opt/hatch/bin/media-generation`，不接受任何其它命令或参数。
- 每个 job 用独立的 `mkdtemp` 输出目录，上传完或失败后删除。
- **源图分两步**（v3）：源图写进 `<job>/upload/`。先执行 `media-generation --upload-only --image-file <图>… --output-dir <job>/upload`，不带任何 media_subagent 参数，上限 120 秒；从 stdout 取 `image_ids`，数量必须与图数一致，格式必须是 `[A-Za-z0-9:_.-]{1,128}`。然后生成时把每个 ID 写成 `{"image": ID}` 项，放在 text 项之前。上传失败报 `MUSE_UPLOAD_FAILED`，不再执行生成。**任何一次调用都不会同时出现 legacy 参数（`--image-file`/`--image-id`/`--reference-image-*`）和 media_subagent 参数**，测试里对全部调用记录做了断言。
- **续接**（v3）：`resume_snapshot_id` 只允许 `[A-Za-z0-9:_.-]{1,200}`，对应 `--resume-from-snapshot-id`。成功结果的 `meta.snapshot_id` 原样回传，供下一次续接。
- **源图 ID 不复用**（v3.1 真机确认）：同一张图每次上传都拿到新 ID，旧 ID 不能保证可用，所以 bridge 和 master 都**不缓存** image ID，每个任务现传。
- **续接加新源图**（v3.1 真机确认可以出片）：同时带 `source_images` 和 `resume_snapshot_id` 时，先上传拿 ID，再在同一次生成里带 `{"image":ID}` 项和 `--resume-from-snapshot-id`。**输出分辨率跟随新源图**，例如 1152×768 的新图产出 1152×768 的视频，不沿用原片的 1280×720。工具说明要写明这一点，免得 agent 以为续接一定保持原分辨率。
- 不回传 `media_urls`：fbcdn 签名链接本身就是访问凭证，不进对话也不进审计。

## 4. 鉴权与密钥存放

- **token 格式**：`mbr_` 前缀加 32 字节随机数（base64url）。
- **master 端**：只存 `sha256(token)`，放在新表 `muse_bridge_credentials`（字段：`id, label, token_sha256, created_at, revoked_at, last_seen_at, last_ip`）。比对用常量时间比较。
- **签发**：在 v5-dev 上运行运维脚本 `scripts/muse-bridge-token.sh issue --label muse-vm-1`。明文 token 只写进 root 0600 文件 `/root/ocv5-muse/bridge-token-<id>`，**不在终端回显**。脚本只打印 id 和文件路径。用户自己取出 token 粘贴到 Muse VM，这一步记入 `USER-ACTIONS.md`。
- **吊销与轮换**：`revoke <id>`（设置 `revoked_at`）和 `rotate`（签发新 token，旧的保留 24 h 后吊销）。
- **Muse 端**：token 存在 `~/.muse-bridge/token`，目录权限 0700，文件 0600。只用 `--token-file` 传入，不进命令行参数、不进环境变量、不写日志。
- **失败限流**：同一 IP 每分钟鉴权失败超过 10 次 → 429，冷却 10 分钟，并记 warn 日志（日志里不带 token）。
- **容器侧**：照搬 `verifyContainerIdentity`，拿到权威的 `userId`。bridge token 与容器 token 是两套凭据，互不相通。

## 5. 连接保活与断线

| 场景 | 处理 |
|---|---|
| 空闲 | bridge 循环 `/poll`，master 挂起 25 s，低于 Cloudflare 约 100 s 的空闲断开阈值 |
| 判断在线 | `now - last_seen ≤ 60 s` 算在线。不在线时工具立即返回 `MUSE_BRIDGE_OFFLINE`，不排队 |
| 网络错误或 5xx | 指数退避 1、2、4 … 60 s，加 ±20% 抖动，然后重新 `/hello` |
| 401 或 403 | token 无效或已吊销。bridge 打印“token 失效”后**退出**，不死循环 |
| 409 superseded | 有新的 bridge 接管。旧 bridge 退出 |
| 任务中 bridge 掉线 | master 60 s 收不到 heartbeat → 任务记为 `MUSE_BRIDGE_LOST`，调用方收到错误。**不自动重派**，因为生成可能已经在后端扣量或落盘 |
| master 重启或发布切换 | 内存中的 job 丢失；审计行在启动时把残留的 `running` 收口为 `MUSE_MASTER_RESTARTED`。bridge 的 poll 会失败，然后退避重连。bridge 迟到的 result 返回 410，bridge 丢弃 |
| Quick Tunnel 域名变化 | 每次重连（`/hello`）前 bridge 都会重读 `~/.muse-bridge/server`。用户执行 `start --server <新地址>` 后，正在运行的 bridge 在下一次重连时就会切过去。长期方案是改用固定域名的 named tunnel，见 §13 待定 1 |
| Muse VM 重置 | `/opt/hatch` 还在，但 `~/.muse-bridge` 可能丢失。重新执行 §11 的一键命令即可 |

## 6. 并发、限频、超时

- **并发**：全局只有 1 个运行槽，因为 bridge 一次只跑一个任务。master 侧另有 FIFO 短队列，长度上限 `OC_MUSE_QUEUE_MAX=3`，最长等待 `OC_MUSE_QUEUE_WAIT_SEC=240` 秒。队列满或等待超时 → `MUSE_BUSY`，提示“Muse 通道忙，稍后再试”。之所以不像 GPT Pro 那样直接拒绝：agent 常会连着出几张图，留一个短队列体验更好。bridge 端再加一层进程内锁兜底，收到第二个任务直接拒绝。
- **限频**（按 uid，用 DB 计数，可配置）：

  | 类型 | 每小时 | 每天 |
  |---|---|---|
  | 图片 | `OC_MUSE_IMAGE_PER_HOUR=30` | `OC_MUSE_IMAGE_PER_DAY=200` |
  | 视频 | `OC_MUSE_VIDEO_PER_HOUR=5` | `OC_MUSE_VIDEO_PER_DAY=20` |

- **视频不做地区限制缓存**（v2）：每次视频请求都真实调用 Muse，只有 CLI 真的返回 `video_not_available` 时才报 `MUSE_VIDEO_REGION_BLOCKED`，并且不自动重试。
- **超时链**（每一层都比内层多留余量）：

  | 层 | 图片 | 视频 |
  |---|---|---|
  | CLI `--timeout-secs`（bridge 会钳在 30–600 之间，视频至少 300） | 120 | 300 |
  | bridge 杀进程组（CLI 超时 + 15 s） | 135 | 315 |
  | master job deadline（含成品上传；带源图时再加 120 s 源图上传） | 180 | 390 |
  | 容器 `oc-muse` HTTP 超时（deadline + 队列等待 + 30 s） | 450 | 660 |

- 容器侧调用方断开时（比如 agent 中止），master 把 job 标为 cancel，bridge 在下一次 heartbeat 收到后杀掉 CLI。

## 7. 文件回传与大小限制

| 项目 | 上限 | 说明 |
|---|---|---|
| 单个图片文件 | 25 MiB | 实测 webp 约 450 KB |
| 单个视频文件 | 64 MiB | 视频暂时无法实测，按 5–10 s 的短片估算 |
| 单个 job 的文件 | 4 个 | |
| 单个 job 的总字节 | 80 MiB | |
| 上传分片 | 4 MiB | 低于 Cloudflare 的 100 MB 单请求上限 |
| 源图（容器 → bridge） | 最多 4 张，每张 ≤ 10 MiB | 仅限 png、jpg、webp。实测视频 10.7 MB（文生视频 1280×720）或 6.7 MB（图生视频），低于 64 MiB 上限 |

- bridge 先用 `os.stat` 检查大小，超限直接报 `MUSE_FILE_TOO_LARGE`，不上传。master 按累计字节再检查一次，超限立即终止这个 job。
- MIME 只认白名单：`image/webp|png|jpeg`、`video/mp4|webm`。用文件头魔数核对，不信任扩展名。
- master 把分片暂存到 `/var/lib/openclaude-v5-selfhost/muse-media/<job>/`，容器取走后删除；兜底清理任务每 10 分钟删掉超过 1 小时的残留。
- 容器取文件的方式与 `mmx` 一致，响应里直接带 `files[{filename,mime,base64,bytes,sha256}]`。最坏情况是 64 MiB 视频，base64 后约 85 MB 的单个 JSON，可以接受；以后视频放开、文件变大时，再改成 `GET` 流式下载。
- `oc-muse` 把文件写进 `/home/agent/.openclaude/generated/muse-<kind>-<短id>.<ext>`，在 stdout 打印绝对路径。agent 按 AGENTS.md 的约定在回复里写出这个裸路径，前端就会显示成品。

## 8. 工具定义（两个系统工具）

两个工具的形态都是平台 CLI `oc-muse`。它加进 `PLATFORM_LINKED_CLIS`，随 platform bundle 下发，Cursor、Codex、CCB、Antigravity 等引擎都能在 shell 里调用。用法说明只注入给白名单用户，见 §10。以下 JSON Schema 是参数的唯一定义：CLI 参数、master 的 zod 校验和文档都由它生成或与它对齐。

**`muse_generate_image`** → `oc-muse image`

```json
{"type":"object","additionalProperties":false,"required":["prompt"],
 "properties":{
  "prompt":{"type":"string","minLength":1,"maxLength":4000,"description":"图片描述，中英文都可以"},
  "orientation":{"enum":["square","vertical","landscape"]},
  "aspect_ratio":{"enum":["4:5","7:12","9:16"],"description":"orientation 不够精确时才用"},
  "format":{"enum":["png","jpg","webp"],"default":"webp","description":"只对图片有效"},
  "source_images":{"type":"array","maxItems":4,"items":{"type":"string"},"description":"容器内本地图片的绝对路径。提供后即为图片编辑（图 + 文 → 新图）；身份保持也用这个，并在 prompt 里说明"},
  "resume_snapshot_id":{"type":"string","description":"上一次结果返回的 snapshot_id，用于接着上一张继续生成"}
 }}
```

CLI 用法：`oc-muse image "<prompt>" [--orientation …] [--aspect-ratio …] [--format …] [--image <path>]… [--resume <snapshot_id>] [--json]`

**`muse_generate_video`** → `oc-muse video`

```json
{"type":"object","additionalProperties":false,"required":["prompt"],
 "properties":{
  "prompt":{"type":"string","minLength":1,"maxLength":4000},
  "orientation":{"enum":["square","vertical","landscape"]},
  "aspect_ratio":{"enum":["4:5","7:12","9:16"]},
  "source_images":{"type":"array","maxItems":4,"items":{"type":"string"},"description":"提供后即为图生视频，输出分辨率跟随源图"},
  "resume_snapshot_id":{"type":"string","description":"续接上一条视频的画面与上下文；可以和 source_images 同时使用，此时输出分辨率跟随新源图"}
 }}
```

视频**没有**时长、分辨率、帧率、格式参数：单条固定约 10 秒、24 fps、H.264 + AAC；文生视频 1280×720，图生视频跟随源图尺寸。工具说明里写明这一点；需要更长的视频时，用 `resume_snapshot_id` 分段续接（拼接由 agent 自己用 ffmpeg 完成，不属于本工具）。

- 输出：成功时退出码 0，stdout 每行一个文件绝对路径，最后一行是 `snapshot_id: <id>`；带 `--json` 时输出 `{"ok":true,"files":[…],"job_id":…,"snapshot_id":…}`。失败时退出码 1，stderr 输出一行 `{"ok":false,"code":"MUSE_…","message":"中文说明","retryable":bool}`。参数错误退出码 2。
- 不开放的 CLI 参数：legacy 位置参数、`--image-id`、`--reference-image-*`、头像动画（包括 `--duration-seconds`）、图标池、`--caller`、`--task-type`、`--upload-handler`、`--conversation-id`、`--request-id`。续接（v3）已经开放，计入同一套限频。

## 9. 错误码映射

| 来源 | 判断条件 | 工具错误码 | retryable | 给 agent 和用户的中文说明 |
|---|---|---|---|---|
| CLI | 退出码 1，`error_code=video_not_available` | `MUSE_VIDEO_REGION_BLOCKED` | **否** | 原样转述 Muse 的说明（当前账号所在地区不支持视频生成） |
| CLI | 退出码 1，其它 `error_code`，且 `retryable:true` | `MUSE_UPSTREAM_ERROR`（附带原始 `error_code`） | 是（agent 最多再试 1 次） | Muse 后端暂时出错 |
| CLI | 退出码 1，其它 `error_code`，且 `retryable` 为 false 或缺失 | `MUSE_UPSTREAM_REJECTED`（附带原始 `error_code` 和 `error_message`） | 否 | 原样转述后端给出的原因（例如内容政策） |
| CLI | 退出码 2 | `MUSE_BAD_ARGS` | 否 | 内部参数错误，属于 bridge 的 bug，记 error 日志 |
| CLI | 退出码 0，但 stdout 不是 JSON、`ok` 不为 true，或 `media_paths` 为空 | `MUSE_BAD_OUTPUT` | 否 | 记录前 2 KB 的 stdout（脱敏后）用于排查 |
| CLI `--upload-only` | 退出码非 0、没有 `image_ids`，或数量、格式不对 | `MUSE_UPLOAD_FAILED`（附带退出码；源图上传那一步的 `retryable` 原样透传） | 视情况 | 源图上传失败，没有进行生成 |
| CLI | 可执行文件不存在 | `MUSE_CLI_MISSING` | 否 | bridge 在 `/hello` 时就上报，master 把这个 bridge 标为不可用 |
| bridge | 超过 CLI 超时 + 15 s | `MUSE_TIMEOUT` | 是 | |
| bridge 或 master | 文件超出大小上限 | `MUSE_FILE_TOO_LARGE` | 否 | |
| master | bridge 不在线 | `MUSE_BRIDGE_OFFLINE` | 否 | Muse 端中转未运行，需要用户在 Muse 里重新启动（§11） |
| master | 任务中 heartbeat 丢失 | `MUSE_BRIDGE_LOST` | 否 | |
| master | 进程重启导致 job 丢失 | `MUSE_MASTER_RESTARTED` | 是 | |
| master | 队列满或等待超时 | `MUSE_BUSY` | 是（稍后） | |
| master | 超出限频 | `MUSE_RATE_LIMITED`（附带 `reset_at`） | 否 | |
| master | uid 不在白名单或开关关闭 | `MUSE_NOT_ENABLED`（HTTP 403） | 否 | |
| master | 参数校验失败 | `MUSE_INVALID_INPUT`（HTTP 400） | 否 | |

视频请求收到 `MUSE_VIDEO_REGION_BLOCKED` 时，提示词会引导 agent 如实告诉用户，不重试，也不自动改成别的方案。

bridge 还会产生以下错误码：`MUSE_CANCELLED`（master 通过 heartbeat 取消任务）、`MUSE_BRIDGE_LOST`（任务进行中 bridge 被停止，会主动上报）。退出码不是 0/1/2 的情况（例如崩溃）归入 `MUSE_BAD_OUTPUT`，附带退出码。

## 10. 开放范围控制

- 配置项 `OC_MUSE_ALLOWED_UIDS`，逗号分隔，默认 `3`；为空表示谁都不开放。放在 `commercial-v5-selfhost.env`，重启后生效。
- **服务端判断是唯一权威**：`/internal/v3/muse-media` 用容器身份拿到 uid，再与白名单比对，不在名单里返回 `MUSE_NOT_ENABLED`。
- **可见性**：工具说明只对白名单 uid 注入。实现时先核实 `/internal/v3/platform-prompt-slots` 能否按 uid 下发；如果不能，就由 `oc-muse` 在启动时向 master 查询 `GET /internal/v3/muse-media/status`，不在名单的用户看到“未开放”。CLI 本身对所有容器存在，但没有说明文字，agent 一般不会主动去调。
- **uid 765 实测**：实测窗口内把白名单临时改成 `3,765`，测完改回 `3`。前后各记一条带时间的证据。**不碰 user 4**：白名单解析时拒绝 4，配置成 4 也会被忽略并记 warn。这条与“不碰 user 4”的规则对应，如果用户另有要求可以去掉。
- 管理端只读页面（可选，PR3）：显示 bridge 是否在线、最近 heartbeat 时间、版本、今日用量。

## 11. Muse 侧一键启动（v2 定稿，已实现）

先把 `/workspace/muse-bridge/muse_bridge.py` 放进 Muse VM，然后执行：

```bash
python3 muse_bridge.py start --server https://<个人版域名>
```

- 首次运行会提示粘贴 token（`getpass` 不回显），保存为 `~/.muse-bridge/token`（0600），并把地址写进 `~/.muse-bridge/server`。
- 随后自检：`media-generation --help` 能否运行、临时目录是否可写、能否连到 server（任何 HTTP 响应都算连通）。自检通过后两次 fork 转入后台运行。
- 用 `flock` 文件锁保证只有一个实例，pid 写在 `bridge.pid`。
- 其它命令：`status`、`stop`（按 pid 发送 SIGTERM，20 秒后才 SIGKILL，并先核对 `/proc/<pid>/cmdline`；不用 pkill）、`check [--server]`、`set-token`、`run`（前台运行，可放进 tmux）、`try image|video "…"`（只在本机跑一次 CLI，不连 server）。
- 日志 `~/.muse-bridge/bridge.log`（0600）：超过 5 MB 轮转，保留 2 份。只记录任务 id、类型、耗时、错误码和字节数。
- 隐藏参数 `--cli` 只供测试替换 CLI 路径；`--state-dir` 或环境变量 `MUSE_BRIDGE_HOME` 可以改状态目录。

## 12. 审计日志

新表（迁移 `0315_selfhost_muse_media.sql`，只增不删）：

```sql
CREATE TABLE muse_bridge_credentials (
  id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL, token_sha256 BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ, last_ip INET, last_bridge_version TEXT);

CREATE TABLE muse_media_jobs (
  id TEXT PRIMARY KEY,                    -- mj_<ulid>
  user_id BIGINT NOT NULL, container_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  prompt_sha256 BYTEA NOT NULL, prompt_preview TEXT NOT NULL,  -- 前 500 字
  params JSONB NOT NULL,                  -- orientation/aspect/format/has_ref
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  error_code TEXT, upstream_error_code TEXT, downstream_status INT,
  bridge_credential_id BIGINT REFERENCES muse_bridge_credentials(id),
  files JSONB,                            -- [{mime,bytes,sha256}]，不含 URL
  muse_artifact_ids TEXT[], muse_snapshot_id TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ);
CREATE INDEX ON muse_media_jobs (user_id, queued_at DESC);
```

- 限频计数直接查 `muse_media_jobs`：`user_id + kind + queued_at > now()-interval`，状态排除 `failed/MUSE_NOT_ENABLED`。
- 结构化日志事件：`muse_bridge_hello`、`muse_bridge_auth_fail`（只记 IP 和 credential id）、`muse_media_job_{queued,started,finished}`。
- 保留期：在 `retentionRegistry.ts` 登记 `muse_media_jobs` 保留 180 天。
- 不记录：token、fbcdn 链接、成品文件内容。prompt 只存前 500 字和哈希。

## 13. 风险与待用户拍板

1. **公网地址不固定（推荐先接受现状）**：Quick Tunnel 域名会随 cloudflared 重启而变化。v1 的做法是让 bridge 读 `server` 文件，换地址时用户在 Muse 里改一行。另一个选择是改用 named tunnel 加固定域名，需要用户提供域名或 Cloudflare 账号，并且会动 cloudflared 服务，所以另开票处理。
2. **Muse VM 的出口能否访问 trycloudflare（必须先验证）**：Muse 的网络经 STEFI 代理，能否访问任意 HTTPS 域名还没实测。实现之前的第一步是请用户在 Muse 里执行一次 `curl -fsS https://<HOST>/healthz`。如果访问不通，整个外连方案要改。
3. **Muse VM 能否长期跑后台进程**：会话结束、VM 休眠或重置后，bridge 可能被停掉。v1 依靠“离线时立即报错 + 一行命令重启”来应对；能否常驻要实测。
4. **使用条款**：在 Muse 之外批量调用它的生成能力，是否符合 Meta 的条款由用户判断。CLI 文档也提到“手跑与产品内调用可区分”。

## 14. 测试计划

**单元测试（本地，跟随 PR）**

- bridge（Python `unittest`，用 `python3 -I` 运行）：argv 拼装和白名单、`conversation-json` 转义（引号、换行、中文、emoji）、CLI stdout 解析、错误码映射表的每一行、超时杀进程组、大小上限、MIME 魔数、退避序列、401 和 409 时退出。
- master（`packages/commercial` 现有测试框架）：鉴权（缺失、错误、已吊销、常量时间比较）、session 顶替、队列（上限、等待超时、FIFO）、单槽、heartbeat 丢失、deadline、cancel 传递、分片 sha 和总长校验、限频计数、白名单解析（默认 3、空值、包含 4 时忽略）、启动时收口残留 job、开关关闭时 404。
- `oc-muse`：参数到请求体的转换、文件落盘路径、退出码、`--json` 输出。

**集成测试（本地，用假 CLI）**

用 stub 脚本替代 `media-generation`（按修订版文档模拟：legacy 参数与 media_subagent 混用时退出码 1；`--upload-only` 返回 `image_ids`；续接返回同前缀的新 snapshot），覆盖这些场景：成功出一张 webp、两步图片编辑、图生视频、续接链、10.7 MB 视频分 3 片、`video_not_available`、`retryable:true` 的错误、退出码 2、`sleep` 超时、输出非 JSON、生成 70 MiB 大文件。真实启动 `bridge.py` 连接本地 master，跑完整链路（容器 CLI → master → bridge → 回传 → 落盘），再测 bridge 中途被 kill、master 重启这两种情况。

**CI**：推送后开草稿 PR，等托管 CI 全绿（`$H/wait-ci.sh`）。本地不跑 commercial 或 gateway 的全量测试；跑任何测试前先执行 `$H/wait-for-trains.sh`。

**Codex**：每个 PR 用 `$H/codex-review.sh` 审查，直到 APPROVED。

**上线实测**（发布要单独批准；发布前确认 v5-dev 空闲、负载 < 6、发布队列为空）：

1. Muse 端按 §11 启动 bridge，确认管理端显示在线，或日志里有 `muse_bridge_hello`。
2. 白名单临时设为 `3,765`。用 uid 765 发一轮真实对话：“用 Muse 生成一张雪地红狐的图”。检查四件事：对话里出现图片、`generated/` 里有对应文件、`muse_media_jobs` 有一行 `succeeded`、文件 sha256 与 bridge 日志一致。
3. uid 765 请求一段短视频：按正常可用预期，对话里出现 mp4（约 10 秒、约 10.7 MB），审计里 `succeeded`，总耗时在 390 秒以内。再用上一步的图做一次图生视频，以及一次续接（带 `resume_snapshot_id`），各成功一次。如果 Muse 真的返回 `video_not_available`，确认工具报 `MUSE_VIDEO_REGION_BLOCKED`、agent 如实说明、审计里只有 1 次调用、没有重试。
4. 换一个不在白名单的测试 uid（不用 4）调用 `oc-muse`，确认返回 `MUSE_NOT_ENABLED`。
5. 并发：同时发 2 次出图请求，确认第二次排队后成功，或者返回 `MUSE_BUSY`。
6. 停掉 bridge（`tmux kill-session -t muse-bridge`），确认 60 s 内工具返回 `MUSE_BRIDGE_OFFLINE`。
7. 白名单改回 `3`，记录证据，文件统一用 `g<工单号>-` 前缀。

## 15. PR 拆分

每个 PR 都过 Codex 和 CI；合入和发布之前停下等批准；迁移只增不删。

1. **PR1 master 端**：迁移 0315、`MuseBridgeHub`、`/api/muse-bridge/v1/*`、`/internal/v3/muse-media`、token 运维脚本、限频、审计。默认 `OC_MUSE_BRIDGE_ENABLED=0`，合入后行为不变。
2. **PR2 容器端**：`oc-muse` CLI、加入 `PLATFORM_LINKED_CLIS`、按 uid 注入工具说明；把 `muse_bridge.py` 和它的测试收进仓库（`packages/commercial/muse-bridge/`），供 CI 运行。
3. **PR3（可选）**：管理端只读状态页。

上线配置（打开开关、写入白名单、签发 token）属于生产变更，在发布时单独执行并记录证据。

## 16. bridge 交付记录（v2，2026-10-22）

- 交付位置（Box 本机）：`/workspace/muse-bridge/`，包含 `muse_bridge.py`（单文件、约 990 行、仅用标准库、不含任何密钥）、`README.md`（一行启动命令和其它命令）、`SHA256SUMS`。
- 本机测试（Python 3.13，用 stub CLI 加 mock master）：24 项全部通过。
  - 纯函数：argv 白名单与中文/emoji 转义、视频超时下限 300 和上限 600、非法输入、错误映射、server 下发的限额被本地硬上限截住、只接受 https、超时会杀掉整个进程组、CLI 缺失。
  - 端到端：hello、图片成功（分片重组后 sha256 一致、不回传 fbcdn 链接）、9 MiB 分 3 片上传、视频成功且 `--timeout-secs 300`、7 种 CLI 失败映射、非法任务、参考图、heartbeat 取消、410 后继续工作、临时目录清理、第二个实例被拒、`status`、停止时上报 `MUSE_BRIDGE_LOST`、日志里没有 token/提示词/链接且权限是 0600、错误 token 退出码 2、被接管后退出、后台 `start`。
  - 测试过程中发现并修复 1 个 bug：heartbeat 线程先杀掉 CLI 时，任务被误报为 `MUSE_BAD_OUTPUT`，现在正确报 `MUSE_CANCELLED`。
- 尚未验证：在真实 Muse VM 上运行（Python 版本、出口代理、能否访问 trycloudflare、后台进程能否常驻）。建议用户先在 Muse 里执行 `python3 muse_bridge.py check --server https://<域名>` 和 `python3 muse_bridge.py try image "…"`。
- 个人版端的接口还没实现，在那之前 `start` 连上后会收到 404，然后按退避重试。

### 16.1 v0.2.0 修订（2026-10-22 03:01 CST，依据 `MUSE-MEDIA-CLI-v2.md`）

- 改了什么：
  - 删掉 `--reference-image-file`，改成两步：`--upload-only --image-file…` 先拿 `image_ids`，再把 `{"image":ID}` 项放在文字之前。由此支持图片编辑和图生视频，最多 4 张源图。
  - 新增 `resume_snapshot_id` 对应 `--resume-from-snapshot-id`，结果回传新的 `snapshot_id`。
  - video 带 `image_format` 会被拒绝；`aspect_ratio` 两种类型都允许（修订版 §4.2 把它列为通用参数）。
  - 新增错误码 `MUSE_UPLOAD_FAILED`。
  - `try` 命令的 `--ref` 换成可重复的 `--image`，新增 `--resume`，结束时打印 `snapshot_id`。
  - 版本号改为 0.2.0。
- 测试：31 项全部通过，连续 3 次。stub CLI 按修订版重写，混用 legacy 参数会以退出码 1 失败，所以这个错误一旦回归，测试必然会发现。新增的测试项：两步 argv、源图和 snapshot 校验、上传失败时不执行生成、E2E 图片编辑、E2E 图生视频（6.7 MB）、E2E 续接链（同前缀的新 snapshot）、10.7 MB 视频分 3 片且 sha 一致、70 MiB 视频被拒、全部调用记录里没有混用参数。
- 文件：`muse_bridge.py` 约 1065 行；`SHA256SUMS` 同时覆盖 `muse_bridge.py` 和 `README.md`。
- 仍未验证（03:38 已由用户在真机上确认，见 16.2）：~~上传 stdout 的格式~~、~~源图加续接的组合~~。

### 16.2 v0.2.1 修订（2026-10-22，依据管家 03:38 转达的真机确认）

- 修复：状态目录（默认 `~/.muse-bridge`）不存在时，`status` 会抛 `FileNotFoundError`。同样的问题在 `stop` 里也有，一并修复：两个命令开头都先调用 `ensure_state_dir`（建目录，权限 0700）。修复后：在新机器上 `status` 输出“未运行”（退出码 1），`stop` 输出“没有在运行”（退出码 0），都不再报错。
- 新增测试：`FreshStateDir`（目录不存在时运行 status/stop，不报错、目录权限 0700）、E2E `test_07c2`（续接加新源图：先上传，生成时同时带 image 项和 `--resume-from-snapshot-id`）。共 33 项全部通过，连续 3 次。
- 行为说明写进 README 和本文 §3：image ID 不缓存；续接加新源图时输出分辨率跟随新源图。
- 范围：只改中转程序，个人版 PR1 没有开始。

## 直连入口（2026-10-22 补充）

**为什么需要：** 第一次真机启动时，Muse VM 出口 IP 发出的请求被 Cloudflare 边缘拦截，返回 HTTP 403 `Your request was blocked.`，`Server: cloudflare`。请求根本没有到达 master。trycloudflare 快速隧道不能配置 WAF 放行，所以 bridge 需要一个不经过 Cloudflare 的入口。

**做法：** 由 `muse/publicListener.ts` 实现。

- master 另开一个 HTTPS 端口，用 `OC_MUSE_PUBLIC_PORT` 指定，监听 `0.0.0.0`。证书和私钥由 `OC_MUSE_PUBLIC_TLS_CERT` / `OC_MUSE_PUBLIC_TLS_KEY` 指定，个人版只读复用 GPT 订阅代理的 Let's Encrypt 证书文件。
- 这个端口只把 `/api/muse-bridge/*` 交给同一个 bridge handler，其它路径一律返回 JSON 404。所以 token 鉴权、按 IP 的失败锁定、会话接管规则都和主入口完全一致。
- 客户端 IP 只取 TCP 对端地址，不信任 `X-Forwarded-For`。
- 证书每小时按 mtime 检查一次，变了就热加载（certbot 续期后生效）。读取失败时继续用已加载的证书。
- 端口被上一个 master 占用时，最多重试 10 分钟。
- 关停时会主动断开挂起的长轮询。
- 未设置端口时这个入口不开；配置错误或监听失败只记 error，不影响 master 启动。
- 不改 GPT 订阅代理（8443）的代码和进程，也不动 Cloudflare 隧道。

**个人版取值：**

- `OC_MUSE_PUBLIC_PORT=8444`；
- 证书和私钥用 `OC_CHATGPT_PROXY_TLS_CERT/KEY` 的同一组文件；
- bridge 启动参数改为 `--server https://38-55-252-217.sslip.io:8444`。

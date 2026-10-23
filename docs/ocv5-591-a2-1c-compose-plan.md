# OCV5-591 A2-1c-1 合成（compose）方案

依据：编排方案 `docs/ocv5-591-a2-1-orchestrator-plan.md`（A2-1c 一行、状态机 §2）、后端方案 `docs/ocv5-591-media-studio-backend-plan.md` §4、OCV5-588 合成沙箱；用户 2026-10-23 21:42 与 22:13 的定价决定。叠在 #1032（M1 音乐来源与合成参数）上。推送 `sys.studio_event` 拆到 A2-1c-2（跨 protocol / userChatBridge / web-react 四处，前端现在靠轮询，不阻塞）。

## 1. 谁触发
- **导演 agent 自动触发**：`advanceProject` 判断所有镜头 ready（active take 是 shot_video）且所有台词 ready、没有在途生成 → 入队一个 `compose` 任务，项目进入 `composing`（取代 A2-1a 的 `awaiting_user / compose_pending`）。
- 合成沙箱未配置（`OC_STUDIO_FFMPEG_IMAGE_ID` 未设）→ 仍停在 `awaiting_user / compose_pending`，事件说明“合成沙箱未配置”。
- **用户切换导出规格**（成片页「导出」：1080p / 720p / 竖屏 9:16，字幕烧录 / .srt / 无字幕）→ `POST /projects/:id/export {resolution, subtitles}` 入队同一种 compose 任务（`reason: 'export'`）。只在项目 `done` 时可用；同一规格已有成片时直接返回已有的那一版，不重复合成。
- 没有其它用户直接合成的入口。

## 2. 计费（修订总方案 §1.3、编排方案 A2-1c 行）
- 用户 21:42：合成由 agent 操作时**只按 agent 的 token 用量计费，不收每次固定费**。合成本身不调用 LLM，所以合成任务**不扣任何积分**：预留 0、`studio_charges` 不写合成行、take `cost_credits = 0`。
- 用户 22:13：导出切换规格触发的重新合成**免费**。
- 0324 的 `studio_charges.kind = 'compose'` 与 ledger reason `media_studio` 保留不用（不改迁移）；文档里“合成是工作台唯一自有扣费项”的说法改为“合成不收费”。

## 3. 合成做什么（一次 compose 任务）
1. 读项目：镜头按 ordinal、每个镜头 active 的 shot_video take；台词与其 line take；配乐 = `settings.musicTakeId` 指向的 music take（没有就不配乐）与 `settings.musicEdit`。
2. 时间线：镜头依次排开，长度 = 镜头 `spec.durationSec`（不超过视频实际长度）；台词按所属镜头均分放置（与前端 `timeline()` 同一算法：第 i 句起点 = 镜头起点 + i × 镜头长 / 句数 + 0.15 s）。
3. 字幕：用台词文本与上面的时间生成 `.ass`（烧录）或 `.srt`（随成片附带一个 .srt 文件，存为同一 final take 的附件 blob）。
4. 尺寸：按项目画幅和导出分辨率：16:9 → 1920×1080 / 1280×720；9:16 → 1080×1920 / 720×1280；1:1 → 1080×1080 / 720×720。「竖屏 9:16」对 16:9 素材按 9:16 画布居中加黑边（不裁剪画面）。合成规格（OCV5-588 `ComposeSpec`）的尺寸白名单相应扩展这四种。
5. 合成沙箱（OCV5-588 `ComposeRunner`）：把用到的 blob 复制进作业的 `in/`，执行 `compose`，得到 `final.mp4`（-fs 512 MB 上限）；音乐按 #1032 的 `MusicEdit`（截取 / 位置 / 循环 / 淡入淡出 / 闪避）。
6. 成片 QA：沙箱 `probe` 读 `final.mp4`，检查有视频和音频流、时长与时间线总长相差 ≤ 0.5 s；结果写进 take 的 `qa`（{durationSec, expectedSec, hasAudio, passed}）。响度已由 loudnorm 对齐到 −16 LUFS，A2-1c-1 不另测。
7. 写 blob（用户的 take 引用）→ 在租约事务里写 final take（owner_kind `final`、owner 项目、provider `compose`、model `ffmpeg`、cost 0、meta {variant, credits}）→ 项目 `done`（自动合成时）→ 事件 `compose.done`。
8. 署名：meta.credits 汇总配乐的授权快照（CC BY 必须署名的列出署名原文），供成片页署名区块（d14，前端后续 PR）使用。

## 4. 失败与重试
- 沙箱错误按可重试（COMPOSE_BUSY / COMPOSE_DISK / COMPOSE_TIMEOUT）与不可重试（COMPOSE_INVALID / 输入缺失）区分；可重试按 A2-1a 的执行器退避，最多 3 次。
- 最终失败：自动合成 → 项目回到 `awaiting_user`（reason `compose_failed`），事件写原因；导出合成 → 项目保持 `done`，事件说明这个规格没合成成功。都不扣费。
- 失租：与生成任务一致（`withLease`），新持有者重做；blob 先写、take 在租约事务里写，丢租只留下 GC 可回收的引用。

## 5. 不在本步
- `sys.studio_event` 推送（A2-1c-2）；成片页的规格切换按钮接 `/export`、署名区块 d14（前端 FE-6）；批注触发的局部重做（A2-1b）；导演自动选曲（M1-3）。

## 6. 测试
- 单测：decide（全部就绪且可合成 → 入队 compose + composing；未配置 → compose_pending；composing 时不再派发）、时间线与字幕时间、尺寸映射、合成规格新尺寸、QA 判定。
- integ（CI）：假沙箱跑完整合成任务 → final take（cost 0、qa、credits）、项目 done、预算与 spent 不变、`studio_charges` 无新行；导出请求入队且同规格复用；失败重试后 awaiting_user；失租不产生第二个 final take。

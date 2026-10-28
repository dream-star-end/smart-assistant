# LONGCTX-RCA — W2 首轮根因与统一设计

取证基线：个人版 `origin/feat/v5-selfhost` @ `29d7af504c88b86204f3a53a3ab22ee87e4d2ccb`。仅静态代码与已有回归证据；未访问商业环境、未调用付费模型。用户信号见 USER-SIGNALS-30D §2 #10、t1031u/t1032u/t1061u；RESEARCH-PACK §2.8。不能从这些材料推断各根因当前生产占比。

## 1. 根因：三种预算不等价

模型 token 窗口、发送体 UTF-8/JSON 字节、单条附件 base64 分别限制不同边界。1M token 不等于任意大小请求。图片按固定 token 估算时，base64 仍约为原始文件的 4/3；JSON 还会转义控制字符。只把 token 窗口开到 1M、只在错误时重试或只给历史条数封顶均不能消除发送体超限。

主时间线归档不是模型压缩：`storage/sessionsDb.ts` 的热尾巴和归档保证显示/存储；原生 runner 保有独立历史。`sessionSubmit.ts` 只在无法 resume/切引擎时注入 master history，原生 resume 的完整请求在 CLI 内组装。

## 2. 按引擎

| 引擎/路径 | 限制与权威 | 当前压缩/截断 | 硬失败与缺口 |
|---|---|---|---|
| claude-code / CCB 普通 OAuth、static | CCB `utils/context.ts` 从模型/descriptor 取窗口；`autoCompact.ts` 为摘要留最多 20k，buffer 为 13k/30k/50k；proxy `shared.ts` legacy messages 8MiB、system/tools 各 2MiB、总 16MiB | native auto/reactive compact、microcompact；media 只按条数最多 100 项剔最旧；compact 摘要请求会去掉图片/文档；连续失败 3 次停自动压缩 | `PAYLOAD_TOO_LARGE`/`BODY_FIELD_TOO_LARGE` 可先于 token 阈值；单轮大工具结果/图片跳过阈值；摘要自身超限；ordinary reactive 只处理特定 PTL。没有通用序列化字节预算 |
| CCB / Box native | proxy 验签后 messages 16MiB、body 24MiB、system/tools 各 2MiB；native 模型归 `boxNativeRemoteContextOwnsHistory`，query 跳过本地 auto/microcompact | `utils/model/boxContextTransport.ts` 对指定模型的 messages >16MiB 时 staging 历史前缀（目标每块 4MiB）、hash 引用复用；远端 owns history | `messages.length<2` 直接发送；最后一条不 staging；单条 chunk 不能再分割；非 messages 字段无帮助。远端还有自己的 20MB/上下文限制，不能由本地 24MiB 推断可用。禁止用另一套截断破坏 Box journal/原生续接 |
| codex | app-server 原生窗口；`codexShared.ts` 老 1M twin 设置 1M/900k，GPT-6 不再强设（0.159.2 新 workspace route 会失败）；fallback null window 按 `modelHistory.ts` 258400 | native compact；`sessionTurnRunner.ts` 对 context_too_long 有界缩小 exact master suffix 重建 | request 字节未同一预检；初始超大 input 与原生旧历史不同；不能把累计 usage 当当前窗口用量；原生失败后恢复有次数上限 |
| grok | native CLI session，prompt 文件输入；master fallback 仍受 model history 的模型预算 | CLI compact checkpoint 可读 (`grokAdapter.ts` readLatestGrokNativeHandoff)；text-only 二进制 block 只发说明 | 未有统一 native 使用水位/发送体预算；read compact checkpoint 是显式换模型流程，不等于每轮自动保护；依赖 CLI 实际窗口 |
| antigravity | `antigravityAdapter.ts` stdin 完整 NDJSON <=300KiB（仓内探针 350KB 可用、1.1MB 静默空 success）；原生 conversation 在 CLI 内 | #1137 (`d3c705eb5`) 已有 `fitHistoricalContextJsonPrompt`：最终 envelope 序列化后删最旧注入条目 | 当前用户输入自身加平台/goal/preamble 超 300KiB 时仍抛 `ANTIGRAVITY_PROMPT_TOO_LARGE`；已裁减仅 log，没有压缩帧；原生 conversation token 满与本地 stdin 限制是两回事 |
| opencode-go（CCB route，非独立 engine） | `staticKeyProviders.ts` 与执行 descriptor 定窗口和 maxInputTokens；同 CCB legacy 8/16MiB 发送体闸 | 同普通 CCB 的 auto/reactive/microcompact | 1M 档不放宽字节闸；大附件/工具输出先撞消息字段；模型转换后还可能扩张 |
| cursor / sand / box、zcode | Cursor CLI 最终 argv 96KiB，独立 turn payload 与平台上下文预算；zcode argv 96KiB；sand 单独识别 overflow | 平台 slots 已有裁减/检索；master 注入按 maxPromptBytes 选后缀；text-only blocks 去二进制 | 最终 envelope 与选历史阶段不在同一计量点；native/remote 历史仍由引擎管理；argv/file/stdin 不能套用同一个数 |

关键源文件：`packages/gateway/src/sessionManager.ts:451`、`sessionSubmit.ts:1180`、`sessionTurnRunner.ts:2520`；`packages/protocol/src/modelHistory.ts`；`claude-code-best/src/query.ts:596`、`services/compact/autoCompact.ts`、`services/api/claude.ts:980`；`packages/commercial/src/http/proxy/shared.ts:270`。

## 3. 为什么已有修复没有根治

- #1137 (`d3c705eb5`) 的 UX/错误分类与 Antigravity history envelope fitting 只覆盖其识别的八行 JSON 历史块；单条当前输入不匹配可删历史，仍失败。不能再把已修的 371964-byte history 问题当新修复。
- OCV5-607 的 lossless context reference 是 Box 精确模型专用优化。历史 hash/引用复用不等于所有请求或所有引擎都无上限，也不涵盖最后一条巨大消息。
- `stripExcessMediaItems` 只有 100 个条数阈值；不到 100 张仍可超字节。摘要 stripImages 发生在已经决定 compact 之后，不能帮助触发字节压力。
- context_too_long 的 gateway 重试只覆盖 Codex 与已证明 safe 的 CCB 重建，盲目对所有错误重跑会重复工具副作用/收费，不能扩成无限自动重试。
- 原生 `compact_boundary` 当前在 `ccbMessageParser.ts` 只记布尔标志和 idle receipt 后 return，前端只得到进行中的 compacting，无法留完成痕迹。
- 个人修复未同步商业是另一条根因；本票不获准写商业分支，不能声称处理了商业现网。

## 4. 统一设计

同一 UI sessionKey 持续存在；native session id 可在有证据的安全边界轮转。预算包含 tokenWindow、outputReserve、transportBytes、attachmentInlineBytes，取当前执行 descriptor/真实 transport 权威。warning=0.8、critical=1.0；usedRatio 不截到 1，明确 dimension 和测量 scope（launch_prompt vs native_context）。

发送前按最终 wire JSON/UTF-8 计字节；先复用已有附件路径/hash，历史优先 native summary + recent tail；只有明确标注的 bounded exact suffix 可以替代旧历史，主时间线不改。新的当前用户输入不得静默删字。若单次输入无法内联，可以落在同一会话工作区的私有文件并让具备文件工具的引擎读取，告知路径/字节数；不伪装为摘要，不新建付费回合。

协议加法：`session.context_pressure {level, usedRatio, engine, dimension, scope}`；`sys.context_compacted` 带 strategy、beforeBytes/afterBytes（适用时）、droppedEntries（适用时）。观察帧只走 WS/ring，不进计费和消息块，不宣称离线持久化已实现；durable 留痕需后续接新 snapshot/tape 协议。旧端可忽略。错误沿 rf-errors 的 `context_too_long`、`request_too_large`。

## 5. 首轮切片与验收

优先做有明确本地复现、不会重放工具/触碰计费的 Antigravity 发送前硬失败：历史先按最终 envelope 裁减；仍过大的当前输入保存为文件引用（仅此引擎已证具备读文件工具），保留当前请求全文；新增 pressure/compacted 协议与回归。实现保留整个输入文件（包括存在的历史块），`droppedEntries=0`；不尝试从用户文本再次猜测/抽取当前输入。这不是生产事故占比排名；普通 CCB/Box 是后续更大覆盖面的切片，需要各自原生历史所有权与摘要失败语义共同改造，不能在 gateway 盲裁。

测试用 fake CLI 捕获 stdin，不调付费模型。覆盖超长历史、转义/中文、单条超长输入、本地路径内容与原文一致、超限平台 envelope 仍诚实失败、同 sessionKey 续聊、压力及处理完成帧顺序。逐引擎现有 adapter 定向测试验证协议加法兼容；不跑 gateway/commercial 全量。

## 6. 后续切片（未完成，不称根治）

1. CCB 普通路线按实际 API messages bytes 触发历史压缩；保留当前用户媒体与完整 tool pair；summary 请求也受预算；旧附件外置引用并验证 resume 重用。
2. Box 单条巨大消息/尾条附件传输与上游 20MB 闸协同，由 Box owner 接口实现；不另建 journal 权威。
3. Codex/Grok/Antigravity native token 水位、主动 compact，以及已证明无副作用边界的滚动 native continuation；同 engine 超长循环回归。
4. 前端压力提示、持久压缩说明与 snapshot 回放接入；生产 7 天硬失败为 0 后才能宣布 W2 完成。

## 7. 首轮实际契约与限制

- `session.context_pressure` 同时登记为 GatewayEvent 与 WS 帧；当前唯一 producer 是 Antigravity launch 边界，warning >=0.8、critical >=1。它不是所有引擎 native 上下文水位。
- `sys.context_compacted` 首轮 strategy 只有 `history_suffix`/`file_reference`，scope 固定 `launch_prompt`，必带 beforeBytes/afterBytes/droppedEntries。尚未声明 native_summary wire，因为尚未接线，后续扩 enum 是加法。
- `PAYLOAD_TOO_LARGE` 使用既有 `request_too_large` 目录分类；原有 Antigravity legacy 码仍可分类，未动 rf-errors 所有文件。
- 引用文件用工作区内随机私有目录和 mode 0600 排他创建；原文完整保留，不写入提示帧/日志。发送前失败删除本次未引用目录；成功后文件随工作区保留供原生续聊，不在回合末删掉。生命周期清理/去重是后续事项，不能任意删仍在 native 历史中引用的文件。
- 新旧帧走既有 deliver/ring、租户路由，完成帧可短期重连回放；超过 ring 窗口或进程重启后的持久显示尚待 snapshot/FE 切片。
- 全部回归使用合成输入和 fake CLI；能证明发送体预算和引用全文正确，不能证明真实模型一定执行文件读取，也不能证明上游 native conversation 无限长。

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

## 8. 第 3 片：原生 token 水位与有界续接（longctx3）

取证基线：个人 tip `cc2e5419a88fadddfaee93af8aea8172ac29169d`（#1209）。2026-10-28 UTC 在 v5-dev/个人容器 oc-v5-u3 只读查看 CLI help/version、生成协议类型；没有启动真实模型 turn。容器实际 Codex 0.159.2、Grok 1.0.62 (1474f9cbdd91)、Antigravity 1.4.0，宿主 Codex 0.161.0 不作为容器协议权威。

### 8.1 优先级和逐引擎证据

ADMIN-SESSIONS-30D §1 的30天个人口径：Codex gpt-* 150回合（36%，长回合43%）、Grok119（29%）、Antigravity37。故本片先接Codex。这是覆盖面排序，不能推导上下文故障占比。

| 引擎 | token 权威/可观测边界 | 原生压缩与当前失败行为 | 本片边界 |
|---|---|---|---|
| Codex app-server | `thread/tokenUsage/updated.tokenUsage` 的 `last:TokenUsageBreakdown` 和 `modelContextWindow:number|null`；容器0.159.2 `generate-ts` 已核对。最近调用 `last.totalTokens` 是当前窗口的近似快照（下次工具结果/输入可能继续增长），`total` 是线程累计计费，不能拿它除窗口；cachedInputTokens/推理已含在总数里，不重复加。窗口null时不造258400的原生测量值。 | 已有原生自动compact、显式`thread/compact/start`；ACK只代表受理，完成看`contextCompaction` item以及内部turn终态。既有手动换模型`compactForHandoff()`读取rollout里的原生摘要。context_too_long 在sessionTurnRunner走有限次数exact master suffix重建；失败后不允许无界重放工具。 | 已实现：当前线程水位+原生完成事件，在下一用户turn发出前用原生compact继续同线程；不改已有故障恢复重放次数。 |
| Grok CLI | 当前`--output-format streaming-json`适配层只消费usage/end的`usage`，`grok usage <session> [turn]` help明确为持久累计/按turn费用统计；已接入协议没有证明为当前上下文的token计数和窗口，不能直接拿lastUsage当水位。 | 原生compact checkpoint可从`~/.grok/sessions/<group>/<uuid>/compaction_checkpoints/*.json`读取，schema_version=1且compacted_history含原生summary carrier；现行换模型流程走`/compact`，读checkpoint不代表常规每轮水位管理。CLI help没有独立compact子命令。error/end进入adapter终态，无法据此证明未执行过工具，不新增盲重试。 | 仍需核实ACP的原生context统计、headless compact命令成功终态及计费边界，再接主动压缩；此次保持适配层兼容测试，不伪报已覆盖。 |
| Antigravity native conversation | `step_update.agent_response` DONE的`step.usage`为每次调用，adapter求和为本turn展示值；`result.usage`跨`--conversation`累计。已捕获fixture和1.4.0 CLI help没有原生窗口/当前上下文总量。每call input是否含cache不能仅凭字段名猜。 | 当前help没有显式compact/summary子命令；不能由“未见接口”断言底座绝无自动压缩。`error_message`/result非SUCCESS走失败；旧conversation错误按step_index过滤。300KiB envelope fitting/file_reference仅保证stdin边界，完全不证明native conversation安全。 | 后续需native统计/压缩协议，或在已证明无副作用的新用户turn边界做有界master续接；此次不凭累计usage切断native conversation。 |

代码锚点：`engine/codexAppServerNotifications.ts` tokenUsage与contextCompaction分支、`codexAppServerRunner.ts::compactForHandoff`；`grokAdapter.ts::grokUsage/readLatestGrokNativeHandoff/finish`；`antigravityAdapter.ts::handleStep/handleResult`；`sessionTurnRunner.ts` context_too_long恢复分支。补充官方协议说明：[Codex App Server](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)明确compact RPC立即ACK、随后由item/turn流报告进展；本地固定版本仍为实现依据。

### 8.2 实际契约与验收范围

`session.context_pressure`沿用scope=native_context、dimension=tokens，warning>=0.8、critical>=1，ratio允许>1；只表示已观测边界，未知窗口不发虚假安全值。`sys.context_compacted`新增native_summary分支（仅native_context，beforeTokens可选），保留旧字节分支原样；token未测得则不虚构前后字节/丢弃条数。成功事件不等于模型历史全文无损，也不等于生产无限续聊已验收。

以fake app-server合成接近/超过上限和累计usage很高但当前很低的线程，证明触发、帧顺序、同线程继续、失败/取消无伪成功、当前输入只发送一次和账本delta不变。Grok/Antigravity跑既有adapter定向用例。所有测试通过rf-heavy排队；不跑付费回合，不碰Box和#1209请求预算。最终覆盖、实跑证据及剩余项以CONTINUE更新为准。


### 8.3 实现与未覆盖边界

- 新模块`codexNativeContext.ts`持有线程水位和压缩状态；同一线程最新快照达到80%后，下一用户turn发出前调用`thread/compact/start`。ACK与匹配的contextCompaction item完成、内部turn成功均满足才发完成帧并继续原线程。自动compact也按匹配item生命周期发完成帧；去重不影响原来的compacting工具卡。
- 15分钟既有native compact期限覆盖缺ACK/缺完成；Stop、超限、进程退出和外部shutdown都不发送排队中的当前用户输入，不报伪成功。失败先关闭并排空原进程输出，再沿既有终态记录原错误和usage；无新自动重试循环。
- 计费仍用同一累计total差值；summary和随后的用户调用属于这次逻辑turn。内部compact turn不会提前完成用户turn；晚到usage在stdout关闭前仍进入原账本。外部shutdown入口捕获结算归属，避免微任务竞态清掉尚未消费的usage。
- 水位保存在热runner中，重启/新runner未取得有效快照前不主动判断；模型变化清空旧水位。`last`只是最近调用的近似占用，新输入/工具结果可能继续增大；本片不保证巨型单次输入安全，也不保证原生摘要调用一定成功。原生压缩失败仍诚实失败，由既有有限恢复路径处理。
- Grok/Antigravity只完成协议取证与既有adapter兼容回归范围，尚未实现其原生水位/主动compact/滚动续接。它们需要可验证的context统计和headless compact终态，或另行证明安全的master续接边界。Box native与普通CCB字节预算均未修改。
- 新回归覆盖80%/100%阈值、累计值非分母、未知窗口、同线程输入仅发一次、内部turn隔离、缺ACK超时、Stop、失败和外部shutdown的晚到usage；只用fake app-server，不跑付费模型。独立方案审查APPROVED；代码第3/3轮APPROVED（前两轮具体P1已修复）。本机检查经rf-heavy排队，最终实跑与精确HEAD CI证据见`CONTINUE-20261029-rf-longctx3.md`，未把静态审查当测试通过。
- 观察帧仍走既有WS/ring；跨进程重启的持久显示、前端提示、真实长会话回归和生产7天零硬失败不在本片完成声明中。W2整体仍未完成。

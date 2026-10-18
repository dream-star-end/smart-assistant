# OCV5-498：个人版非 Codex 模型首字延迟测量与优化方案（2026-10-18）

**测量完成，优化尚未实施，等待用户批准。** 18 次计划内普通网页发送中，16 轮完成；Box Haiku、GLM 各首轮失败，因此未发其追问。另有 1 个网页自动恢复帧，无新增 dispatch／模型调用。按实际日志合计 **26 次模型执行尝试**，其中 Box 的 3 次在本地前置阶段失败、没有送达模型供应商；其余 23 次送达上游，含 GLM 的 3 次 429。实扣 **175 积分（管理员金额 ¥1.75）**，全钱包 35356 → 35181，逐行冻结价、结算与流水一致。

本轮只测量、读代码、整理文档；没有改现网配置／路由、模型目录、默认思考档、账号额度或注册设置，没有合并、发布、迁移、删除或手工改账。未操作 cc1、其它 tmux 或商业版，未连接商业生产机。独立 worktree／文档 PR 用于审阅，不包含产品代码修改。

**测量方法与覆盖。** 沿用 用户提供的 TTFT-FULL-20261018.md（[既有计时 PR #843](https://github.com/dream-star-end/smart-assistant/pull/843)）、用户提供的 TTFT-845-RELEASE-20261018.md（[PR #845](https://github.com/dream-star-end/smart-assistant/pull/845)） 的身份和时间口径。账号 765，数据库 role=user；真实网页登录 → 新建对话 → 菜单选模型 → 输入 → 点击发送 → 同会话追问。首轮使用“你好，简单介绍一下你能帮我做什么。”，追问使用“我今天想把工作安排得轻松一点，你有什么建议？”。首轮保留 2 秒阅读、每字符 90ms 输入；没有等待模型 ready、注入 token、改写 WS／请求正文或构造上下文梯度。Kimi 1M 通过正常上下文菜单及费用确认，Grok Fast 通过正常速度开关。

采样实际发送在 10:29–10:43 UTC（18:29–18:43 UTC+8）；最终账务窗口为 **10:29:17.248593–10:48:15.002743 UTC**。部署宿主上的 headless Chromium 走个人版 loopback，因此包含真实网页／网关／引擎路径，不代表用户公网、终端性能或物理屏幕。账号容器 1062 由 10:28 的普通登录自然唤起，全部成功样本均是**热容器、新对话首轮或同会话追问**；没有人为停止／重建容器，未测冷容器和新注册。

现网保持 #845：`67d13462edea57d43e71aae2a97d51efddcff831`，live `rel-67d13462e-20261018-091329`。16 个成功 trace 的 runtime source 均为该 SHA；容器实际挂载 runtime `rel-23c7b626c7c4`、bundle `50ba5be8f5a0`，前后编译哈希一致。失败 trace 没有完整 runtime 元数据，未冒称其字段齐全。证据：[运行身份](./TTFT-OTHERS-20261018-evidence/postbrowser-runtime-proof.json)。

公开目录与账号实际菜单逐项核对后，六个可用家族包含八个非 Codex ID，本轮全部尝试。账号无权选择 Box Opus/Sonnet；28 个 Go 模型均 aria-disabled=true、显示“暂不可用”，未绕过界面、扩权或启用供应商。Astra 虽此前未测，engine=codex，按“除 Codex CLI”排除；Sol/Luna 及其上下文变体也排除。完整菜单清点见 [UI inventory](./TTFT-OTHERS-20261018-evidence/ui-inventory.json) 与 [目录](./TTFT-OTHERS-20261018-evidence/logged-models.json)。

**正文首字结果。** TTFT 从网页 payload.ts 起算，到浏览器观察到该轮首个非空正文块为止；推理、空 delta、ping 和错误文案均不算成功首字。下面 p50 只是组内样本中位数，每类通常只有 1–2 个新对话，不是总体分位数。单位秒。

| 模型／ID | 首轮／追问成功数 | 首轮 p50 / 最慢 | 追问 p50 / 最慢 | 本轮实扣积分 |
|---|---:|---:|---:|---:|
| Box Haiku 5.5 `box-claude-haiku-5-5` | 0 / 0 | 失败／未测 | 失败／未测 | 0 |
| GLM-5.3 Z.AI `glm-5.3-zai` | 0 / 0 | 失败／未测 | 失败／未测 | 0 |
| Kimi K3 256K `k3-256k` | 2 / 2 | 13.275 / 14.296 | 13.045 / 16.232 | 32 |
| Kimi K3 1M `kimi-k3` | 1 / 1 | 21.287 / 21.287 | 22.829 / 22.829 | 14 |
| DeepSeek V4.1 Flash `deepseek-v4-flash` | 2 / 2 | 7.872 / 8.024 | 9.907 / 11.808 | 10 |
| Grok 4.7 `grok-build` | 1 / 1 | 21.787 / 21.787 | 22.279 / 22.279 | 47 |
| Grok 4.7 Fast `grok-build-fast` | 1 / 1 | 18.577 / 18.577 | 11.096 / 11.096 | 63 |
| Gemini 3.8 Flash `antigravity-gemini-3.8-flash` | 1 / 1 | 13.200 / 13.200 | 9.413 / 9.413 | 9 |

Box Haiku 在 **21.355 秒**返回 `model_capacity`，GLM 在 **15.462 秒**返回 `rate_limited`；失败正文虽可能通过 text block 传输，已从成功 TTFT 排除。两者不能据此宣称模型推理慢，首轮成功与追问仍未覆盖。

Grok 普通档追问自发执行 5 次工具调用、3 次模型调用；Fast 追问为 1 次工具调用、2 次模型调用。其它 14 轮成功样本 runtime_tool_calls=0。没有主动要求这些工具。Fast 与普通档仅各一组、时间／缓存／工具行为不同，首轮 3.210 秒、追问 11.183 秒的观察差不能当作 Fast 的因果收益；费用分别为普通档 16/31、Fast 33/30 积分。

**各阶段分解。** 下表每格为该模型、该轮次组内中位数，单位秒。≈为同宿主墙钟／日志锚点复原，不能当单调时钟精度；各列独立中位数不能相加。gateway→submit 与 submit 内的锁／屏障使用已有 elapsedMs。最后大段仍混有 CLI、代理、模型和回传，名称保留“剩余段”，不冒称供应商计算时间。

| 模型／轮次(n) | 提交→gateway≈ | gateway→submit | submit→context | context→master 首正文剩余≈ | master→浏览器≈ | 正文 TTFT |
|---|---:|---:|---:|---:|---:|---:|
| Kimi K3 256K首轮(2) | 0.432 | 0.156 | 0.091 | 12.505 | 0.091 | 13.275 |
| Kimi K3 256K追问(2) | 0.310 | 0.175 | 0.148 | 12.126 | 0.285 | 13.045 |
| Kimi K3 1M首轮(1) | 0.433 | 0.144 | 0.102 | 20.384 | 0.224 | 21.287 |
| Kimi K3 1M追问(1) | 0.245 | 0.105 | 0.146 | 21.012 | 1.321 | 22.829 |
| DeepSeek V4.1 Flash首轮(2) | 0.378 | 0.172 | 0.089 | 6.753 | 0.480 | 7.872 |
| DeepSeek V4.1 Flash追问(2) | 0.415 | 0.147 | 0.144 | 7.469 | 1.731 | 9.907 |
| Grok 4.7首轮(1) | 0.392 | 0.137 | 0.078 | 21.099 | 0.081 | 21.787 |
| Grok 4.7追问(1) | 0.461 | 0.140 | 0.115 | 21.499 | 0.064 | 22.279 |
| Grok 4.7 Fast首轮(1) | 0.527 | 0.167 | 0.126 | 17.683 | 0.074 | 18.577 |
| Grok 4.7 Fast追问(1) | 0.373 | 0.137 | 0.158 | 10.406 | 0.022 | 11.096 |
| Gemini 3.8 Flash首轮(1) | 0.609 | 0.188 | 0.100 | 12.190 | 0.113 | 13.200 |
| Gemini 3.8 Flash追问(1) | 0.381 | 0.325 | 0.130 | 8.506 | 0.071 | 9.413 |

16 轮成功样本的 submit 锁／内存屏障／屏障后上下文准备 p50 分别 **29.684 / 46.551 / 29.472ms**，三者逐轮合计 **76.781–173.229ms**。它们不是目前数秒至十几秒等待的主要来源。提交→master p50 302ms，master→gateway p50 80.242ms，gateway→submit p50 152.470ms。

master 首正文是服务端在容器出站帧、发给浏览器之前记录的 `first_text_frame`，可用同 trace 的 friction 记录旁证；不是网页上传的绘制指标。master→浏览器观察 p50 104ms，范围 22–2876ms。DeepSeek A 追问曾达 2.876s，Kimi 1M 追问 1.321s，未取得足够边界区分浏览器／CDP 回调滞后与传输／调度，不把它们抹平或称为纯网络。

共同链按 sessionId+clientMessageId → 唯一 dispatch → 不可变 trace 精确连接，未按“同账号、时间相近”猜测。CLI 子阶段缺失不能由链路闭合反推补齐；完整逐轮字段、缺失值和原始边界见 [timing-analysis](./TTFT-OTHERS-20261018-evidence/timing-analysis.json)。

**引擎内瓶颈与不确定部分。**

| 引擎／模型 | 本轮证据 | 能下的结论 |
|---|---|---|
| CCB／Kimi 256K、1M | context_ready→首个 journal 事务锚点≈4.544–5.270s；fetch→首 SSE 非空字节 1.680–5.093s | 逐轮 CLI 准备与上游等待均明显。1M 的首推理 7.824/6.813s，正文 21.287/22.829s，仍有约13.5/16.0s的推理到正文窗口，不能把首 SSE 当正文。 |
| CCB／DeepSeek | 前置段≈4.356–5.096s；fetch→首 SSE 字节仅0.470–0.542s | 相比上游首字节，前置 CLI／代理准备更大；SSE 后仍可有推理和正文等待，且有一例浏览器观察滞后。 |
| Grok 普通／Fast | 首推理5.238–6.487s，正文11.096–22.279s；没有 fetch/headers/首正文的独立 relay 时序 | 可分辨早期启动／首推理等待与后续推理窗口；尚不能把任一段独占归给 Grok 服务器。start()为空实现、每轮spawn CLI，放开草稿预热不会直接消掉启动。 |
| Antigravity／Gemini | 正文13.200/9.413s；每轮spawn CLI；首轮2次relay，追问1次 | CLI与上游混合段为主要等待，内部 fetch 边界缺失。首轮另有 checkpoint 轻模型调用；既往文档识别为标题生成，但未证明串行阻塞首字，也没有现成关闭开关。 |
| Box Haiku | 三次 `BOX_TARGET_UNAVAILABLE/ENOENT`，均在 target resolver 失败 | 账号765缺个人出口目录/文件，且未配置unbound-host策略；尚未stage、launch或接触模型供应商。UI的capacity标签误导；成功TTFT未知。 |
| GLM Z.AI | 三次到供应商后均 HTTP429/RATE_LIMITED | 当前首要是供应商拒绝服务；没有成功首字／追问样本。 |

上述 journal 时间是事务 NOW() 锚点，不是 CLI ready 或 fetch start；只给近似区间。Grok 的 journal 在 context_ready 之前建立，甚至产生负差，故不把该差用作 Grok 启动分段。`turn_upstream_performance.ttft_ms` 是 fetch 到首个非空 SSE 字节，可能只是 message_start／ping；`stream_ms` 包含 TTFT，落库 observed_at 还有异步延迟，不能用 observed_at−stream_ms 精确倒算 fetch。

Kimi／DeepSeek 本次实际使用 **official-cc harness**。追问在 context_ready 后仍有 `subprocess shutdown requested, harness=official-cc`，然后重新构建 prompt；每轮 authority headers／turnKey 改变使 spawn fingerprint 改变，官方 CLI 不能从 stdin 热更新鉴权，所以会 shutdown+resume。约5秒组合段不能直接归因某个固定5秒timeout。#845 草稿入口写死 codexOnly；即使放开它，official-cc 的 preheat 目前也明确 no-op，不能声称复制 Codex 预热就省5秒。

平台 prompt_context 约9264–9421估算token，构建约0.1–0.3s；AGENTS约3.25–3.34K、INTELLIGENT_UI2.545K、SKILLS1.568K、TOOLS1.197K、MEMORY0.575K。账单输入还包含原生CLI系统提示／工具schema等，不能把约27–30K输入全部当作平台提示，也不能把token减少比例当作秒数减少比例。完整数字在 [gateway安全计时](./TTFT-OTHERS-20261018-evidence/gateway-timing.jsonl) 与账务逐行中。

默认思考口径：网页均显式 effortLevel=null。目录default_effort为GLM=max、Grok普通/Fast=high、Gemini=medium，其余本轮ID为空。GLM可由API代理补默认；Gemini明确映射至medium模型。Grok的null经adapter不传--reasoning-effort，目录high没有在该路径自动注入，闭源CLI最终effective档未采集。DeepSeek Flash没有可用思考档，不能提出降到low来提速。

**现有首绘制探针失真。** CCB/Grok 的流式正文先在 ProcessDisclosure 的过程区渲染，那里没有 FirstTextPaintCommitProbe；等转为独立 MessageRenderer 后才可能触发探针。Kimi A首轮正文帧12.253s、现有paint24.465s，追问9.857/22.355s；这不是12秒渲染阻塞的证据。

第二批起加入纯只读 MutationObserver + 双rAF，记录非空字数、矩形和安全节点key，不存正文。只接受本轮 `process:<clientMessageId>` 正文节点，或节点key与该轮正文messageId精确相等的assistant节点；B版fallback可能误认旧节点重挂的反例已通过身份过滤，未验证节点不采用。12个成功样本具有通过身份核对、位于视口内的正文DOM观测：浏览器正文帧→DOM p50 **190.5ms**，范围 **88–389ms**。

| DOM复核样本 | 正文帧s | 非空正文DOM双rAF s | 旧paint探针s |
|---|---:|---:|---:|
| Grok 4.7 grok-b 第1轮 | 21.787 | 22.176 | — |
| Grok 4.7 grok-b 第2轮 | 22.279 | 22.580 | — |
| Gemini 3.8 Flash gemini-b 第1轮 | 13.200 | 13.317 | 13.317 |
| Gemini 3.8 Flash gemini-b 第2轮 | 9.413 | 9.683 | 9.801 |
| Kimi K3 1M kimi-1m-c 第1轮 | 21.287 | 21.466 | 24.466 |
| Kimi K3 1M kimi-1m-c 第2轮 | 22.829 | 22.917 | — |
| Grok 4.7 Fast grok-fast-c 第1轮 | 18.577 | 18.707 | 23.099 |
| Grok 4.7 Fast grok-fast-c 第2轮 | 11.096 | 11.236 | — |
| Kimi K3 256K kimi-d 第1轮 | 14.296 | 14.532 | 24.125 |
| Kimi K3 256K kimi-d 第2轮 | 16.232 | 16.516 | — |
| DeepSeek V4.1 Flash deepseek-d 第1轮 | 7.719 | 7.905 | 15.005 |
| DeepSeek V4.1 Flash deepseek-d 第2轮 | 8.005 | 8.200 | — |

例如Kimi D首轮DOM14.532s、旧探针24.125s，DeepSeek D首轮DOM7.905s、旧探针15.005s：旧探针分别晚9.593/7.100s。修探针能纠正报表，**实际用户提速为0秒**。DOM双rAF仍是浏览器代理值，不是物理屏幕。

**待批准的优化顺序。** 以下预计收益不是已上线效果；小样本、未实施的部分不作保证，各步不简单叠加。

| 步骤 | 预计可省秒数／依据 | 风险与实施边界 |
|---|---|---|
| 1. 修正过程区首正文绘制计量，给非Codex补CLI spawn/ready、proxy收到、precheck、fetch/headers/首text边界 | 实际提速0s；纠正已验证DOM相对旧探针3–9.593s的延后；帧→旧探针差最大12.498s，两个典型DOM偏差为9.593/7.100s | 低；一次性trace标记需防重复与旧轮节点串联，不记录正文／凭据。先取得可靠启动预算。 |
| 2. 对确定缺失的Box出口配置返回明确不可重试错误；对供应商429按明确重试语义／Retry-After处理，避免本轮同样原样连打 | 同类失败可少等Box **7.828s**、GLM **8.374s**（第一次到最后一次失败间隔），尝试3→1；成功TTFT收益0s／未测 | Box分类低风险；429策略中风险，过早终止可能损失瞬时限流后成功的机会，不能把普通网络波动／5xx一并禁重试。 |
| 3. 单独批准账号765的Box正常出口开通／绑定，再复测首轮+追问 | 恢复可用性；成功TTFT目前未知，不能承诺省21.355s。若只做更早配置校验，确定缺失时失败可由21.355s降到一次校验时间，须实测 | 涉及配置／路由，必须另批；不借u3／cc1身份，不更改Box登录或全局出口策略，不以host fallback绕过现有要求。 |
| 4. 先缓存／前置可复用的静态prompt与MCP投影；再拆分official-cc每轮约4.356–5.270s准备段 | 静态构建单独可省 **0–0.3s/轮**，上限来自现有构建时长；直接放开Codex式preheat对本轮official-cc收益0s | 静态缓存中低风险，要按权限、模型、工具／技能／记忆版本失效。不得删除AGENTS安全约束或将上轮鉴权复用。 |
| 5. 如启动细分证明值得，再设计可安全换绑每轮authority的常驻CLI／本地代理协议 | 当前组合段给出 **0–约5.3s/轮的研究上限**；不是可兑现点估计，测清其中可消除比例后才报实施收益 | 高；跨权限、隔离、计费、停止、resume和并发，不能简单删shutdown/fingerprint；需证明旧轮令牌不泄漏、计费归属不串轮。 |
| 6. 普通聊天提供用户明确选择的低思考／Fast档A/B | Fast本批观察差首轮3.210s、追问11.183s，非因果承诺；低思考收益本轮未测，可省0s，尚无可靠点估计 | 中；速度档增加费用，低思考可能影响复杂任务质量。只测支持的模型，显式会话选择，不改全局默认；Grok当前CLI真实默认档仍未知。 |
| 7. 对轻量聊天评估按需加载智能UI／技能摘要 | 已证实收益0s，预期减少至多约2.5K UI说明及部分1.6K技能估算token；尚不能可靠折算秒数 | 中高；会改变界面生成、技能发现与回答能力，保留权限／隔离、记忆和必要工具；小流量A/B取得秒数后再决定。 |

建议先批准1、2的实现与验证，以及3的单独开通核验；4可作为小幅准备优化。5、6、7先做有预算的方案／A/B再决定。Grok/Antigravity start为空实现，Box已批量stage，100ms spool轮询和Grok Fast目录命令的8秒超时均不当作已经证实的秒级收益；不默认跳过Gemini checkpoint。

**扣费与请求数对账。** 窗口全账号只有本批16条收费usage／16条扣款，合计175积分，余额35356→35181；无额外流水、退款、免单、clamp、未结journal或代付。每行使用冻结snapshot的四类token×费率×倍率，Decimal向上取整；未拿当前目录价代替旧snapshot，未把供应商估算美元当现金账单。

| 范围 | 计划网页发送 | 执行尝试／模型调用 | 收费usage | 积分 |
|---|---:|---:|---:|---:|
| Box Haiku失败 | 1 | 3（均未launch至供应商） | 0 | 0 |
| GLM 429失败 | 1 | 3（均供应商拒绝） | 0 | 0 |
| Kimi 256K | 4 | 4 | 4 | 32 |
| Kimi 1M | 2 | 2 | 2 | 14 |
| DeepSeek | 4 | 4 | 4 | 10 |
| Grok普通 | 2 | 1+3=4 | 2 | 47 |
| Grok Fast | 2 | 1+2=3 | 2 | 63 |
| Gemini | 2 | 首轮2+追问1=3 | 2 | 9 |
| 合计 | **18** | **26** | **16** | **175** |

Box/GLM共6条journal均aborted、无usage／ledger；不能把precheck预留当实扣。其它CCB/Grok共14条journal committed，final_credits、usage、主ledger_id及所有桶一致。Antigravity按既有独立协议：**3条relay用量 → 2条antigravity_turns settled/success → 2条usage → 2条ledger**，不产生request_finalize_journal；不能以缺journal判为未收费，也不能为了凑三表人工补账。Gemini首轮checkpoint+agent合计32223输入／501输出，4积分；追问32785输入／531输出，5积分。

Grok原生usage.json的modelCalls与events.jsonl loop_started总数4/3相符。原生input包含cache，DB已分开；输出已包含reasoning，未重复相加。共18个唯一模型dispatch，无手工重发；19个传输帧中另1个 `m-recover-1mfcxaeilrwsu` 没有新增dispatch或收费记录。26次执行尝试中包括3次未接触供应商的Box前置失败；确认送上游23次，其中成功20次、429三次。Codex背景仅目录GET，无推理POST，不混入本批模型调用。供应商现金实扣未取得。

钱包核验包括全账号ledger_count 1806→1822、每桶逐行balance_after与整个id区间集合；额外流水、桶差、选定集合出窗均0。最终在途dispatch=0，没有手工清理旧失败记录。Box/GLM最终被平台reconciler标为terminal/crashed、failure_code=SERVICE_RESTART；这不是本轮实施过重启的证据，报告保留其与浏览器原始错误的区别。

证据：[逐行账务](./TTFT-OTHERS-20261018-evidence/billing-analysis.json)、[全部安全账务行](./TTFT-OTHERS-20261018-evidence/billing-all.json)、[钱包审计](./TTFT-OTHERS-20261018-evidence/wallet-audit.json)、[失败codes](./TTFT-OTHERS-20261018-evidence/error-analysis.json)、[Grok原生计量](./TTFT-OTHERS-20261018-evidence/grok-native-usage.json)、[Fast原生计量](./TTFT-OTHERS-20261018-evidence/grok-fast-native-usage.json)。

**采样异常与覆盖缺口。** A批DeepSeek追问因旧paint探针缺失触发observer超时，但模型已完成并收费；首正文事件11.808s与对应dispatch/usage完整保留，已恢复进统计，无重发。B批在1M费用确认、C批在菜单非唯一selector处停止，均发生于对应待发轮之前；只续测未发送的变体／新对话，没有把脚本错误当产品错误或剔除已收费轮。各批失败与原始事件保留。最终观测脚本副本为D版；未保存A/B/C各批完整脚本哈希，不把D版冒充它们。

Box Opus/Sonnet、28个Go模型、旧cursor/Sand路线因普通账号界面不可用而未测；Box Haiku/GLM未取得成功首轮及追问。未测冷容器、新注册、WAN、手机、项目／团队／跨标签、显式低思考、长上下文压力或供应商长尾分布。没有单独量化native CLI boot、MCP握手、Grok/Gemini fetch子段和供应商内部计算；约5秒段与未来优化收益不假装已完成根因细分。

代码依据（本轮只读，基线67d13462e）：`packages/gateway/src/subprocessRunner.ts`（official-cc fingerprint／重启／preheat）、`packages/commercial/src/dispatch/enginePreheatPreparation.ts`（codexOnly）、`packages/commercial/src/http/proxy/boxAccountResolver.ts`（uid出口前置）、`packages/commercial/src/ws/turnPerformance.ts`（首帧）、`packages/web-react/src/components/chat/ProcessDisclosure.tsx` 与 `MessageRenderer.tsx`（过程区／最终区绘制探针）、`packages/gateway/src/engine/grokAdapter.ts`／`antigravityAdapter.ts`（每轮CLI）、`packages/commercial/src/billing/antigravitySettle.ts`（独立结算）。

远端证据：`H/g498-ttft-others-20261018`；交接：`H/CONTINUE-20261018-OCV5-498-TTFT-OTHERS.md`，H=`/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308`。只保存安全数字元数据、ID和代码，不包含口令、密钥、完整env、完整请求头或回答正文。独立复核结果保存在同名evidence目录。

10:52:33Z 最终只读核对：个人版stable／slot A／candidate空，health依赖均正常，版本仍67d13462e、canonical clean、env键数121；10:52:35Z列车FREE。见[最终运行状态](./TTFT-OTHERS-20261018-evidence/final-operational-proof.json)和[执行次数核算](./TTFT-OTHERS-20261018-evidence/request-counts.json)。

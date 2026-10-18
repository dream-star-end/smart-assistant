# OCV5-498：个人版非 Codex 模型首字延迟测量与优化方案（2026-10-18）

**原始测量完成；19:12 批准后的实施与验收进展见文末。** 18 次计划内普通网页发送中，16 轮完成；Box Haiku、GLM 各首轮失败，因此未发其追问。另有 1 个网页自动恢复帧，无新增 dispatch／模型调用。按实际日志合计 **26 次模型执行尝试**，其中 Box 的 3 次在本地前置阶段失败、没有送达模型供应商；其余 23 次送达上游，含 GLM 的 3 次 429。实扣 **175 积分（管理员金额 ¥1.75）**，全钱包 35356 → 35181，逐行冻结价、结算与流水一致。

原始测量阶段只测量、读代码、整理文档；没有改现网配置／路由、模型目录、默认思考档、账号额度或注册设置，没有合并、发布、迁移、删除或手工改账。未操作 cc1、其它 tmux 或商业版，未连接商业生产机。独立 worktree／文档 PR 用于审阅，不包含产品代码修改。

**测量方法与覆盖。** 沿用工作区 `TTFT-FULL-20261018.md`、`TTFT-845-RELEASE-20261018.md` 的身份和时间口径；对应 [#843 计时](https://github.com/dream-star-end/smart-assistant/pull/843)、[#845 预热验证](https://github.com/dream-star-end/smart-assistant/pull/845)。账号 765，数据库 role=user；真实网页登录 → 新建对话 → 菜单选模型 → 输入 → 点击发送 → 同会话追问。首轮使用“你好，简单介绍一下你能帮我做什么。”，追问使用“我今天想把工作安排得轻松一点，你有什么建议？”。首轮保留 2 秒阅读、每字符 90ms 输入；没有等待模型 ready、注入 token、改写 WS／请求正文或构造上下文梯度。Kimi 1M 通过正常上下文菜单及费用确认，Grok Fast 通过正常速度开关。

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

原始窗口中，Box Haiku 在 **21.355 秒**返回 `model_capacity`，GLM 在 **15.462 秒**返回 `rate_limited`；失败正文虽可能通过 text block 传输，已从成功 TTFT 排除。两者不能据此宣称模型推理慢。批准开通出口后的 Box 成功首轮和追问见文末；GLM 尚无成功样本。

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

Kimi／DeepSeek 的平台 prompt_context 为9264／9421估算token，Grok／Gemini为9786；16条构建计时为63.957–182.511ms，p50 121.230ms。CCB组件示例：AGENTS约3.25–3.34K、INTELLIGENT_UI2.545K、SKILLS1.568K、TOOLS1.197K、MEMORY0.575K。账单输入还包含原生CLI系统提示／工具schema等，不能把约27–30K输入全部当作平台提示，也不能把token减少比例当作秒数减少比例。完整数字在 [gateway安全计时](./TTFT-OTHERS-20261018-evidence/gateway-timing.jsonl) 与账务逐行中。

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

**原始优化方案（19:12–19:14 批复前）。** 以下保留最初提案，最终实现范围和验收状态见文末；第 2 步已按批复保留透明 429 自动重试，第 7 步已收窄为不改内容和顺序的等价处理优化。以下预计收益不是已上线效果，各步不简单叠加。

| 步骤 | 预计可省秒数／依据 | 风险与实施边界 |
|---|---|---|
| 1. 修正过程区首正文绘制计量，给非Codex补CLI spawn/ready、proxy收到、precheck、fetch/headers/首text边界 | 实际提速0s；纠正已验证DOM相对旧探针3–9.593s的延后；帧→旧探针差最大12.498s，两个典型DOM偏差为9.593/7.100s | 低；一次性trace标记需防重复与旧轮节点串联，不记录正文／凭据。先取得可靠启动预算。 |
| 2. 对确定缺失的Box出口配置返回明确不可重试错误；对供应商429按明确重试语义／Retry-After处理，避免本轮同样原样连打 | 同类失败可少等Box **7.828s**、GLM **8.374s**（第一次到最后一次失败间隔），尝试3→1；成功TTFT收益0s／未测 | Box分类低风险；429策略中风险，过早终止可能损失瞬时限流后成功的机会，不能把普通网络波动／5xx一并禁重试。 |
| 3. 单独批准账号765的Box正常出口开通／绑定，再复测首轮+追问 | 恢复可用性；成功TTFT目前未知，不能承诺省21.355s。若只做更早配置校验，确定缺失时失败可由21.355s降到一次校验时间，须实测 | 涉及配置／路由，必须另批；不借u3／cc1身份，不更改Box登录或全局出口策略，不以host fallback绕过现有要求。 |
| 4. 先缓存／前置可复用的静态prompt与MCP投影；再拆分official-cc每轮约4.356–5.270s准备段 | 静态prompt构建单独可省 **0–0.18s/轮**，上限来自本批构建时长；MCP投影尚未独立量化；直接放开Codex式preheat对本轮official-cc收益0s | 静态缓存中低风险，要按权限、模型、工具／技能／记忆版本失效。不得删除AGENTS安全约束或将上轮鉴权复用。 |
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

Grok原生usage.json的modelCalls与events.jsonl loop_started总数4/3相符。原生input包含cache，DB已分开；输出已包含reasoning，未重复相加。共18个唯一模型dispatch，无手工重发；19个传输帧中另1个 `m-recover-1mfcxaeilrwsu` 没有新增dispatch或收费记录。26次执行尝试中包括3次未接触供应商的Box前置失败；确认送上游23次，其中成功20次、429三次。Codex背景仅目录GET，无推理POST，不混入本批模型调用。调用数来自产品与原生CLI模型计数，不是逐包HTTP审计；供应商现金实扣未取得。

钱包核验包括全账号ledger_count 1806→1822、每桶逐行balance_after与整个id区间集合；额外流水、桶差、选定集合出窗均0。最终在途dispatch=0，没有手工清理旧失败记录。Box/GLM最终被平台reconciler标为terminal/crashed、failure_code=SERVICE_RESTART；这不是本轮实施过重启的证据，报告保留其与浏览器原始错误的区别。

证据：[逐行账务](./TTFT-OTHERS-20261018-evidence/billing-analysis.json)、[全部安全账务行](./TTFT-OTHERS-20261018-evidence/billing-all.json)、[钱包审计](./TTFT-OTHERS-20261018-evidence/wallet-audit.json)、[失败codes](./TTFT-OTHERS-20261018-evidence/error-analysis.json)、[Grok原生计量](./TTFT-OTHERS-20261018-evidence/grok-native-usage.json)、[Fast原生计量](./TTFT-OTHERS-20261018-evidence/grok-fast-native-usage.json)。

**采样异常与覆盖缺口。** A批DeepSeek追问因旧paint探针缺失触发observer超时，但模型已完成并收费；首正文事件11.808s与对应dispatch/usage完整保留，已恢复进统计，无重发。B批在1M费用确认、C批在菜单非唯一selector处停止，均发生于对应待发轮之前；只续测未发送的变体／新对话，没有把脚本错误当产品错误或剔除已收费轮。各批失败与原始事件保留。最终观测脚本副本为D版；未保存A/B/C各批完整脚本哈希，不把D版冒充它们。

Box Opus/Sonnet、28个Go模型、旧cursor/Sand路线因普通账号界面不可用而未测；原始窗口的Box Haiku/GLM未取得成功首轮及追问，批准后已补齐Box成功两轮。未测新注册、WAN、手机、项目／团队／跨标签、显式低思考、长上下文压力或供应商长尾分布。追加窗口经历普通登录自然唤醒容器，但没有冷容器下的完整成功对照。没有单独量化native CLI boot、MCP握手、Grok/Gemini fetch子段和供应商内部计算；约5秒段与未来优化收益不假装已完成根因细分。

代码依据（本轮只读，基线67d13462e）：`packages/gateway/src/subprocessRunner.ts`（official-cc fingerprint／重启／preheat）、`packages/commercial/src/dispatch/enginePreheatPreparation.ts`（codexOnly）、`packages/commercial/src/http/proxy/boxAccountResolver.ts`（uid出口前置）、`packages/commercial/src/ws/turnPerformance.ts`（首帧）、`packages/web-react/src/components/chat/ProcessDisclosure.tsx` 与 `MessageRenderer.tsx`（过程区／最终区绘制探针）、`packages/gateway/src/engine/grokAdapter.ts`／`antigravityAdapter.ts`（每轮CLI）、`packages/commercial/src/billing/antigravitySettle.ts`（独立结算）。

远端证据：`H/g498-ttft-others-20261018`；交接：`H/CONTINUE-20261018-OCV5-498-TTFT-OTHERS.md`，H=`/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308`。只保存安全数字元数据、ID和代码，不包含口令、密钥、完整env、完整请求头或回答正文。独立复核结果保存在同名evidence目录。

10:52:33Z 最终只读核对：个人版stable／slot A／candidate空，health依赖均正常，版本仍67d13462e、canonical clean、env键数121；10:52:35Z列车FREE。见[最终运行状态](./TTFT-OTHERS-20261018-evidence/final-operational-proof.json)和[执行次数核算](./TTFT-OTHERS-20261018-evidence/request-counts.json)。

文档审阅：[草稿PR #846](https://github.com/dream-star-end/smart-assistant/pull/846)，分支`docs/v5-selfhost-ocv5-498-ttft-others`，不包含产品实现；后续批准范围与实施草稿见下文。计时、账务及引擎方案三路只读独立复核通过，记录见[独立复核](./TTFT-OTHERS-20261018-evidence/independent-verification.md)。


**19:12 批复后的实施与验收（20:39 缓存口径、20:54 任务完成标准更新，所有 PR 保持草稿）。** 用户批准第 1、2、3、4、6、7 步；第 5 步仅详细设计。19:14 要求缓存不下降、请求前缀内容与顺序稳定；20:39 用户明确改为“无明显变差”，接受第 1 步 Grok 命中不变、总输入仅 +2 token 为噪声，按通过处理，仍附精确前后证据。第 2 步保留透明自动重试、遵守 Retry-After／指数退避＋抖动，缺出口明确错误；第 6 步不改默认；第 7 步不减功能或降低速度。用户另允许第 3 步以恢复出口后同账号、未改代码作基线，并在 19:23 明确允许正常登录池溢出 default，记录实际登录。本任务没有合并、发布或商业版操作。

| 步骤 | 独立草稿 PR | 当前实现与预计省秒 | 风险／限制 |
|---|---|---|---|
| 1 / OCV5-500 | [#860](https://github.com/dream-star-end/smart-assistant/pull/860) | 可见过程正文双 rAF 首绘制；CCB／Grok／Antigravity 与代理／relay 阶段计时；冻结 trace 和进程 generation。直接节省 **0 秒**。 | 低：日志成本、去重及取消时序。Grok比例的极小变化按20:39用户口径接受为噪声，原数值保留。 |
| 2 / OCV5-501 | [#861](https://github.com/dream-star-end/smart-assistant/pull/861) | 网关唯一 retry owner，429 完整共享 10 次重试预算；尊重 Retry-After、指数退避＋抖动，Stop有效；5xx／capacity保留原熔断；仅确认无可用出口时明确409，临时故障、冷却成员及有绑定／不确定候选继续原自动恢复。仅同类缺Box出口可免重复失败间隔约 **7.828秒**，候选未实测；429不承诺省秒。 | 中：重试预算、续接、错误历史；尊重上游期限可能等待更久。已修复独立审查发现的hint进入错误历史反例。 |
| 3 / OCV5-502 | [#849](https://github.com/dream-star-end/smart-assistant/pull/849) | 已最小开通765出口，失败→可用。没有开通前成功基线，**可相减收益N/A**。 | 低：仅765的受限文件；不动全局池和登录。同值幂等、异值拒绝。 |
| 4 / OCV5-503 | [#850](https://github.com/dream-star-end/smart-assistant/pull/850) | 仅缓存内容派生指标，128条／2MiB，不缓存权限／技能／记忆来源。热路径离线CPU p50约省 **0.0057秒**。 | 低：有界内存和冷成本；cold／churn／bypass增约0.0005–0.0010秒，不是网页TTFT效果。 |
| 5 / OCV5-506 | [#853](https://github.com/dream-star-end/smart-assistant/pull/853) | 仅常驻CLI详细设计；未做实现或PoC。原组合段4.356–5.270秒仅作 **0–约5.3秒研究上界**。 | 高：逐轮能力、权限、Stop、迟到包、隔离、计费。仍无实施授权。 |
| 6 / OCV5-504 | [#851](https://github.com/dream-star-end/smart-assistant/pull/851) | 只显示用户自选普通／Fast档的实际目录价格及中性说明，不改默认、effort=null或wire。**已证实省秒0**。 | 低：价格随目录；不承诺Fast因果提速或降低思考档后的质量。真实菜单零发送验证。 |
| 7 / OCV5-505 | [#852](https://github.com/dream-star-end/smart-assistant/pull/852) | 每次构建复用MCP文案清理器，保留全部schema／能力／顺序／正则语义。两次partial离线CPU p50约省 **0.000015–0.000415秒**。 | 低：等价正则、状态重置；全部工具边界、128个确定性子集与完整prompt对照覆盖。收益很小且有负载噪声，未证实全链路提速，不删UI／技能／checkpoint。 |

**20:54 按任务完成标准复核。** 判断修复的标准是任务能否更好完成，不以更快报错代替恢复。第2步发现两个真实缺口：UID同一错误码还可能代表临时EMFILE/EIO；Tool链未使用Text链的明确分类。已收窄终止条件：只有确认文件缺失／非法，且本轮已授权候选内其它账号明确均无绑定，才返回明确409；其余保留基线自动恢复机会。不会新增跨账号迁移、借其它用户出口或改变native归属。新增代码的相关测试、类型检查、lint、独立增量审查和最终提交CI均已通过；新批准记录与旧r3分别保存。生产正常active列表不变；只在失败分支补一次不读凭据的完整元数据范围，任意同pin冷却成员、active绑定／未知字段、查询缺失／失败／截断均保留旧重试，避免提前结束会被halfOpen或usage sweeper自动恢复的任务。

| 步骤 | 对用户任务完成的影响及边界 |
|---|---|
| 1 | 被动计时和首绘探针，不重发、阻塞或修改模型输入；收益是定位等待，不宣称提高答案质量或模型速度。 |
| 2 | 429继续透明恢复至成功；临时／未知出口读取错误继续重试。确认无路才结束无效等待，保留任务上下文及既有模型切换入口；授权修复后同模型续接完成须有隔离证据。不能宣称自动修复管理员配置。 |
| 3 | 授权恢复765出口已把原失败任务恢复为首轮及追问成功，实际均account2；没有删功能、换默认或影响商业账号。 |
| 4 | 每轮仍读取最新来源与权限，只复用相同字节的派生计算；内容、顺序和能力不变。热路径CPU改善很小，冷成本0.5–1毫秒仍披露，未量化为用户可感知延迟。 |
| 5 | 仅设计；未来须先验证逐轮权限、任务续接、Stop和迟到包／扣费隔离。现有缓存证据不等于常驻实现通过，不启动PoC。 |
| 6 | 只帮助用户了解已有自选普通／Fast档价格，不代选、不降思考档、不改默认或请求；没有新增推理调用。 |
| 7 | 全部工具、schema、上下文顺序与文案语义保持等价，不减少任务能力；收益仅离线CPU微秒级，不承诺全场景端到端变快。 |

独立复核保留实际可触发反例和验证边界；第2步新增夹具验证临时读取后成功、有绑定／未知候选保留旧恢复、Text与真实Tool链，以及授权修复后的原任务上下文完成。所有新增验证使用隔离mock，不新增付费请求。托管CI另发现共用错误分类文案被Box规则改变，已恢复原文案并补契约回归，不以修改期望值绕过失败。

**第 3 步已执行的唯一现网操作。** 11:43:26 UTC 在官方个人版部署锁内，仅创建 `/etc/openclaude/cursor-v5-u765`（root:root、0700）及 `.https-proxy`（root:root、0600、单硬链接），引用已经存在的 sing-box 出口。重复执行同值不写入，不覆盖异值。不改全局路由、登录文件、模型目录、默认项或服务；没有重启。操作前后 canonical/live 都为 67d13462e。4 项操作脚本测试与独立两轮审查通过，PR 当时 14 项 CI 通过。恢复前全部失败，cached tokens 比例保持 N/A。

**追加真实网页。** 765 普通登录首次自然唤醒容器 1063（runtime source 仍 67d13462e）；就绪约 34.8 秒超过观察器 30 秒窗口，0 发送／0 扣费。保留失败记录后只把观察窗延到 120 秒，新隔离 context 继续普通流程，不清库、不人工预热。

恢复后的 Box Haiku 新对话首轮／追问均成功：首字 27.279／13.243 秒，paint 27.746／13.334 秒，扣 7＋1＝8 分。按 journal nonce→准确进程 cwd→仅 `CLAUDE_CONFIG_DIR` 值关联，两轮实际登录都是 **account2**，未使用 default 或 cc1。追问缓存 I=4、R=47,725、W=493，R/(I+R+W)=98.96935%；首轮 I=2、R=0、W=47,741，为缓存写入而非读取。不是“开通前缓存为 0%”。

恢复后基线的进一步分段如下，单位秒。gate 时间是权限门的入口采样，不是权限校验完成；journal 仍是数据库事务锚点。各段口径可能重叠，不按表逐项相加。

| Box 已知边界 | 新对话首轮 | 同会话追问 |
|---|---:|---:|
| 服务端首正文 | 26.768 | 12.990 |
| context_ready→权限门入口 | 13.998 | 0.109 |
| 权限门入口→journal | 0.714 | 0.152 |
| journal→native session 决策 | 4.202 | 2.278 |
| fetch→首 SSE 字节 | 9.373 | 8.069 |

最大可定位冷差在权限门之前，仍混合 CLI／提示准备、传输与早期代理处理，不能全部归给 CLI spawn。Box 的 fetch 段还含远端恢复、stage 和启动，不是纯供应商计算。首轮 native miss，追问 resume；两轮 CLI PID 不同，因此这里只证明原生会话复用，不是进程常驻。

**候选前端真实网页复核。** 第1步候选生产资产仅替换单个隔离浏览器的静态GET，API／WS／Host／Origin／认证保持原站，后端仍67d13462e；没有修改现网Web overlay或路由。Box两轮仍account2；Grok两侧原生modelCalls和loop_started均为1。

| 网页样本 | 正文首字s | paint s | 本轮扣分 |
|---|---:|---:|---:|
| 恢复后基线Box首轮 | 27.279 | 27.746 | 7 |
| 恢复后基线Box追问 | 13.243 | 13.334 | 1 |
| 第1步前端Box首轮 | 28.127 | 28.348 | 3 |
| 第1步前端Box追问 | 15.770 | 15.981 | 1 |
| 未改代码Grok首轮 | 13.712 | 22.803（旧探针） | 14 |
| 第1步前端Grok首轮 | 60.813 | 61.140 | 16 |

候选前端的paint在正文后约0.2–0.33秒触发，支持过程区探针修复；它不支持“模型提速”。Grok本次明显更慢，完整保留：服务端首thinking40.515秒、首正文59.383秒，平台prompt在inbound后1.573秒已构建完，主要等待在Grok CLI／relay／上游综合段。无attempt重试，缺细分边界，不能认定是供应商或候选前端导致。

私有Vite dev曾在登录前因node:crypto浏览器外置错误失败；生产资产覆盖又因Chromium `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`拦截本机WS而失败。均为0发送／0扣费并保留记录。只给临时context的原站loopback origin授予`local-network-access`后零发送对照通过，未关闭浏览器安全检查、伪造build或绕过认证。第6步另用实际候选生产资产零发送验证：标准x3.4、Fastx6.8，中性思考说明可见，不改默认，不再追加模型请求。

**真实缓存受控对照。** base 及各步骤自己的源码分别生成相同完整受控 API body：46,753 字节，SHA256 `4c2b8a88feaf93a2a7f99783a8eb0f9353747aef40298105d9493e7156e174aa`；平台 prompt 24,820 字节，21 个完整平台 MCP schema、顺序固定；765 当前 remote IUI／model hint 和目录快照固定，official-cc 对应 legacy 布局。完整原文仅保存在远端私有文件，报告只留摘要。

| 同一稳定新实验会话 | 未缓存 I | 缓存读 R | 缓存写 W | R/(I+R+W) | 扣分 |
|---|---:|---:|---:|---:|---:|
| 未改代码 warmup | 12,672 | 0 | 0 | 0% | 2 |
| 未改代码基线 | 256 | 12,416 | 0 | 97.97979798% | 1 |
| candidate 共用相同 body | 256 | 12,416 | 0 | 97.97979798% | 1 |

三次均在 765 自己容器内，通过正式 fresh local_catalog 路径调用 DeepSeek；不借旧 authority／lease／turnKey，不人工构造 dispatch，raw fetch 无自动重试。基线与候选比例一致，**受控输入未下降**；同一数据共享引用，不能按 PR 重复计调用。它没有复现原生 CLI 隐藏 system／默认工具、765 实际 persona／memory，不是候选后端已部署的完整网页证据。不得以此抹去这些未覆盖项，或把所有引擎全部标为通过。

**原生缓存与20:39用户判定。** I为未缓存输入，R为缓存读，W为缓存写；Grok原生total input已包含缓存，先拆出I后统一计算。Box两组均765／account2；恢复前N/A保持不变。自然生成的回答长度不同，不将命中改善归因代码。

| 对照 | 基线 I / R / W | 候选 I / R / W | 基线比例→候选比例 | 当前判定 |
|---|---|---|---|---|
| Box首轮 | 2 / 0 / 47,741 | 2 / 34,577 / 13,163 | 0%→72.42469943% | 无明显变差 |
| Box追问 | 4 / 47,725 / 493 | 4 / 47,724 / 379 | 98.96935009%→99.20385807% | 无明显变差 |
| Grok首轮 | 21,383 / 1,152 / 0 | 21,385 / 1,152 / 0 | 5.112047925449301%→5.111594267205041% | 用户20:39明确接受为噪声、通过 |

Grok精确下降0.000453658244261个百分点，绝不四舍五入成不变。独立核对原生system和24项工具定义完全相同；首个assistant之前5条输入均42,615B，仅一处会话working_directory不同，按各自存档值精确归一后全文SHA256相同。未保留供应商完整wire／tokenizer，2token精确归因仍N/A。保留旧严格比例门的未通过历史及用户20:39的当前接受记录，不改原始数字、不追加请求挑样。前缀稳定要求继续有效。

各PR均附共享受控API的97.97979798%→同值证据与自身源码导出绑定；第1步另附原生Box／Grok、第3步另附恢复出口后Box对照。第2步增加官方CLI2.1.302隔离network-none、control/hint的429→resume验证：system/tools/messages逐字相同、hint不进入上游，409保留明确code，并在模拟授权修复后同session恢复成功；三臂完整system/tools/messages相同，原任务按序逐字节保留，真实供应商调用0。共享对照不代表未部署的所有候选后端／所有引擎已完成生产验证；第5步仅文档，不能把现有代码的命中证据当作未来常驻CLI验收。

**本阶段最终扣费。** 11:49:30–12:38:56.640962 UTC：新增9次成功本体调用（Box4＋Grok2＋受控API3）、6个网页dispatch；9 journal／9 usage／9 ledger全部终结，冻结价Decimal ceil逐笔相符。Box12分、Grok30分、API4分，合计 **46分**；钱包 **35,181→35,135**，ledger count1822→1831，period桶仍0。8条UI／预检失败记录均0发送、无新增收费。

原始与追加合计：**29次成功本体调用、25条收费usage、221积分（¥2.21）**，钱包35356→35135。全部有证据的供应商模型尝试是 **32次**，含原始3次未收费GLM429；另有原始3次Box本地未launch失败，合计35次执行尝试。付费成功数29不能写成“全部请求≤30”；32次供应商触达比30多2，后续未再追加请求。未取得供应商现金账单，不将平台积分当作供应商实扣。

**工程门禁收口。** 第1步85项后端、41项relay、64项网页测试及生产构建／最终类型检查通过；第2步20:54前281项相关测试通过；前置402项记录保留，最终f6d固定head403项回归全部通过（含生产cooldown恢复），增量r1独立审查批准。官方CLI三臂修复后续接验证已通过；测试类型断言已修正，相关20项复跑、类型检查及最终lint通过；增量r1/r2/r3审查批准，最终CLI、源码绑定及最新提交14项CI均已通过；第3步4项脚本测试通过；第4步30项相关测试通过；第6步58项相关测试、类型检查、lint及生产构建通过；第7步最终13项等价／完整prompt回归通过。独立审查和各PR最新head CI另附最终状态；排队项不算通过。所有分支已推送、PR保持草稿，不合并不发布。第5步风险仍高，仅设计，无实现或PoC。

最终离线源码绑定使用保留的付费基线67d13462e，对七个最终分支分别导出（第2步8fb6a8be9）；8组完整body摘要一致，见[HEAD与请求摘要绑定](./TTFT-OTHERS-20261018-evidence/approved-steps/paid-evidence/final-source-export-manifest.json)。共享canonical随后因他人#847合并前进至16bce96f3，未把它冒充原实验基线。

| 步骤／PR | 最终分支head | 独立全diff审查 | 最新head CI |
|---|---|---|---|
| 1／#860 | c93d14d93 | r3全diff APPROVED；20:39文档增量r1 APPROVED | 14项SUCCESS |
| 2／#861 | 8fb6a8be9 | 原全diffr3 APPROVED；20:54增量r1/r2/r3 APPROVED | 14项SUCCESS；旧dc8共享文案回归已修复 |
| 3／#849 | ddfc60324 | r3 APPROVED | 14项SUCCESS |
| 4／#850 | 429366fb0 | r3 APPROVED | 14项SUCCESS |
| 5／#853 | 0b2213a9e | r2 APPROVED | 14项SUCCESS |
| 6／#851 | 0d8c8c30f | r2 APPROVED | 14项SUCCESS |
| 7／#852 | 59a40249e | r2 APPROVED | 14项SUCCESS |

远端追加证据：`H/g500-ttft-approved-20261018/{step1,step2,step3,step4,step5,step6,step7,paid-evidence}`；交接 `H/CONTINUE-20261018-TTFT-APPROVED-STEPS.md`。H与原始测量相同。安全证据：[最终账务核验](./TTFT-OTHERS-20261018-evidence/approved-steps/paid-evidence/billing-agent-phase-audit-final.json)、[共享真实缓存对照](./TTFT-OTHERS-20261018-evidence/approved-steps/paid-evidence/shared-cache-evidence.json)、[Grok原生前缀与缓存独立核对](./TTFT-OTHERS-20261018-evidence/approved-steps/paid-evidence/grok-native-cache-comparison.json)、[20:39用户接受记录](./TTFT-OTHERS-20261018-evidence/approved-steps/paid-evidence/user-2039-cache-acceptance.json)。

20:54独立只读复核：[第1/4/6/7步](./TTFT-OTHERS-20261018-evidence/approved-steps/user-2054-task-completion-review-part-a.md)、[第2步具体反例与修复](./TTFT-OTHERS-20261018-evidence/approved-steps/user-2054-task-completion-review-part-b.md)、[第3/5步](./TTFT-OTHERS-20261018-evidence/approved-steps/user-2054-task-completion-review-part-c.md)。它们不替代新增代码的独立Codex审查或CI门。

官方CLI增强夹具的首个control断言失败记录保留：原15B用户文本完整存在于CLI恢复后的16B文本块中，原顺序未变。最终使用UTF8原串按序完整保留判据，不trim或归一；缺原任务／倒序负例仍失败，三组完整上游输入仍逐字相等。没有将真实continuation替换为重发原prompt来凑通过。

最终CI于2026-10-18 14:08:06 UTC逐一核对：七个PR均为表中精确head、14项SUCCESS、草稿／OPEN／未合并且无合并冲突；见[最终CI快照](./TTFT-OTHERS-20261018-evidence/approved-steps/final-ci-status-user2054.json)。归档仅两处改名保留原字节与SHA：[归档名称映射](./TTFT-OTHERS-20261018-evidence/archive-name-map.json)；空stdout仍为空，不冒充benchmark JSON，历史脚本作为原始文本保留，实际产品／验证脚本lint门继续通过。

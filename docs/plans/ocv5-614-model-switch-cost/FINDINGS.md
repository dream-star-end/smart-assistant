# OCV5-614：个人版模型切换现状

调查基线：个人版 `f6077bf22a349cea2081d3abcbbfdcfa2faf9f63`（2026-10-24 台北时间）。只读源码分析与现网证据分开记录；未访问商业生产或其数据库。

## 入口与现有提示

以下路径均相对个人版仓库。

| 入口 | 实际行为 / 定位 | 现有提示 |
| --- | --- | --- |
| 会话模型选择器，包括最近模型、家族、思考/Fast、标准/1M 型号 | `packages/web-react/src/components/ModelSelector.tsx:423` → `hooks/useSessionModelAndCollab.tsx:107`；桌面菜单、手机 Sheet；选择后持久化，下一次发送才推理 | `cost_x` 标记，不是本轮费用 |
| 上下文/多模态降档 | 上述 hook `:154`，`lib/modelSwitch.ts:8` | 现有 Modal 提供“压缩并切换 / 直接切换”；压缩本身使用当前模型 |
| Cursor Opus/Fable | `lib/modelSwitch.ts:30`、hook `:136` | 非该家族的已有会话只能“新建会话”，不能原地切入；既有产品规则，本票默认保留 |
| 全局默认模型 | `components/settings/PreferencesTab.tsx:146`、hook `:74` | 只有固定 1M 风险提示；无显式会话模型时偏好变化可直接改变下一轮模型，绕过 selectModel |
| 智能体切换 | `components/AppDialogs.tsx:390`、`lib/chat/socket.ts:5437` | 改 agent；浏览器下一次通常仍显式发送 modelId；无显式 model 的其他客户端会取 agent 默认 |
| 单人 / 团队切换 | hook `:220`、`hooks/useComposerSend.ts:291`、`packages/commercial/src/ws/userChatBridge.ts:5907` | 团队 main 强制实际父模型 `gpt-6-astra`，退出则回到选择器模型；现有说明只说团队更贵，没有 token/积分/余额 |
| 顾问模式 / 顾问型号 | `AppDialogs.tsx:363`、上述 hook persistCollab | 顾问是额外调用，不等于父模型切换，不应把它算成重送父会话全部上下文 |
| 任务阶段型号 | `taskboard/StageSettings.tsx:412`、gateway `taskboard/patrol.ts:659,685,721,795` | 每个 run 创建 `agent:<agent>:taskboard:<ticket>:<stage>:<run>` 独立会话，只注入工单/评论/项目等；不继承 webchat 大上下文，可按新会话豁免 |
| 重试、编辑重发、恢复、直接 WS、排队发送 | `lib/chat/socket.ts` 多条发送路径；protocol `frames.ts:227` 的 `inbound.message.model` | 可绕过选择器；必须在实际 dispatch 前检查有效模型 |
| 会话 PUT/PATCH modelId | gateway `routes/clientSessions.ts:919,963` | UI 元数据写入，不等于实际调用；不能作为“上次已实际使用模型”的权威 |
| CLI / delegate | gateway `delegateRuntime.ts:584,1239`，CLI agents 配置 | 独立委派会话通常是新上下文；若复用旧委派会话换型号，不能冒充主会话已确认 |

在途 PR #1044（OCV5-609）改阶段模型、任务执行和 delegate 预检。本票不改变其优先级/路由，也不在其 worktree 写入。

## 上下文计数

- `sessionTypes.ts:182` 的 totalInput/Output/Cache* 是跨回合累计；CCB result.usage 也是整轮多次 API 请求之和；二者都不能充当当前上下文。
- CCB 的既有正确口径为最近一次请求 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（`claude-code-best/src/utils/context.ts:151`）。Codex `thread/tokenUsage/updated.last` 已规范化为不相交四维（gateway `codexAppServerNotifications.ts:747`、`codexAppServerProtocol.ts:385`）。
- CCB/Codex 的 `_callUsage` 已附着到文本/思考/工具/结构块并持久化（gateway `sessionTurnRunner.ts:329`；protocol `losslessTurnTape.ts:217,473,869`）。master 的既有 exact 水合证明计数已持久化，但报价不能调用其全量读取：长会话可能数百 MB（bridge `:1726` 已有事故注释）。应有界读取最近根 tape 的小型元数据/尾记录；按 callId 去重、取最后一个父调用，排除 delegate 子树，不能只看 timeline 首屏。
- Grok/Cursor/Zcode 等未发现同等 call snapshot。可复用 protocol `estimateModelHistoryTokens()`（`modelHistory.ts:508`）对已有历史语义文本估算，显示“约/历史估算”；不能将未知当 0，也不能声称这是底座精确 tokenizer 结果。
- 跨引擎可能走现有受上下文窗口约束的历史重建，未必真的重送所有原始历史；本票不改变这一策略。报价必须说明估计口径与实际重建/压缩的影响。

## 计费口径

唯一金额公式是 `packages/protocol/src/computeCost.ts:94` 的 `computeCostFen`：

`fen = ceil((input×inputPrice + output×outputPrice + cacheRead×readPrice + cacheWrite×writePrice) × composedMultiplier / 1,000,000)`。

重要纠正（08:06复核）：computeCostFen/calculator 的旧“分/100”注释不能代表现行产品展示。migration0269明确 cost_credits/credit_ledger shown 1:1 as 积分，当前 cards/ChatHeader/Sidebar 的 formatCredits 也仅做千分位，未除100。因此原始整数按1:1积分展示；本票基线为5与125积分。计算仍复用原BigInt算法，报价显示不修改任何价表/扣费。

- `PricingCache.get()` 为当前价格权威；`/api/public/models` 的每千 token 展示价已经包含模型倍率，不可再乘一次。
- 模型倍率与 agent 倍率复用 `composeMultiplier` / `getAgentCostMultiplier`；Fast 复用 `applyFastServiceTierPricing`；Cursor 复用 `cursorSettleMultiplier`。不另造价格表。
- 对冷上下文，输入和缓存写是互斥收费分类；预估可以用二者较高价作保守口径，不能把两价相加。缓存写价为 0 时使用输入价，不能估成免费。
- “一轮”可能包含多个上游请求。首次冷输入以后还可能有工具、缓存读、输出和重试，不能把首次请求基础费用宣称为整轮上限。
- 余额读取复用 `readTotalSpendableBalance()`（`billing/preCheck.ts:343`），包括适用的期内/钱包/组织桶。`/api/me` 钱包单字段不完整。
- 现有 preCheck 是余额大于 0 放行、软预留 cap 到余额（`:44,281`）；实际 `spend.ts:279` 已 clamp 到可用余额。本票不修改预检、预留、结算或扣费逻辑。

## uid 765 现网证据

- 2026-10-23 22:21 UTC 第一次浏览器访问恰遇在途发布切流，18790 拒绝连接；失败原件保留 `evidence/baseline-ui-attempt1-failed.json`（远端证据目录），没有登录/模型调用。
- 22:24 UTC 第二次使用真实冷浏览器登录，响应用户为 **765**；无模型请求。桌面 1440×1000、手机 390×844 的现有模型菜单截图已取回同目录 `evidence/`。
- 该登录返回的可用价格示例（积分 / 千 token，已含模型倍率）：GPT-6-Astra 输入 0.005980、输出 0.035980、读 0.000600、写 0；DeepSeek V4.1 Flash 输入 0.001120、输出 0.003370、读 0.000030、写 0。可见大上下文首轮风险与固定 cost_x 并非同一概念。
- 22:33:42 UTC 共享等待脚本返回 FREE 后，仅使用本票新建会话 `webmvljtrqyyk9tkj` 实测。源 GPT-6-Luna 首轮输入 **200,453**、输出 7、缓存读写 0；切 GPT-6-Astra 时现有弹层只提示多模态降档，**没有预估积分或余额**。使用现有“直接切换”后同会话首轮输入 **208,841**、输出 7、缓存读写 0。
- 源轮实扣 **5 积分**；切换后首轮 **125 积分**，为源轮 25 倍。按真实 price_snapshot 和 computeCostFen 重算，usage / committed journal / ledger 逐请求相等；合计 **130 积分**。精确用量/dispatch/ledger ID 见 `evidence/baseline-billing-audit.json`。
- 真实浏览器证据：`evidence/baseline-turns.checkpoint.json`、`baseline-resume.json`；改前桌面/手机弹层截图 `desktop-before-switch-notice.png`、`mobile-before-switch-notice.png`。第一次大上下文脚本在等待选择器标签时因现有压缩弹层超时；失败原件保留，恢复脚本沿同一会话继续，没有重复发送源轮。
- 额外 **8,388** 输入 token 的差异证明“上次调用计数”不能作为下一轮精确承诺；输出预测与上下文变化必须作为估计说明。当前 1 积分默认阈值会覆盖此实测场景。

远端证据根：`/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308/g614-model-switch-cost/`。

用户08:03已选B，08:06要求所有引擎复用现有切换提示并添加指定风险句子，详见PLAN。

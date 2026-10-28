# 中途换模型 / 换引擎调查（W3 / OCV5-655）

## 范围和证据
个人版 base `29d7af504c88b86204f3a53a3ab22ee87e4d2ccb`。六引擎 CCB、Codex、Grok、Cursor、Zcode、Antigravity。这里只证明服务端选择、状态隔离、历史载荷和提示契约，不宣称真实供应商进程兼容性、生产体验或付费结果已经验证。

## 可复现的问题与修复

1. **带附件跨引擎首轮丢历史**：`shouldAttemptHistoricalContextInjection` 和 `sessionSubmit` 双重限制输入必须是 string。旧引擎 native id 无法复用、没有 prepared handoff summary 时，`[{type:text}, {type:image}]` 没有补历史。修复后用 `buildHistoricalContextPayload` 前置语义历史文本块，原始附件和文本块保持身份、顺序；当前输入去重；runner `maxPromptBytes` 仍限制历史后缀，不截断附件。无法容纳历史时不发成功提示。
2. **灰条反复出现**：native resume 丢失期间，历史键随着上一轮新增回复而变化，旧逻辑每次注入都触发 context rebuilt。新增 session episode 标记：首次真正注入且提示成功后置位，有效 native resume 恢复后清除。同一次 fallback 的后续回合继续获得最新历史，但不反复提示。新建引擎会话自然重新拥有一次提示额度。stateless 常规 replay 和 provider gap delta 保持静默。
3. **重试上限显示失真**：调度器已有 settled-tools / empty continuation 短预算 3，通用预算 10；旧 request recovery.max 固定 10。保留所有旧字段与预算策略，只新增 retryLimit/retryStatus。没有持久化实际上限的旧 job 省略 N，不伪报 10。master admission 仅 scheduled；持久化容器 receipt 的 CAS 成功后才 running。

4. **Antigravity 最终信封转义膨胀**（R1 审查复现）：引擎将多模态 blocks 拼成文本，历史之后仍有当前消息；旧裁剪器只识别严格八行，因此双重 JSON 转义超限后无法删去旧历史。裁剪器现在识别前置历史并完整保留后续当前 blocks，通过实际 adapter + 假 CLI stdin 捕获验证。Antigravity 自身既有的 binary 不支持提示仍有效，本票不声称为该引擎增加了视觉能力。

## 已有保护与未发现需修改的部分

- `getOrCreateImpl` 按引擎隔离 native resume id；跨引擎旧 runner 先 shutdown，新会话重置成本基线、tool-use map 和目标运行态。
- prepared model switch 的 summary/media 交接已经支持 block 输入；本次修复的是普通 fallback 分支。
- 历史工具调用经 storage 的语义投影进入文本历史，不把旧引擎的 tool call/result 原生帧直接送给新引擎。
- 同引擎切模型由既有 model authority / setModel 流程负责，不要求不必要的 runner 重建；既有 `sessionManagerEngineSwitch.test.ts` 继续作为回归覆盖。
- 未改模型授权、切换成本确认、调度、用户消息 admission、exact replay 或计费。UI 展示由 FE-errors 接入，不能将服务端目录完成等同于 UI 已修复。

## 六乘六矩阵

`packages/gateway/src/__tests__/modelSwitchMatrix.test.ts` 对以下每一格调用真实 SessionManager.getOrCreate + submit；runner 工厂和最终执行替身不会调用外部模型。每格输入带图片，随后发送第二条消息并改变历史键，断言历史/工具语义/附件保留和提示次数；跨引擎另外断言 shutdown、native id、累计成本、goal/tool state 隔离。

| 来源\目标 | ccb | codex | grok | cursor | zcode | antigravity |
|---|---|---|---|---|---|---|
| ccb | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |
| codex | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |
| grok | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |
| cursor | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |
| zcode | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |
| antigravity | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 | 待跑 |

矩阵控制台名含具体 from/to，任何缺失或 skip 不能算通过。43 个目录/出口/矩阵断言与 1 个 Antigravity 实际信封用例已接入既有 session-unavailable rootfix proof 入口，CI 会核对完整叶子集合；没有新增门禁豁免。

## 当前验证状态
截至 2026-10-28 17:44 UTC：部署队列 BUSY；尚未执行任何测试、类型检查或 CI。以上是代码调查与待验证改动，不是通过报告。上线后用户灰条频次与真实供应商切换验收由管理会话安排；本票不发布、不跑付费回合。

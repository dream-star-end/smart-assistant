---
name: multi-model-review
description: 可解释多模型评审：按"模型×角色"指定 N 位评审员（默认 3 个不同家族）并行委派评审同一份稿件，各自产出结构化 JSON，用 `oc-review collate` 确定性汇总（共识/分歧/单发三分区，逐条保留来源模型），汇总卡留痕到会话 generated/。用户要"评审稿件/找多个模型互评/交叉审阅"时使用。
tags: [research, review, multi-model]
---

# multi-model-review 可解释多模型评审

同一份稿件交给多个模型互评时，**评审员是谁、各自说了什么、分歧在哪，必须可见、可控、可留痕**。
评审产出 JSON；**汇总走确定性 `oc-review`**（不让模型心算合并多份评审——汇总本身是单点幻觉源）。

默认采用 **「1 轮异构盲审 + 1 轮批判吸收与 P0 复核 → P0=0 即收敛放行」** 工业化收敛闭环，根治 6+ 轮无限拉锯。

## 流程

0. **前置：保真读稿 + 机器静态门禁**（不把机械纠错浪费在 LLM 审稿上）：
   - 若待审稿件为 `.docx`，**严禁裸抽纯文本丢公式或把大文件塞满请求体**；必须先用 `oc-docx extract <file.docx> --latex` 无损还原 OMML 公式为 LaTeX 与表格结构（大稿先 `oc-docx extract <file.docx> --toc`，再按 `--section` 分片或向评审员传递轻引用路径）；
   - 送审前先跑三道确定性静态门禁：`oc-docx check <file.docx> --expect-formulas`（清零占位符/断号引用/OMML 异常/行尾标点丢失）、`oc-cite verify`（核验真 DOI 与题录匹配）与 `oc-stylecheck <file.docx>`（去 AI 味），通过后再派异构模型盲审。
1. **定评审员**（模型×角色，两者正交）：默认从 catalog 挑 3 个不同家族模型；用户点名的用点名的
   （如 kimi/gpt/deepseek/glm 四家）。角色预设：方法学审查 / 统计与数据 / 写作与逻辑 / 领域专家（写进 goal）。
   上限 4 位（delegate_tasks 单次上限）。
2. **要 schema 与 P0/P1/P2 硬分级**：`oc-review schema` 打印评审员必须遵守的 JSON 契约，原样贴进每个委派 goal，并要求评审员按硬分级标注 `priority`：
   - **`P0`（阻断放行）**：数学/物理推导错误、代码与正文数值矛盾、引文失实/张冠李戴、前后硬矛盾；
   - **`P1/P2`（非阻断）**：论证结构完善（`P1`）与风格措辞偏好（`P2`）。
3. **并行委派**（只评不改）：Cursor 等多回合同一并发起 `oc-memory delegate --model <slug> --goal "..."`
   （每位评审员一条）；CCB 引擎走 MCP `delegate_tasks`，tasks[] 每项填 `model` + `goal`。
   goal 模板："你是<角色>。严格按下方 JSON schema 输出评审，只输出 JSON，不要改写稿件。
   稿件：<路径或经 oc-docx extract --latex 提取的保真文本/章节切片>。schema：<oc-review schema 输出>"。
4. **落盘**：把每位评审员的 JSON 存为 `/home/agent/.openclaude/generated/review-<ts>/reviews-<model>.json`
   （文件名必须是 `reviews-*.json` 才会被 collate 读取；评审员只回 JSON 时原样保存，不加工）。
5. **跨轮裁决账本（`/home/agent/.openclaude/generated/review-<ts>/decision-ledger.json`）与确定性汇总**：
   第 1 轮评审后，对每条核心意见做批判性吸收，并将**已采纳**或**带证据驳回**的条文记入本次评审目录内的独立绝对路径账本，防止后续轮次无新反证反复翻案（Flip-Flop）及相对路径落盘风险：
   ```bash
   oc-review ledger init --file /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json
   oc-review ledger record --file /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json \
     --anchor "<location>" --topic "<topic>" \
     --decision accepted|rejected_with_evidence|deferred \
     --reason "<裁决理由>" --round 1 [--evidence "<证据>"]
   oc-review ledger show --file /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json

   # 汇总（首轮可不挂 --ledger；复核轮次必须挂 --ledger 自动折叠无新反证的重复挑刺）
   oc-review collate --dir /home/agent/.openclaude/generated/review-<ts> \
     --ledger /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json \
     --round 2 [--out 自定义汇总卡路径]
   ```
   产出 `review-summary.md`（收敛闸门、共识区/分歧区/单发区、按账本折叠的 Flip-Flop 区，按 blocker>major>minor>suggestion 排序）+
   `review-summary.json`（含 `priorityTotals`、`activePriorityTotals`、`suppressedFlipFlops`、`gate`）；stdout 末行 `COLLATE: <blocker>/<major>/<minor>/<suggestion>` 供程序判读。
6. **收敛闸门与交付**：
   - 检查 `review-summary.json` 中的收敛闸门：**当 `gate.status === 'PASS_READY'`（活跃 `P0 = 0`）时，必须显式宣布达到放行线并进入交付**，禁止为交差继续编造新审稿清单或无休止加轮；仅当 `gate.status === 'FIX_REQUIRED'`（活跃 `P0 > 0`）时才针对剩余 P0 定向修稿复核。
   - 正文贴闸门结论与共识/分歧摘要（分歧双方并列），汇总卡以绝对路径作为附件交付；全套 JSON+md+`decision-ledger.json` 留在同一目录可回溯。可选：对分歧处的多个修法候选跑 `oc-rank elo` 排序后再由用户裁决。

## 规则

- **P0 归零即收敛放行**：坚持 1 轮异构盲审 + 1 轮批判吸收与 P0 复核；`gate.status === 'PASS_READY'`（活跃 `P0 = 0`）即刻停止发散挑刺。
- **Flip-Flop 受账本约束**：已写入 `decision-ledger.json` 的采纳/带证据驳回条文，除非后续评审员提供 `new_evidence: true` 的新反证，否则由 `oc-review collate --ledger` 自动折叠，不得反复推翻。
- **分歧 ≠ 错误**：同一位置各评审员严重度判断不一致时，双方主张如实并列、多数侧只标注不裁决，
  由人拍板；禁止把分歧抹平成定论。
- **汇总不让模型心算**：多份评审 JSON 的合并必须走 `oc-review collate`，不得自己"读一遍总结"。
- **只评不改**：评审员输出 findings，不重写稿件；修稿是另一步。
- **积分护栏**：每位评审员按其模型正常计费（≈一次读全文的委派）。发起前先向用户报预估
  （评审员数 × 稿件量级）；超过默认 3 位或稿件 >2 万字先确认再发。
- **一位评审员故障不作废全局**：某位评审员 429/超时/输出非 JSON 时，`oc-review collate` 默认跳过该文件、
  在汇总卡顶部标注"缺席 N 位"（COLLATE 行追加 `skipped=<n>`），其余评审员照常汇总。交付时把缺席如实告知
  用户；若用户要求补齐，修文件或重派该评审员后重跑即可（`--strict` 可恢复任一坏文件即失败）。
  全部评审员都无效才算失败——此时直接用你自己的判断评审并说明多模型评审未成功（此时无 JSON 可汇总，
  不违反"汇总不让模型心算"），不要卡住不交。
- **委派有界**：每位评审员委派只等一次，不因某模型慢/挂而反复重派；上限 4 位、超 3 位先向用户报预估。

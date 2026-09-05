---
name: multi-model-review
description: 可解释多模型评审：按"模型×角色"指定 N 位评审员（默认 3 个不同家族）并行委派评审同一份稿件，各自产出结构化 JSON，用 `oc-review collate` 确定性汇总（共识/分歧/单发三分区，逐条保留来源模型），汇总卡留痕到会话 generated/。用户要"评审稿件/找多个模型互评/交叉审阅"时使用。
tags: [research, review, multi-model]
---

# multi-model-review 可解释多模型评审

同一份稿件交给多个模型互评时，**评审员是谁、各自说了什么、分歧在哪，必须可见、可控、可留痕**。
评审产出 JSON；**汇总走确定性 `oc-review`**（不让模型心算合并多份评审——汇总本身是单点幻觉源）。

## 流程

1. **定评审员**（模型×角色，两者正交）：默认从 catalog 挑 3 个不同家族模型；用户点名的用点名的
   （如 kimi/gpt/deepseek/glm 四家）。角色预设：方法学审查 / 统计与数据 / 写作与逻辑 / 领域专家（写进 goal）。
   上限 4 位（delegate_tasks 单次上限）。
2. **要 schema**：`oc-review schema` 打印评审员必须遵守的 JSON 契约，原样贴进每个委派 goal。
3. **并行委派**（只评不改）：Cursor 等多回合同一并发起 `oc-memory delegate --model <slug> --goal "..."`
   （每位评审员一条）；CCB 引擎走 MCP `delegate_tasks`，tasks[] 每项填 `model` + `goal`。
   goal 模板："你是<角色>。严格按下方 JSON schema 输出评审，只输出 JSON，不要改写稿件。
   稿件：<路径或全文>。schema：<oc-review schema 输出>"。
4. **落盘**：把每位评审员的 JSON 存为 `/home/agent/.openclaude/generated/review-<ts>/reviews-<model>.json`
   （文件名必须是 `reviews-*.json` 才会被 collate 读取；评审员只回 JSON 时原样保存，不加工）。
5. **确定性汇总**：
   ```bash
   oc-review collate --dir <该目录> [--out 自定义汇总卡路径]
   ```
   产出 `review-summary.md`（共识区/分歧区/单发区，按 blocker>major>minor>suggestion 排序）+
   `review-summary.json`；stdout 末行 `COLLATE: <blocker>/<major>/<minor>/<suggestion>` 供程序判读。
6. **交付**：正文贴共识/分歧摘要（分歧双方并列），汇总卡以绝对路径作为附件交付；全套 JSON+md 留在
   同一目录可回溯。可选：对分歧处的多个修法候选跑 `oc-rank elo` 排序后再由用户裁决。

## 规则

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

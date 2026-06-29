---
name: research-experiment-loop
description: 单轮/多轮实验闭环 + agentic tree-search:scientist 设计→coder 跑→scientist 评估→改进,跨多小时用 durable job 相位 checkpoint 续跑;多变体探索用 tree-search + oc-rank 选最优分支。要做可复现实验、参数搜索、方法迭代时使用。
tags: [research, experiment, tree-search, reproducible]
---

# research-experiment-loop 实验闭环 / tree-search(CC 原生编排)

把"设计→实现→运行→评估→改进"做成闭环;长任务靠 durable job 相位 checkpoint 续跑
(`claims_extracted`→`citations_verified`→… 见 IMPLEMENTATION_PLAN §8 相位枚举),
中断不丢已完成相位。多变体探索用 tree-search + `oc-rank` 选分支。

## 单轮实验闭环

1. **设计**(scientist):明确变量、假设、评价指标、数据边界、成功标准。
2. **实现+运行**(coder):最小可复现脚本,声明输入/输出/依赖/运行命令;本地优先,外部数据/服务前先征得同意。
3. **评估**(scientist):对照成功标准读结果(数据+图,图走 scientific-figures),指出是否达标、偏差来源。
4. **改进/收敛**:达标→产出;不达标→改一处假设/参数再来一轮。每轮结论写进下轮 prompt(meta-review)。

## agentic tree-search(多变体)

当一条线不够、要并行探多个方向时:
1. **扩展**:从当前最优节点派生 K 个变体(不同方法/参数),各给 id。
2. **评估+打分**:每个变体跑实验 + scientist 评分;变体两两可比时用 pairwise 评审。
3. **选择**:把评审/打分喂 `oc-rank elo --matches m.json` 得确定性排名,选 top 分支继续扩展(best-first)。
4. **终止**:达标 / 预算耗尽 / 连续 N 轮无提升 → 停,产出最优路径 + 各分支对比(可进 ReviewTableCard)。

## 规则

- 实验必须**可复现**:固定随机种子、记录依赖版本、保留运行命令;coder 交付便于 scientist/reviewer 复核。
- 长任务用 durable job 提交 + 轮询 + resume(大解析/检索/校验已是 master 侧 op);别把多小时跑全塞进一次 delegate(2h 硬上限)。
- 结论的事实/引用仍经引用接地(oc-litrag/oc-cite);实验数据如实报告,失败也报。
- 生医/临床只做研究辅助,不给诊断/治疗结论。

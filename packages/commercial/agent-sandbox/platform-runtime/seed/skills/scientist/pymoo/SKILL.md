---
name: pymoo
description: "Multi-objective and constrained optimization with pymoo: NSGA-II/III, MOEA/D, Pareto fronts, decision making, and benchmark problems."
version: 1.0.0
tags: [science, optimization, pareto, multi-objective]
license: Apache-2.0 license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# pymoo optimization

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户有单目标或多目标优化问题,尤其需要 Pareto front、约束处理、设计变量边界和决策权衡。
- 目标函数来自仿真、实验、ML 代理模型或昂贵黑盒函数。
- 需要比较不同优化算法或把优化结果可视化。

## 推荐流程

1. 明确定义变量、上下界、目标方向(min/max)、约束和不可行条件。
2. 先用小规模样例/已知 benchmark 验证问题编码,再跑真实昂贵目标。
3. 对随机算法固定 seed,记录 population size、generations、termination 条件。
4. 多目标结果必须展示 Pareto front,并解释 trade-off;不要只选一个点不说明偏好。
5. 对昂贵目标设置预算、checkpoint 和中间结果保存。

## 防错要点

- 检查目标函数符号:pymoo 常以 minimize 表达,最大化需要取负或转换。
- 约束方向要统一,避免 g(x) <= 0 / >= 0 写反。
- 对 noisy objective,重复评估或使用稳健指标,不要过度解读单次最优。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: Apache-2.0 license.

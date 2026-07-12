---
name: statistical-analysis
description: "Choose and report appropriate statistical tests: assumptions, effect sizes, confidence intervals, multiple testing, power, and reproducible analysis decisions."
version: 1.0.0
tags: [science, statistics, hypothesis-testing, analysis]
related_skills: [statsmodels, pymc, matplotlib]
license: MIT license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# Statistical analysis decision guide

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户问该用什么统计检验/模型、结果是否显著、怎么报告 p 值/置信区间/效应量。
- 需要选择 t-test/ANOVA/nonparametric/chi-square/regression/mixed model/survival/time-series 等方法。
- 需要检查假设、样本量、多重比较或结果报告质量。

## 推荐流程

1. 明确研究问题、变量类型、配对/独立、组数、重复测量、层级结构和样本量。
2. 先画图和做描述性统计,检查异常值、缺失机制、分布和方差结构。
3. 根据研究设计选方法,而不是根据哪个 p 值小选方法。
4. 同时报告效应量、置信区间、样本量、检验假设和多重校正策略。
5. 不满足假设时考虑变换、稳健方法、非参数方法、bootstrap 或模型化替代。

## 防错要点

- p 值不是效应大小;“不显著”不是“无效应”。
- 多指标/多基因/多模型比较要控制 FDR/FWER 或明确探索性。
- 预注册/confirmatory 与 exploratory 分析要分开写;医学统计需领域专家和伦理/监管审阅。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: MIT license.

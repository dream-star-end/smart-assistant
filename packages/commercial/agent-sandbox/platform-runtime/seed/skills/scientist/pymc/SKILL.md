---
name: pymc
description: "Bayesian modeling with PyMC: hierarchical models, MCMC/NUTS, posterior predictive checks, LOO/WAIC comparison, and uncertainty-aware inference."
version: 1.0.0
tags: [science, bayesian, statistics, pymc, uncertainty]
related_skills: [statistical-analysis, statsmodels]
license: Apache License, Version 2.0
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# PyMC Bayesian modeling

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户需要贝叶斯回归、层级模型、部分池化、先验建模、后验不确定性或 posterior predictive checks。
- 频率学模型无法自然表达层级结构、缺失机制、测量误差或先验知识。
- 需要比较模型并解释不确定性,而不是只给点估计和 p 值。

## 推荐流程

1. 写清楚生成过程:观测变量、潜变量、层级、噪声分布、先验和待估参数。
2. 从最小模型开始,确认采样稳定后再加层级/交互/非线性。
3. 检查 MCMC 诊断:R-hat、ESS、divergences、trace plot、energy/BFMI。
4. 用 posterior predictive check 看模型是否能复现实测数据的关键统计特征。
5. 模型比较用 LOO/WAIC 时同时报告不确定性,不要机械选择分数略高的模型。

## 防错要点

- 解释先验选择和敏感性;不要把默认 weakly-informative prior 当作无先验。
- 报告 posterior mean/median、HDI/credible interval、关键概率陈述。
- 如果采样失败,优先重参数化、标准化变量、检查模型结构,不要盲目加 draws。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: Apache License, Version 2.0.

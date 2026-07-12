---
name: statsmodels
description: "Statistical modeling with statsmodels: OLS/GLM, logistic regression, mixed models, time series, diagnostics, robust covariance, and interpretable summaries."
version: 1.0.0
tags: [science, statistics, regression, econometrics, python]
related_skills: [statistical-analysis, pymc]
license: BSD-3-Clause license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# statsmodels statistical modeling

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户需要可解释统计模型:线性/广义线性模型、Logit/Probit、计量模型、时间序列、诊断检验或标准误。
- 需要类似 R 公式语法、系数表、置信区间、假设检验和模型摘要。
- scikit-learn 偏预测,而用户更关心推断和解释时,优先考虑 statsmodels。

## 推荐流程

1. 明确 outcome、predictors、confounders、固定/随机效应、link function 和误差结构。
2. 用公式接口保持模型定义可读;对 categorical variables 明确 reference level。
3. 检查残差、异方差、多重共线性、影响点、自相关和模型拟合优度。
4. 根据数据结构选择稳健/clustered standard errors、mixed model 或 time-series model。
5. 输出系数时解释单位、方向、效应大小和置信区间,不要只贴 summary。

## 防错要点

- 缺失值处理要显式;statsmodels 可能静默 drop rows,必须报告样本数变化。
- 分类变量编码和交互项解释容易出错,必要时用边际效应或预测曲线辅助说明。
- 时间序列模型要检查平稳性、季节性、滞后阶数和 out-of-sample 验证。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: BSD-3-Clause license.

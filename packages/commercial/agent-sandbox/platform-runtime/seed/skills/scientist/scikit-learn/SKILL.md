---
name: scikit-learn
description: "Classical machine learning in Python with scikit-learn: preprocessing, pipelines, model selection, classification, regression, clustering, and evaluation."
version: 1.0.0
tags: [science, machine-learning, sklearn, python, modeling]
related_skills: [statistical-analysis, matplotlib]
license: BSD-3-Clause license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# scikit-learn machine learning

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户要做结构化数据的分类、回归、聚类、降维、特征工程、模型选择或评估。
- 需要可复现、可解释的传统 ML baseline,而不是直接上深度学习。
- 需要 pipeline 防止数据泄漏。

## 推荐流程

1. 明确预测目标、样本粒度、特征可用时间点和评价指标。
2. 先切分数据,再在 training split 内 fit preprocessing;使用 Pipeline/ColumnTransformer 防泄漏。
3. 建立 dummy/linear/tree baseline,再做交叉验证和调参。
4. 分类任务检查 class imbalance、calibration、confusion matrix、ROC/PR;回归任务检查残差和误差分布。
5. 报告验证策略、随机种子、数据切分、指标置信范围和限制。

## 防错要点

- 时间序列、同一患者/用户/样本多行数据不能随机打散;用 GroupKFold/TimeSeriesSplit 等合适切分。
- 不在测试集上做特征选择、缺失值填补参数学习或阈值调优。
- 高准确率不等于可部署;检查偏差、漂移、解释性和科研合理性。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: BSD-3-Clause license.

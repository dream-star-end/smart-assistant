---
name: aeon
description: "Time-series machine learning with aeon: classification, regression, clustering, forecasting, anomaly detection, segmentation, distances, and benchmarking."
version: 1.0.0
tags: [science, time-series, machine-learning, forecasting]
license: BSD-3-Clause license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# aeon time-series machine learning

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户有时间序列、传感器、金融/业务序列、实验过程曲线,想做分类、回归、聚类、预测、异常检测或相似性搜索。
- 需要比较多个 time-series 模型、构造 benchmark、选择距离度量或评估切分策略。
- 需要把非结构化序列问题转成可重复的 Python 分析流程。

## 推荐流程

1. 明确任务类型:forecasting / classification / regression / clustering / anomaly detection / segmentation。
2. 检查数据形状:单变量还是多变量;等长还是不等长;采样频率是否规则;是否有缺失值。
3. 建立基线:先用简单模型或 naive forecast,再引入 aeon 的专用 estimator。
4. 使用时间感知验证:forecasting 用 rolling/temporal split;分类回归避免随机打乱造成泄漏。
5. 汇报指标时同时给 baseline、模型指标、置信区间或重复实验方差。

## 防错要点

- 先检查是否已安装 aeon;缺失时只为当前任务安装必要依赖。
- 数据预处理要保留时间顺序;不要在全量数据上先 fit scaler 再切分。
- 对小样本或强自相关序列,优先做简单可解释模型和误差可视化。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: BSD-3-Clause license.

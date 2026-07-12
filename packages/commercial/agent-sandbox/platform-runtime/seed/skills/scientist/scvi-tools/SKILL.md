---
name: scvi-tools
description: "Deep generative modeling for single-cell omics with scvi-tools: batch correction, latent representations, transfer learning, multimodal/spatial models, and differential expression."
version: 1.0.0
tags: [science, bioinformatics, single-cell, scvi, deep-learning]
related_skills: [scanpy, statistical-analysis]
license: BSD-3-Clause license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# scvi-tools single-cell generative models

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户需要 scVI/scANVI/TOTALVI/MultiVI 等模型做 batch correction、latent embedding、label transfer 或多组学整合。
- Scanpy 标准流程不足以处理强批次效应、半监督注释、多模态数据或 probabilistic differential expression。
- 用户希望在单细胞任务中量化模型不确定性。

## 推荐流程

1. 先用 Scanpy 完成基本 QC,确认 AnnData 字段、batch key、label key、layer/raw counts 是否正确。
2. 只把原始 counts 或合适 layer 交给模型;不要把 log-normalized 数据误当 count 输入。
3. 设置并记录 batch covariates、categorical/continuous covariates、模型版本、seed、训练轮数和硬件。
4. 训练后检查 latent space、batch mixing、biological signal 保留、reconstruction/ELBO 趋势。
5. 差异表达和 label transfer 输出要结合实验设计和验证数据解释,不要给临床结论。

## 防错要点

- 深度模型可能过度校正或抹掉真实生物差异;必须比较校正前后 marker/condition 信号。
- 大数据训练耗 CPU/GPU/内存;先估算资源,必要时抽样 smoke test。
- 私有生物医学数据默认本地处理;外部模型/云训练前先征得用户同意。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: BSD-3-Clause license.

---
name: scanpy
description: "Single-cell RNA-seq analysis with Scanpy: QC, normalization, highly variable genes, PCA/UMAP, clustering, marker genes, and trajectory-ready preprocessing."
version: 1.0.0
tags: [science, bioinformatics, single-cell, rnaseq, scanpy]
related_skills: [scvi-tools, statistical-analysis]
license: BSD-3-Clause license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# Scanpy single-cell RNA-seq analysis

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户要分析 scRNA-seq / single-cell omics 数据,包括 QC、过滤、归一化、降维、聚类、marker gene 和可视化。
- 输入是 .h5ad、10x mtx、AnnData 或表达矩阵。
- 需要构建可复现的单细胞分析 notebook/script。

## 推荐流程

1. 确认数据来源、物种、批次、样本设计、是否含临床/隐私信息。
2. QC:检查每个细胞 UMI/genes、线粒体比例、双细胞风险、空 droplets;记录过滤阈值理由。
3. 标准流程:normalize/log1p → HVG → scale/PCA → neighbors → UMAP/tSNE → Leiden/Louvain clustering。
4. marker 分析要结合 batch/sample composition,不要把 cluster marker 直接解释成因果或诊断结论。
5. 保存中间 .h5ad、图和参数;图上标注样本、批次、cluster、已知 marker。

## 防错要点

- 不做诊断、治疗或患者级结论;若数据可能含 PHI,先确认本地处理和脱敏要求。
- 外部数据库注释或上传分析前必须征得用户同意。
- 对小样本/强批次效应结果要明确不确定性和验证需求。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: BSD-3-Clause license.

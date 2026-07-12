---
name: matplotlib
description: "Publication-quality Python plotting with matplotlib when fine-grained control over axes, typography, layout, annotations, and export format is needed."
version: 1.0.0
tags: [science, plotting, visualization, python, figures]
related_skills: [statistical-analysis]
license: Matplotlib license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# matplotlib scientific plotting

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户要论文图、报告图、复杂坐标轴、多 panel figure、误差条、注释或出版级 PDF/SVG/PNG。
- 需要精确控制字体、线宽、颜色、legend、ticks、子图布局或导出尺寸。
- seaborn/plotly 默认图不够可控时,回到 matplotlib。

## 推荐流程

1. 先明确图要证明什么结论,再选择 line/scatter/bar/box/violin/heatmap/contour/image 等图型。
2. 整理 tidy data 或明确 x/y/error/group columns;图前先检查缺失值、单位和样本量。
3. 写可复现脚本,把数据读取、统计汇总、绘图和导出放在同一文件或 notebook 中。
4. 导出至少一个矢量格式(PDF/SVG)和一个预览 PNG;按目标媒介设置尺寸、DPI 和字体大小。
5. 交付前检查文件存在、尺寸合理、无截断、legend 不遮挡数据。

## 防错要点

- 默认使用色盲友好 palette,不要只靠颜色区分类别;必要时配合线型/marker。
- 坐标轴必须有 label 和单位;科学图优先展示 CI、IQR、error bar、raw points 或样本量。
- 避免 3D、渐变、双 y 轴等容易误导的视觉效果,除非用户明确需要且解释清楚。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: Matplotlib license.

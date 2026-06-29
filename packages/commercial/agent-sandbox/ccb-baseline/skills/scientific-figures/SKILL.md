---
name: scientific-figures
description: 科研图表规范:用 matplotlib + SciencePlots(Nature/IEEE 样式)+ ColorBrewer 出版级配色出图,架构/流程图用 Mermaid/TikZ。**严禁生成式 AI 插画**。要给报告/论文/PPT 配图、画数据图或示意图时使用。
tags: [research, figures, matplotlib, scienceplots]
---

# scientific-figures 科研图表规范

科研产物的图**必须专业、可复现、零 AI 味**。这是 v3 用户最高 ROI 的反馈(生成式插画一眼假)。

## 铁律

- **严禁**用生成式 AI 出"插画/示意图/封面图"(Midjourney/DALL·E/SD 类、或让模型画 base64 图)。一律用确定性工具。
- 数据图:`matplotlib` + **SciencePlots** 样式(Nature/IEEE),配色用 **ColorBrewer**(色盲友好、印刷安全)。
- 架构图/流程图/时序图:**Mermaid**(```mermaid 代码块,前端可渲染)或 **TikZ**(进 LaTeX/Quarto)。
- 图必须有清晰坐标轴标签、单位、图例、caption;字号适配印刷。

## matplotlib + SciencePlots 示例

```python
import matplotlib.pyplot as plt
import scienceplots  # noqa: F401
plt.style.use(['science', 'nature'])  # 或 ['science','ieee']
fig, ax = plt.subplots(figsize=(3.5, 2.6))
ax.plot(x, y, label='method A')
ax.set_xlabel('Epoch'); ax.set_ylabel('Accuracy (%)'); ax.legend()
fig.savefig('/home/agent/.openclaude/research/<id>/fig1.png', dpi=300, bbox_inches='tight')
print('/home/agent/.openclaude/research/<id>/fig1.png')
```

把保存路径单独成行 print,前端渲染成图片卡片;该路径作为 oc-report ReportSchema 的 figure.path。

## 配色 / 可读性

- 离散类别用 ColorBrewer `Set2`/`Dark2`;连续量用 `viridis`/`cividis`(色盲友好)。
- 不用红绿对比传达关键信息(色盲);线型 + 颜色双编码。
- 中文图注用中文字体(已配),英文图用 serif/sans 一致。

## 何时用 Mermaid

系统架构、数据流、流程、时序 → Mermaid;不要用 matplotlib 硬画框线图,也不要用生成式插画。

---
name: research-slides
description: 用 Quarto 把科研内容渲染成规范幻灯片(revealjs HTML 或 .pptx),统一主题、确定性排版、图表用 SciencePlots。要做科研汇报 PPT/slides 时使用。
tags: [research, slides, quarto, pptx]
---

# research-slides 科研幻灯片(Quarto)

科研汇报 slides 用 **Quarto**(运行时镜像内常驻)确定性渲染,统一一套主题;**不要用生成式插画**,图表走 scientific-figures(matplotlib+SciencePlots / Mermaid)。多主题/编辑式 PPT(PPTAgent)是后续增强,当前提供一套规范主题。

## 用法

写 `slides.qmd`(YAML 选主题),用 Bash 调 quarto:

```bash
# revealjs(HTML,推荐:可交互、可嵌图)
quarto render slides.qmd --to revealjs -o /home/agent/.openclaude/research/<id>/slides.html
# 或导 PowerPoint
quarto render slides.qmd --to pptx -o /home/agent/.openclaude/research/<id>/slides.pptx
```

slides.qmd 模板(统一主题):

```markdown
---
title: "汇报标题"
author: "研究团队"
format:
  revealjs:
    theme: [default]
    slide-number: true
    incremental: false
    fig-align: center
lang: zh
---

## 背景与问题

- 要点一(有数据/引用支撑)
- 要点二

## 方法

![](/home/agent/.openclaude/research/<id>/fig1.png)

## 结果

- 关键发现 + 图表(SciencePlots 出图)

## 结论与局限
```

## 规则

- 每页一个论点,文字精简(标题 + 3~5 bullet),细节放讲稿/报告。
- 图来自 scientific-figures(SciencePlots/Mermaid);**禁生成式插画**。
- 引用沿用报告口径:论断有据,不在 slide 里编造数据/DOI。
- 输出末行打印产物绝对路径(前端渲染文件卡片)。

---
name: research-slides
description: 用 `oc-slides`/`oc-poster` 命令行把结构化 SlideDeck/PosterSpec 渲染成规范幻灯(pptx/html,多主题)或学术海报(pdf),确定性排版、PresAesth 美学软检查、图表用 SciencePlots。要做科研汇报 PPT/slides 或会议海报时使用。
tags: [research, slides, poster, quarto]
---

# research-slides 科研幻灯 / 海报(CLI)

汇报产物用 `oc-slides`/`oc-poster` 确定性渲染(自建 Quarto 流水线,运行时镜像内常驻),
统一 design-token 主题;**不要用生成式插画**,图走 scientific-figures(matplotlib+SciencePlots / Mermaid)。

## 幻灯 oc-slides

写 SlideDeck(JSON):`{ title, subtitle?, author?, theme?, slides:[{heading, bullets[], figure?, notes?}] }`,
`theme` ∈ default/nature/ieee/dark/white/league。

```bash
oc-slides --deck deck.json -o /home/agent/.openclaude/research/<id>/slides.pptx   # 或 .html
```

- 每页一个论点,bullets 精简(≤6 条、短句);细节放 `notes`(讲稿)或报告。
- `figure` 指向已生成的图(SciencePlots/Mermaid 路径)。
- 输出 `warnings` 含 PresAesth 美学软信号(要点过多/过长/疑似生成式插画)—— 据此修。

## 海报 oc-poster

写 PosterSpec(JSON):`{ title, authors?, affiliation?, columns?(2~4), sections:[{heading, bodyMd, figure?}] }`。

```bash
oc-poster --spec poster.json -o /home/agent/.openclaude/research/<id>/poster.pdf
```

## 规则

- 论断有据:slide/海报里的事实/数据沿用报告口径,不编造数字/DOI。
- 图表零生成式插画(PresAesth 会软标);多主题切 `theme` 即可。
- 渲染失败(无 quarto)降级产出 `.qmd`,仍可读;据此告知用户。
- 输出末行打印产物绝对路径(前端渲染文件卡片)。

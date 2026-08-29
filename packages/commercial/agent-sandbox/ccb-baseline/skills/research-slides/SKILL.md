---
name: research-slides
description: 用 `oc-slides`/`oc-poster` 把结构化内容做成可编辑的专业 PPTX/HTML 幻灯或学术海报 PDF,覆盖工作汇报、方案宣讲、会议演示和科研报告;确定性排版并用真实渲染页检查裁切、层级、字体和可读性。
tags: [office, research, slides, ppt, presentation, poster, quarto]
---

# research-slides 专业幻灯 / 科研海报(CLI)

汇报产物用 `oc-slides`/`oc-poster` 确定性渲染(自建 Quarto 流水线,运行时镜像内常驻),
统一 design-token 主题;**不要用生成式插画**,图走 scientific-figures(matplotlib+SciencePlots / Mermaid)。

## 幻灯 oc-slides

写 SlideDeck(JSON):`{ title, subtitle?, author?, theme?, slides:[{heading, bullets[], figure?, notes?}] }`,
`theme` ∈ default/nature/ieee/dark/white/league。

```bash
oc-slides --deck deck.json -o /home/agent/.openclaude/research/<id>/slides.pptx   # 或 .html
```

- 先写完整叙事线,再拆页;每页一个明确结论,内容多时继续拆页而不是缩成小字或截断。
- 使用一致网格、边距、标题层级和对齐;正文用短句,细节放 `notes`(讲稿)或配套报告。
- `figure` 指向已生成的图(SciencePlots/Mermaid 路径)。
- 输出 `warnings` 含 PresAesth 美学软信号(要点过多/过长/疑似生成式插画)—— 据此修。

### PPTX 交付前真实渲染

```bash
cat > qa-expect.json <<'JSON'
{"kind":"pptx","requiredText":["汇报标题","核心结论"],"minSlides":1}
JSON
oc-artifact-qa inspect --input slides.pptx --out-dir slides.pptx.qa --expect qa-expect.json
```

检查全部 `contact-sheets`/逐页 PNG:无裁切、重叠、字体替换、拉伸或层级混乱;同时确认
`report.json.passed=true`、幻灯数一致、关键文字在渲染结果里可提取。失败就修改 deck/图表后
重新渲染到新 QA 目录,不能只检查 JSON 源或声称“已验证”。

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

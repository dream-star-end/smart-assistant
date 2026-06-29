---
name: research-report
description: 用 `oc-report` 命令行把结构化 ReportSchema + 已校验 evidence manifest 渲染成规范报告(PDF/docx/HTML),章节/编号/交叉引用/参考文献由引擎保证,未接地论断自动红标。要输出科研报告/综述/调研文档时使用。
tags: [research, report, quarto, citation]
---

# research-report 确定性报告渲染(CLI)

把报告**结构**(ReportSchema:标题/摘要/章节/图表/参考文献顺序)+ **已校验证据**(oc-cite check 输出的 evidence manifest)交给 `oc-report`,由引擎排版。**不要让模型自己排版或编参考文献** —— 章节编号、引用角标、参考文献格式(GB/T7714 等)全部由引擎确定性生成。

## 工作流

1. researcher 用 oc-lit/oc-ingest/oc-litrag 产 evidence manifest,经 `oc-cite check` 得"已校验 manifest"(claim.status 由平台铸造)。
2. 写 ReportSchema(JSON):`{ title, abstract?, sections[{id,heading,level,bodyMd,claimRefs}], figures[{id,path,caption,kind}], bibliography[sourceId], csl }`。
   - 正文 `bodyMd` 里用 `[[claim:<id>]]` 占位引用,引擎会替换成编号角标 `[N]`。
   - **只引用 manifest 里 status=verified 的 claim**;unsupported/unchecked 的 claim 引擎会自动红标"[未核查]",不要试图绕过。
   - 图表 `path` 指向已生成的图(SciencePlots 出图,见 scientific-figures);**禁生成式插画**。
3. 渲染:

```bash
oc-report --schema report-schema.json --manifest checked-manifest.json -o /home/agent/.openclaude/research/<id>/report.pdf
```

支持 `.pdf` / `.docx` / `.html` / `.md`。输出末行是产物绝对路径(前端渲染成文件卡片)。

## 规则

- `csl` 中文报告用 `gb-t-7714-2015`,英文用 `apa`。
- 引擎返回的 `warnings`(覆盖率、红标 claim)要如实转达用户,不要隐瞒未核查比例。
- 渲染失败(无 quarto/pandoc)会降级产出 `.qmd`,仍可读;据此告知用户。
- 不要手写"参考文献"段或编造 DOI —— 参考文献来自 manifest 已校验来源,由引擎编号格式化。

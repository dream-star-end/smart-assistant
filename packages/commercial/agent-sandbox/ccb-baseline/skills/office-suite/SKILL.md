---
name: office-suite
description: 中文办公高频任务总纲:周报/月报/工作总结、汇报PPT、会议纪要(含待办与责任人)、公文/通知/请示、简历、邮件与日程。把"读资料→分析→出交付物"串成端到端闭环。用户提这些办公场景时,按本 skill 选对工具链并交付可下载文件。
tags: [office, report, ppt, meeting, gongwen, resume, email]
priority: 9
---

# 中文办公工作流总纲

你是"办公助手"。办公真实需求往往是一条**链**:读长文档/数据 → 分析 → 产出可下载交付物(Word/Excel/PPT/PDF)。别停在"给一段文字",要**交付文件**并给绝对路径。

## 工具速查(全在容器内,直接调)

| 交付物 | 工具 | 详见 skill |
|---|---|---|
| Word/报告/公文 | `oc-docx`(Markdown/Quarto→docx,公式原生) | document-writing |
| Excel/数据表 | `oc-xlsx` + openpyxl/pandas/duckdb | office-spreadsheet |
| PDF | `oc-pdf`(Typst) / reportlab | office-pdf |
| PPT 汇报 | `oc-slides --deck deck.json -o out.pptx` | research-slides |
| PDF/PPTX/XLSX 交付检查 | `oc-artifact-qa inspect --input <文件> --out-dir <新目录> --expect <JSON>` | 对应文档 skill |
| 配图/头图/语音 | `mmx image|speech` | minimax-media |
| 读网页/长文档/Office 文件 | `oc-web extract <url>` / `oc-web parse <文件>` | web-context |
| 图表 | matplotlib(出 PNG)/ ` ```mermaid ` / ` ```chart ` | scientific-figures / platform-capabilities |

## 高频任务 playbook

### 1. 周报 / 月报 / 工作总结
问清:周期、条线、受众(给领导还是团队)。结构默认"本期进展→数据/成果→问题与风险→下期计划"。有数据就先 `oc-xlsx` 出表/图,再写进 Markdown,`oc-docx` 出 Word(或 `oc-pdf` 出 PDF)。避免空话套话,用具体数字和事实。

### 2. 汇报 PPT
先定叙事线(背景→问题→方案→数据→结论→计划),每页一个结论;内容多就拆页,不缩成小字或截断。用 `oc-slides --deck` 的 SlideDeck JSON 出真·可编辑 pptx(不要用 HTML/图片冒充 PPT)。需要配图用 `mmx image` 或 matplotlib/mermaid。交付前用 `oc-artifact-qa` 渲染全部页面并检查。详见 research-slides skill 的 deck 格式。

### 3. 会议纪要(含待办与责任人)
输入可以是用户给的录音转写文本 / 速记 / 要点。产出四段:**议题结论、关键决策、待办事项(任务|责任人|截止)、遗留问题**。待办用表格,能落 `oc-xlsx` 就落表,便于跟踪。忠实于原文,不臆造决策或责任人;信息缺失就标"待明确"。
> 音频自动转写(ASR)当前不在本容器内置能力;用户给音频文件时,先如实说明"请提供转写文本或用平台语音输入",不要编造会议内容。

### 4. 公文 / 通知 / 请示 / 简报(中文护城河)
体制内/国企/学校常用。守规范:
- **格式**:标题(发文机关+事由+文种)、主送机关、正文(缘由→事项→要求)、落款(单位+日期)、必要时"特此通知/请批示"。
- **文种别混**:通知/通报/请示/报告/函/纪要各有用途,按场景选对。
- **语体**:庄重、简洁、准确;避免口语和网络用语。
- **稳妥**:涉及数字、单位名称、人名、日期必须让用户确认,不臆造;敏感/表态性措辞保守,拿不准就提示用户复核。
用 `oc-docx` 出 Word(可套用户上传的红头 `reference.docx`),或 `oc-pdf` 出 PDF。

### 5. 简历
按目标岗位 JD 定制:突出与 JD 匹配的经历,成果**量化**(数字、比例、影响),动词开头。一页优先。`oc-docx` 出 Word,或 `oc-pdf` 出 PDF。

### 6. 邮件 / 日程
邮件:明确目的、重点前置、礼貌得体、给出明确 next step。日程/会议邀请可用 `icalendar` 生成 `.ics`:

```python
from icalendar import Calendar, Event
from datetime import datetime
cal = Calendar(); ev = Event()
ev.add("summary", "项目评审会"); ev.add("dtstart", datetime(2026,7,3,14,0)); ev.add("dtend", datetime(2026,7,3,15,0))
cal.add_component(ev)
open("/home/agent/.openclaude/邀请.ics","wb").write(cal.to_ical())
```
> 真正收发邮件需用户授权自己的邮箱(连接器方向),当前仅生成草稿/附件/.ics,不代登录任何账号。

### 7. 长文档 / PDF 总结与提炼
`oc-web parse <文件>` 或 `pdfplumber` 读入 → 结构化总结 → 需要时出脑图(mermaid)/要点表(oc-xlsx)/汇报(oc-slides)。总结要标来源(页码/章节),区分事实与推断。

## 交付纪律

- **产文件、给绝对路径**(如 `/home/agent/.openclaude/周报.docx`),不要只回一段文本了事。
- PDF/PPTX/XLSX 必须先过对应 skill 的 `oc-artifact-qa` 结构与渲染闭环;不能只验证扩展名或复述“已检查”。
- 一次任务尽量**闭环交付**(数据→分析→成品),必要时同时给 Word + PDF 两种格式。
- 事实性内容(数字、人名、单位、日期、决策、责任人)**忠实于用户提供的信息**,缺失标"待明确",绝不臆造。
- 合规:不代登录/爬取任何需要账号或付费墙的内容;不装/用 AGPL/GPL 传染性许可库。

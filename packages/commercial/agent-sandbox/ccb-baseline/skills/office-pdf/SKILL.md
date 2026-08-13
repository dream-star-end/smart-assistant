---
name: office-pdf
description: 生成与处理 PDF:把报告/方案/合同/通知排版成 PDF、程序化生成票据/表单、合并拆分加水印、解析已有 PDF 并按页码溯源总结。用户要"导出 PDF""做个 PDF 合同/发票""合并这几个 PDF""这份 PDF 讲了什么/帮我总结"时调用。
tags: [office, pdf, report, parse, ocr]
priority: 7
---

# PDF 生成与处理

容器内已预装:`oc-pdf`(Quarto→Typst 排版,**无需 LaTeX**)、`reportlab`(程序化精确排版)、`pypdf`(合并/拆分/水印)、`pdfplumber`(解析取文本+表格+页码)、`markitdown`(多格式→Markdown)。中文由 `fonts-noto-cjk` 提供。

## 1. 格式化文档 → PDF(首选 oc-pdf)

报告、方案、合同、通知这类"结构化文档 → PDF",写 Markdown 再一条命令:

```bash
oc-pdf report.md -o /home/agent/.openclaude/方案.pdf
# 换字体(默认 Noto Serif CJK SC):
oc-pdf --mainfont "Noto Sans CJK SC" notice.md -o notice.pdf
```

支持标题/列表/表格/代码/LaTeX 数学 `$...$`。同一份 Markdown 可分别产 Word(`oc-docx`)和 PDF(`oc-pdf`),交付两种格式。

## 2. 票据/表单/证书:reportlab 精确排版

需要固定坐标、印章位、表格边框的票据类,直接写 Python 用 reportlab。**中文必须注册 CJK 字体**,否则是豆腐块:

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("WQY", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", subfontIndex=0))
c = canvas.Canvas("/home/agent/.openclaude/发票.pdf", pagesize=A4)
c.setFont("WQY", 20); c.drawString(72, 760, "收 据")
c.setFont("WQY", 12); c.drawString(72, 720, "今收到:甲方  金额:¥1,000.00")
c.showPage(); c.save()
```

> 找不到字体文件时用 `fc-list :lang=zh` 定位字体。ReportLab 的 `TTFont` 不支持
> Noto CJK TTC 里的 PostScript outlines;固定版式应使用镜像预装的文泉驿正黑 TTC
> (`subfontIndex=0`)，它能同时覆盖中文、Latin、数字和常用符号；再通过 QA 的
> `pdffonts` 结果确认 embedded/unicode 都为 true。

## 3. 合并 / 拆分 / 水印:pypdf

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for f in ["a.pdf", "b.pdf"]:
    for p in PdfReader(f).pages: w.add_page(p)
with open("/home/agent/.openclaude/合并.pdf", "wb") as fo: w.write(fo)
```

## 4. 解析已有 PDF + 按页码溯源

总结/问答用户上传的 PDF 时,**保留页码来源**(可信、可回查):

```python
import pdfplumber
with pdfplumber.open("上传.pdf") as pdf:
    for i, page in enumerate(pdf.pages, start=1):
        text = page.extract_text() or ""
        # 逐页处理,给结论时标注"(见第 i 页)"
        for tbl in page.extract_tables():
            ...  # 表格另行结构化
```

快速把整份 PDF/Office 文件转 Markdown 再理解,用 `oc-web parse <文件>`(markitdown)。总结时明确区分"原文页码支撑的事实"与"你的推断",不要臆造页码。

> 扫描件/图片型 PDF 的 OCR(PaddleOCR/ocrmypdf)属 P1 增强,当前镜像未装;遇纯扫描件先如实告知用户"需要 OCR",不要编造内容。

## 5. 交付前验证:渲染后再交付

```bash
cat > qa-expect.json <<'JSON'
{"kind":"pdf","requiredText":["文档标题","必须出现的关键文字"],"minPages":1}
JSON
oc-artifact-qa inspect --input out.pdf --out-dir out.pdf.qa --expect qa-expect.json
```

查看 `out.pdf.qa/contact-sheets/` 或逐页 PNG,确认没有裁切、重叠、空白页、乱码和字体替换;
发现问题就修源文件并重新生成到新的 QA 目录。`report.json` 的 `passed` 必须为 true,不能把
“命令运行成功”或最终回复里的自述当验证。最终回复给**绝对路径**,并简述 QA 结果。

## 工具调用纪律(重要)

- 生成 PDF 优先 `oc-pdf`(格式化文档)或 reportlab(精确排版),不要用 HTML 截图冒充 PDF。
- 中文一定用 CJK 字体;以 `oc-artifact-qa` 的文本、嵌入字体和全部渲染页证据确认无豆腐块。
- 合规红线:**绝不装或用 PyMuPDF(AGPL,SaaS 触发源码披露)/ Marker(GPL)**;PDF 解析一律用 `pdfplumber`(MIT)/`pypdf`(BSD)/`markitdown`(MIT)。

---
name: document-writing
description: 用 Pandoc/Quarto 生成排版美观、公式为 Word 原生可编辑格式的 DOCX/Word 文档。用户要求写报告、论文、方案、含公式 Word、导出 docx 时调用。
---

# 高质量 Word/DOCX 写作流程

当用户要 **Word / DOCX / 报告 / 论文 / 含公式文档** 时,不要手写 HTML 再改扩展名,也不要把公式截图塞进 Word。默认采用源文档管线:

```text
结构化 Markdown/Quarto + LaTeX 公式
  → Pandoc/Quarto
  → DOCX(Word 原生 OMML 公式,可继续编辑)
```

## 0. 先选格式

- **长报告、论文、技术文档、需要标题页/目录/交叉引用/代码块**:写 `.qmd`,用 Quarto。
- **简单 Markdown 文档、快速交付 Word**:写 `.md`,用 `oc-docx` 的 Pandoc 路径。
- **用户已有 Word 模板**:让用户上传/指定 `reference.docx`,用 `--reference-doc` 套样式。

容器内应已有工具:

```bash
quarto --version
pandoc --version      # OpenClaude 包装为 Quarto bundled Pandoc
oc-docx --help
```

## 1. 写源文档规则

1. 标题层级清楚:`#` / `##` / `###`,不要跳级。
2. 公式必须保留 LaTeX 源:
   - 行内公式:`$a^2 + b^2 = c^2$`
   - 块公式:
     ```tex
     $$
     E = mc^2
     $$
     ```
3. 表格优先用 Markdown pipe table;复杂表格先生成 CSV/Markdown,不要用空格对齐。
4. 图片用 Markdown 语法并写 caption/alt:`![图 1: 说明](figure.png)`。
5. 中文报告默认中英文混排,避免全角/半角混乱;数学变量仍用 LaTeX。
6. 不确定公式是否合法时,先生成一个最小 DOCX 测试,不要等全文写完才发现公式坏。

## 2. 推荐 Quarto 模板

`report.qmd` 可从这个骨架开始:

```markdown
---
title: "文档标题"
subtitle: "可选副标题"
author: "OpenClaude"
format:
  docx:
    toc: true
    number-sections: true
    reference-doc: /usr/local/share/openclaude-docgen/reference.docx
---

# 摘要

这里写摘要。

# 方法

行内公式 $a^2 + b^2 = c^2$。

$$
E = mc^2
$$

# 结论

这里写结论。
```

生成:

```bash
quarto render report.qmd --to docx
```

如果想指定输出路径,更省心用平台 helper:

```bash
oc-docx --quarto report.qmd -o /home/agent/.openclaude/report.docx
```

## 3. 快速 Markdown → Word

```bash
cat > /home/agent/.openclaude/report.md <<'EOF_MD'
# 标题

这是正文,公式 $x = y^2$。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
EOF_MD

oc-docx /home/agent/.openclaude/report.md -o /home/agent/.openclaude/report.docx
```

默认样式模板:

```text
/usr/local/share/openclaude-docgen/reference.docx
```

用户给了自己的模板时:

```bash
oc-docx report.md --reference-doc /path/to/reference.docx -o final.docx
```

## 4. 交付前必须验证

生成 DOCX 后至少跑:

```bash
test -s /path/to/final.docx
unzip -tq /path/to/final.docx
```

如果文档含公式,再确认有 Word 原生公式 OMML:

```bash
unzip -p /path/to/final.docx word/document.xml | grep -q 'm:oMath' \
  && echo 'OK: native Word equations found'
```

如果没有 `m:oMath`,说明公式可能被当普通文本或图片处理了:回到源文档检查 `$...$` / `$$...$$` 是否闭合,不要交付。

## 5. 给用户的交付方式

- 最终回复里给 **绝对路径**,例如:`/home/agent/.openclaude/report.docx`。
- 简短说明:文档由 Pandoc/Quarto 生成,公式是 Word 原生可编辑公式。
- 如果同时生成了源 `.qmd/.md`,也给路径,方便用户后续修改再导出。

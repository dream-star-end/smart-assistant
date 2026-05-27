---
name: document-writing
description: Generate polished Word/DOCX documents with Pandoc/Quarto, keeping formulas as native editable Word equations. Use when the user asks for reports, papers, proposals, Word files, DOCX export, or formula-heavy documents.
---

# Document writing with high-quality DOCX output

Use this skill when producing **Word / DOCX / reports / papers / formula-heavy documents**. Do not fake a Word file by saving HTML with a `.docx` extension, and do not turn equations into screenshots unless the user explicitly asks for images.

Preferred pipeline:

```text
Structured Markdown or Quarto + LaTeX math
  -> Pandoc/Quarto
  -> DOCX with native Word OMML equations
```

## Choose the source format

- Use `.qmd` + Quarto for long reports, papers, technical docs, title pages, tables of contents, section numbering, cross references, or code-heavy documents.
- Use `.md` + Pandoc for simple Word exports.
- If the user provides a Word template, pass it as `--reference-doc`.

Available runtime tools:

```bash
quarto --version
pandoc --version      # wrapper around Quarto's bundled Pandoc
oc-docx --help
```

Default style reference:

```text
/usr/local/share/openclaude-docgen/reference.docx
```

## Source rules

1. Keep heading levels clean: `#`, `##`, `###`; do not skip levels.
2. Keep equations as LaTeX source:
   - Inline: `$a^2 + b^2 = c^2$`
   - Display:
     ```tex
     $$
     E = mc^2
     $$
     ```
3. Use Markdown tables or CSV-derived tables; do not align tables with spaces.
4. Include captions/alt text for images: `![Figure 1: explanation](figure.png)`.
5. For mixed Chinese/English documents, keep prose in natural Chinese/English but keep mathematical variables in LaTeX.

## Recommended Quarto skeleton

```markdown
---
title: "Document Title"
subtitle: "Optional subtitle"
author: "OpenClaude"
format:
  docx:
    toc: true
    number-sections: true
    reference-doc: /usr/local/share/openclaude-docgen/reference.docx
---

# Summary

Write the summary here.

# Method

Inline equation $a^2 + b^2 = c^2$.

$$
E = mc^2
$$

# Conclusion

Write the conclusion here.
```

Render with either:

```bash
quarto render report.qmd --to docx
```

or, when an explicit output path is useful:

```bash
oc-docx --quarto report.qmd -o /home/agent/.openclaude/report.docx
```

## Quick Markdown to Word

```bash
oc-docx /home/agent/.openclaude/report.md -o /home/agent/.openclaude/report.docx
```

With a user template:

```bash
oc-docx report.md --reference-doc /path/to/reference.docx -o final.docx
```

## Required verification before delivery

Always verify the output exists and is a valid DOCX zip:

```bash
test -s /path/to/final.docx
unzip -tq /path/to/final.docx
```

If formulas are expected, verify native Word equations are present:

```bash
unzip -p /path/to/final.docx word/document.xml | grep -q 'm:oMath' \
  && echo 'OK: native Word equations found'
```

If `m:oMath` is missing for a formula-heavy document, inspect the source for broken `$...$` or `$$...$$` delimiters before delivering.

## Delivery

Reply with absolute paths only, for example:

```text
/home/agent/.openclaude/report.docx
/home/agent/.openclaude/report.qmd
```

Briefly mention that the DOCX was generated through Pandoc/Quarto and formulas are native editable Word equations when verified.

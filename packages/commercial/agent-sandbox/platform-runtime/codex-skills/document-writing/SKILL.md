---
name: document-writing
description: Generate polished Word/DOCX documents through Pandoc/Quarto or structured YAML/JSON, then render and inspect every page and scrub private metadata before delivery. Use for reports, papers, proposals, Word files, DOCX export, or formula-heavy documents.
---

# High-quality Word/DOCX authoring and page-by-page QA

A created `.docx` is only an intermediate artifact. Before delivery, always complete: **generate → render every page → structural inspection → visual review of every page → fix and re-render if needed → metadata scrub → final structural verification**. Never rename HTML/plain text to `.docx`, and never rasterize equations unless the user explicitly requests images.

## Choose the authoring path

Use `convert` for editable Word equations, citations/cross-references, image-heavy documents, or a user-supplied Word template:

```bash
oc-docx convert report.qmd -o /home/agent/.openclaude/generated/report-draft.docx
oc-docx convert report.md --reference-doc /path/to/reference.docx \
  -o /home/agent/.openclaude/generated/report-draft.docx
# Legacy `oc-docx report.md -o ...` remains supported.
```

Keep equations as LaTeX `$...$` / `$$...$$`; Pandoc/Quarto converts them to native editable OMML.

Use `build` when the document has no equations/cross-references but needs a polished cover, header/footer, theme, callouts, code blocks, quotes, or styled tables:

```yaml
document:
  title: Document title
  author: Only set when explicitly requested by the user
  cover: true
  table_of_contents: true
  table_of_contents_mode: static  # static / field / both
sections:
  - heading: First section
    level: 1
    blocks:
      - type: paragraph
        text: Body text
      - type: callout
        kind: warning  # info / warning / success / danger
        title: Note
        text: Important information
      - type: table
        headers: [Column A, Column B]
        rows: [[A, B]]
```

Supported blocks: `paragraph`, `bullets`, `numbered`, `code`, `table`, `quote`, `callout`, `link`, `page_break`.

```bash
oc-docx build content.yaml -o /home/agent/.openclaude/generated/report-draft.docx
```

## Mandatory render and visual inspection

The QA directory must be inside the vision-safe generated root:

```bash
QA=/home/agent/.openclaude/generated/report-qa
oc-docx render /home/agent/.openclaude/generated/report-draft.docx -o "$QA" --emit-pdf
oc-docx inspect /home/agent/.openclaude/generated/report-draft.docx \
  --render-dir "$QA" --json "$QA/report.json"
```

For each page, `render` keeps the 160-DPI `page-N.png` and creates a matching, sub-4.5MB `vision-page-N.jpg`. Enumerate every vision copy in natural order, with no sampling or page limit:

```bash
find "$QA" -maxdepth 1 -type f -name 'vision-page-*.jpg' -print | sort -V
oc-vision understand "$QA/vision-page-1.jpg" --prompt \
  "Check this page for clipping, broken tables, odd page breaks, missing glyphs, header/footer errors, blank pages, or overcrowding. Return PASS or list concrete issues."
# Repeat for every path returned by find.
```

If any page fails, edit the source, regenerate, re-render, re-run inspect, and visually review every page again. Automated warnings do not replace visual review.

## Privacy cleanup and final validation

Do not use `author: OpenClaude`. Preserve title and preserve author only when explicitly requested:

```bash
oc-docx scrub /home/agent/.openclaude/generated/report-draft.docx \
  -o /home/agent/.openclaude/generated/report.docx --keep-title
# Add --keep-author only for an explicitly requested author.
oc-docx inspect /home/agent/.openclaude/generated/report.docx
unzip -tq /home/agent/.openclaude/generated/report.docx
```

For formula documents, verify scrub preserved editable equations:

```bash
unzip -p /home/agent/.openclaude/generated/report.docx word/document.xml | grep -q 'm:oMath'
```

Scrub changes metadata/`rsid`, not visible layout, so it does not require another render after a passed visual review.

## Delivery

Return the absolute path of the cleaned final DOCX and any requested source file. Do not deliver internal QA images unless requested. Use only the documented `oc-docx`/`oc-vision` commands; never invent URLs, ports, tokens, or curl fallbacks.

---
name: document-writing
description: 用 Pandoc/Quarto 或结构化 YAML/JSON 生成高质量 DOCX，并在交付前完成逐页视觉质检、结构检查和隐私清理。用户要求 Word、DOCX、报告、论文、方案或公式文档时调用。
priority: 8
---

# 高质量 Word/DOCX 写作与逐页质检

生成成功只是中间结果。交付 `.docx` 前必须完成：**生成 → 渲染全部页面 → 结构检查 → 逐页视觉检查 → 必要时修复并重新渲染 → 隐私清理 → 最终结构复验**。不得把 HTML/纯文本改扩展名冒充 Word，也不得把公式截图塞进文档。

## 1. 选对生成路线

### Pandoc / Quarto：公式、引用和用户模板

以下任一条件成立时使用 Markdown/Quarto 路线：

- 需要 Word 原生可编辑公式、引用、交叉引用或复杂图片；
- 用户上传了 `reference.docx`；
- 长论文/技术报告需要 Quarto 的目录、编号和文献能力。

公式保留 LaTeX 源，交给 Pandoc 转成 OMML：

```markdown
行内公式 $a^2+b^2=c^2$。

$$
E=mc^2
$$
```

```bash
oc-docx convert report.qmd -o /home/agent/.openclaude/generated/report-draft.docx
# 旧调用仍兼容：oc-docx report.md -o ...
oc-docx convert report.md --reference-doc /path/to/reference.docx -o /home/agent/.openclaude/generated/report-draft.docx
```

### 仿真数据单源绑定（防改 A 坏 B）

实验/仿真数值必须由脚本统一导出为 `metrics.json`，源稿 `.md/.qmd` 用模板占位符引用（如 `{{metric:key.path|.2f}}`、`{{metric:key.path|fmt:.2%}}`、`{{metric:key.path|scale:100|.1f}}`，或在 frontmatter 声明 `metrics: metrics.json`），**严禁手抄实验数字**导致正文与图表脱节：

```bash
oc-docx convert report.md --metrics metrics.json -o /home/agent/.openclaude/generated/report-draft.docx
```

缺失 key、值为 `null`/`NaN`/`Inf` 或路径非法时会 fail-closed 直接报错退出，避免带错数成稿。

### 结构化 YAML/JSON：封面、主题和精排组件

没有公式/交叉引用，但强调封面、页眉页脚、主题、callout、代码块或表格精排时使用：

```yaml
document:
  title: 文档标题
  subtitle: 可选副标题
  author: 仅在用户明确指定时填写
  cover: true
  table_of_contents: true
  table_of_contents_mode: static  # static / field / both
  footer: 可选页脚
  fonts:
    east_asia: Noto Sans CJK SC
    latin: DejaVu Sans
    mono: DejaVu Sans Mono
sections:
  - heading: 第一章
    level: 1
    blocks:
      - type: paragraph
        text: 正文
      - type: bullets
        items: [第一项, 第二项]
      - type: code
        language: python
        text: |
          print("hello")
      - type: table
        caption: 表 1
        headers: [列一, 列二]
        rows: [[A, B]]
      - type: callout
        kind: warning  # info / warning / success / danger
        title: 注意
        text: 风险说明
```

支持 block：`paragraph`、`bullets`、`numbered`、`code`、`table`、`quote`、`callout`、`link`、`page_break`。

```bash
oc-docx build content.yaml -o /home/agent/.openclaude/generated/report-draft.docx
```

## 2. 科研静态预检门禁（`oc-docx check`）

交付或送审前必跑静态门禁（源稿含公式时加 `--expect-formulas`）：

```bash
oc-docx check /home/agent/.openclaude/generated/report-draft.docx --expect-formulas
```

自动拦截以下硬伤并输出 `symbol_table`（数学符号定义覆盖表）供复核：
- 正文/表格/脚注残余占位符：`[需核查]`、`[待补]`、`TODO`、`FIXME`、`{{...}}`（含未展开的 `{{metric:...}}`）、`[[claim:...]]`；
- 图/表/式/参考文献交叉引用断号、重复题注编号或异常跳号；
- 原生 OMML 公式缺失/乱码；
- LibreOffice 渲染吞掉中文段尾标点（`pdf_punctuation_loss`）。

## 3. 保真读稿与审阅已有 DOCX（`oc-docx extract --latex`）

读取或审阅已有 `.docx` 时**严禁直接裸抽纯文本丢公式**；必须使用保真抽取无损还原 OMML 为 LaTeX + Markdown 表格 + 标题层级：

```bash
oc-docx extract paper.docx --latex
# 大文档避免 20MB 炸链：先取目录索引，再按节切片读取
oc-docx extract paper.docx --toc
oc-docx extract paper.docx --section "3" --latex
```

## 4. 标黄修订双交付、结构守恒与去 AI 味

基于旧稿改稿修订时，必须产出「干净版 + 标黄修订版」双交付，并核查 `structure_conservation`（防误删章节、表格列、公式或参考文献；需硬拦截时加 `--strict-structure`），随后运行确定性风格体检：

```bash
oc-docx diff --base old.docx --revised new.docx \
  --out-clean /home/agent/.openclaude/generated/clean.docx \
  --out-highlighted /home/agent/.openclaude/generated/marked.docx

oc-stylecheck /home/agent/.openclaude/generated/clean.docx
# 若存在用户风格画像，叠加自定义禁忌词
oc-stylecheck /home/agent/.openclaude/generated/clean.docx \
  --style-file /home/agent/.openclaude/research/style/profile.md
```

## 5. 强制逐页质量闭环

QA 目录必须位于 vision 可信根，固定使用：

```bash
QA=/home/agent/.openclaude/generated/report-qa
oc-docx render /home/agent/.openclaude/generated/report-draft.docx -o "$QA" --emit-pdf
oc-docx inspect /home/agent/.openclaude/generated/report-draft.docx \
  --render-dir "$QA" --json "$QA/report.json"
```

`render` 为每一页同时生成：

- `page-N.png`：160 DPI 原始页面，保留作高精度复核；
- `vision-page-N.jpg`：最长边/质量按 4.5MB 预算自动规范化，供当前模型的原生视觉读图使用。

必须按自然页序枚举**全部**视觉副本，不得设页数上限、抽样或因单页过大跳过：

```bash
find "$QA" -maxdepth 1 -type f -name 'vision-page-*.jpg' -print | sort -V
# 用当前模型的原生视觉能力逐页查看 vision-page-N.jpg（例如 Read 这些路径），检查裁切、表格断裂、异常分页、缺字乱码、页眉页脚错误、空白页或过度拥挤；明确给出 PASS 或问题。
# 不要调用已下线的 oc-vision。
```

任何一页有问题：修改源 `.qmd/.md/.yaml/.json`，重新生成、render、inspect，并从第一页重新逐页检查。`inspect` 的自动警告不能替代视觉检查。

## 6. 隐私清理与最终验证

默认不写 `author: OpenClaude`。只有用户明确指定作者时才保留作者属性：

```bash
oc-docx scrub /home/agent/.openclaude/generated/report-draft.docx \
  -o /home/agent/.openclaude/generated/report.docx --keep-title
# 用户明确要求保留作者时再加 --keep-author

oc-docx inspect /home/agent/.openclaude/generated/report.docx
unzip -tq /home/agent/.openclaude/generated/report.docx
```

含公式时还必须确认清理后仍为原生 OMML：

```bash
unzip -p /home/agent/.openclaude/generated/report.docx word/document.xml | grep -q 'm:oMath'
```

scrub 只清理元数据和 `rsid`，不改变可见版式；因此通过视觉质检后无需因 scrub 重渲染，但最终 ZIP/结构/OMML 必须复验。

## 7. 交付

```bash
oc-docx convert ... [--metrics metrics.json] -o "$OUT.docx"
oc-docx check "$OUT.docx" --expect-formulas   # 源含 $ 时；拦截占位符/断号引用/OMML/行尾标点丢失
# VERDICT!=PASS → 改源再 convert，最多 2 轮，然后失败明示
oc-stylecheck "$OUT.docx"                     # 可叠加 --style-file 去 AI 味体检
oc-docx scrub ...
oc-artifact-qa deliver --input "$FINAL.docx"
# L0 FAIL → 同一生成命令最多再跑 1 次（换输出文件名）；第二次仍 FAIL → 把 failures[].message 告诉用户，禁止再打印该路径
```

只打印 FINAL 绝对路径，单独成行；禁止放进 fenced code；禁止发明 URL/端口/token。不要把 `.deliver.json` sidecar 当交付物。≥2 个交付文件先 `oc-artifact-qa pack --out /home/agent/.openclaude/generated/<stem>.zip -- f1 f2`，只打印 zip 路径。

最终只交付清理后的 `.docx`（以及用户需要的源文件/标黄修订版）。不要把 QA PNG/JPEG 当正式附件，除非用户明确要求。

## 工具调用纪律

只调用本 skill 给出的 `oc-docx` / `oc-docxcheck` / `oc-stylecheck` / `oc-artifact-qa` / 本地校验命令；绝不自行拼 `curl`、URL、端口或 token。命令失败时读清错误并修正输入/路径，不能用 HTML 改扩展名兜底。

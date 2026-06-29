---
name: oc-ingest
description: 用 `oc-ingest` 命令行把用户上传的论文/文档(PDF/TXT/MD/HTML 等)解析成可检索、可引用接地的权威文档。用户上传了 PDF/CAJ/文档要"读这篇""基于这篇分析/综述/提取证据"时使用。解析在平台侧完成,产出 docId 供 oc-litrag 检索。
tags: [research, ingest, parse, pdf]
---

# oc-ingest 文档解析(CLI)

把用户的文档解析成**平台权威文档**:平台从文件字节铸造不可变的 NormalizedDocument(权威段落文本留在平台),返回 `docId`。这是引用接地链的第一环 —— 后续 oc-litrag 检索、oc-cite check 都基于这份权威文档。

## 用法

```bash
oc-ingest parse <文件路径>
```

- `<文件路径>`:用户上传到容器的文件(常在 `/home/agent/.openclaude/uploads/...`)。
- 支持:PDF(有文字层)、TXT、Markdown、HTML。
- 输出 `{ docId, lang, title, sections, spanCount }`;或 `{ needsOcr: true, reason }`(扫描件无文字层 / CAJ 等需 OCR 引擎)。

## 默认行为

- 拿到 `docId` 后,告诉用户"已解析:<title>(N 段)",并用 `docId` 调 **oc-litrag query** 检索证据。
- 返回 `needsOcr: true` 时:明确告诉用户该文件是扫描件/需 OCR(当前 runtime 的 local 引擎无文字层可取),建议用户提供有文字层的 PDF;**不要**假装解析成功。
- **权威段落文本不会回传到容器** —— 你拿不到全文,只能通过 oc-litrag query 取 quote handle 引用。这是引用接地的设计(防止 LLM 改写原文)。

## 引用接地链(必读)

1. `oc-ingest parse 文件` → 得 `docId`(平台铸造权威文档)。
2. `oc-litrag query "问题" --docs <docId>` → 得 quote handles(平台权威段落子串,写作唯一可引用素材)。
3. 写 claim 时引用 quote 的 id;最后 `oc-cite check` 校验 → 平台铸造 verified。

## 安全

- 不打印/回显容器身份 token;不猜测平台引擎凭证(只在平台)。
- 上传的文件可能含敏感信息;不要把文件原始字节回显到对话。

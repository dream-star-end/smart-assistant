---
name: oc-litrag
description: 用 `oc-litrag` 命令行在已 ingest 的权威文档上做 quote-first 检索,取出 verbatim quote(写论证/综述时唯一可引用的原文素材)。基于上传文献回答问题、抽取支撑证据、写有引用的分析时使用。
tags: [research, rag, quote, grounding]
---

# oc-litrag quote-first 检索(CLI)

在 oc-ingest 解析过的**平台权威文档**上检索,返回 **quote handles** —— 平台逐字截取的权威段落子串。这是引用接地的核心:**写作时唯一可引用的素材就是这些 quote**,LLM 不能凭记忆改写原文。

## 用法

```bash
oc-litrag query "<问题/关键词>" --docs <docId,docId> [--top-k 8]
```

- `--docs`:来自 `oc-ingest parse` 的 docId(可多个,逗号分隔)。
- 输出 `{ quotes: [{ id, docId, spanId, charStart, charEnd, text, score }], missing: [...] }`。
- `quotes[].text` 是权威段落原文;`quotes[].id` 是写 claim 时引用的句柄。

## 工作流(引用接地)

1. 先 `oc-ingest parse` 得 docId。
2. `oc-litrag query` 取 quote handles。
3. 写正文 claim 时,**每个论断都引用一个或多个 quote 的 id**,不要写没有 quote 支撑的"事实性"论断。
4. 组装 evidence manifest(claims + 引用的 quotes + sources),用 `oc-cite check` 校验 → 平台铸造 verified;未接地的 claim 会被标 unsupported(红标),需删除或补证据。

## 默认行为

- 召回基于关键词/语义混合;问题用 3~8 个核心词效果好。
- `missing` 里的 docId 表示未找到(可能没 ingest 或不属于当前用户)→ 先 oc-ingest。
- quote 文本可能是整段;引用时如实呈现,不要截断或改写 quote 内容。

## 安全

- 不打印/回显容器身份 token。
- 召回质量(in-proc 检索)只影响"找到多少证据",**不影响**引用是否被判为可信(那由 oc-cite check 决定);找不到证据就如实说"未检索到支撑",不要编。

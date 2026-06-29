---
name: oc-cite
description: 用 `oc-cite` 命令行做引用接地门禁:DOI/arXiv/OpenAlex 回查校验、撤稿过滤、生成 BibTeX / GB-T7714-2015 / APA 引用。任何要在报告/综述里写 `\cite`、列参考文献、声称某文献支持某结论时,引用必须先过 oc-cite。
tags: [research, citation, grounding, verification]
---

# oc-cite 引用接地门禁(CLI)

引用接地是**产品信任红线**:报告里每一条引用都必须经 `oc-cite` 校验为真实、未撤稿,才能进"已验证参考文献"。**不要**凭记忆写 DOI/引用 —— LLM 编的"看起来合理的假引用"是最严重的事故。

## 用法

```bash
# 校验 identifier(可多个):DOI / arXiv id / OpenAlex id
oc-cite verify 10.1038/s41586-020-2649-2 arxiv:1706.03762 openalex:W2741809809

# 生成引用格式
oc-cite format 10.1038/s41586-020-2649-2 --style gb-t-7714-2015   # 中文国标(默认)
oc-cite format 10.1038/s41586-020-2649-2 --style apa
oc-cite format 10.1038/s41586-020-2649-2 --style bibtex

# 校验整份 evidence manifest(平台铸造 verified;未接地红标)
oc-cite check --manifest manifest.json

# 纠错:对未接地 claim 在权威文档里重检索更匹配 quote 重绑后重校验
oc-cite fix --manifest manifest.json --docs <docId,docId>
```

`fix` 会对 `check` 后仍未接地的 claim 在已 ingest 的权威文档(docId 来自 oc-ingest)里
重新检索更贴的 verbatim quote 并重绑,再自动重校验;命中则可能转 verified,命中不了仍保持
未核查(诚实)。`changes` 列出每条 claim 重绑到哪个 quote 或 none。

`verify` 输出 `{ verdicts: [{ identifier, resolved, record, retracted, bibtex, gbt7714, apa }] }`。

## 判定规则(fail-closed)

- `resolved=false` → identifier **未命中任何可信记录(Crossref/OpenAlex/arXiv)** → 视为**假引用/不可信**,**禁止**写进参考文献;要么删掉该论断的引用、把论断标"未核查",要么换一个真实来源。
- `retracted=true` → 文献已撤稿 → **不得**作为正面证据;生医/临床/政策类报告里命中即必须拦截并提示用户。
- 只有 `resolved=true 且 retracted!=true` 的文献才可进"已验证参考文献"。
- 撤稿状态 `null` 表示未查到撤稿信息(非"确认未撤稿");高风险领域需谨慎。

## 引用格式

- 中文报告默认用 `gb-t-7714-2015`(国标);英文用 `apa`;需要 .bib 文件给 `bibtex`。
- 引用格式由 oc-cite 生成,**不要手搓** —— 手搓格式不规范且易错。

## 工具调用纪律(重要)

- **只用本 skill 对应的 `oc-*` 命令传参调用**;CLI 已把鉴权、端点、proxy 全部封装好,你只需给参数,不必关心底层怎么请求。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP 调用,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token —— 那样既会失败也不安全。
- 命令失败(401/429/503/超时)按下方「安全」段处理:重试本命令、或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

## 安全

- 不打印/回显容器身份 token;不猜测平台 API key(只在 master)。
- 401≠token 缺失;429 减少频次;503 管理员关停时改用已有知识但**仍不得编造引用**。

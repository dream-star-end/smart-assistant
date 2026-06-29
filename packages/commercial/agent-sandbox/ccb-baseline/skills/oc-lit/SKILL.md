---
name: oc-lit
description: 用 `oc-lit` 命令行做多源文献元数据检索(OpenAlex / Crossref / arXiv,含中文文献),去重 + 开放获取(OA)发现。用户要查文献、找论文综述素材、按主题检索近年研究、列参考候选时使用。优先于旧 SKILLS_LITERATURE(DeepXiv arXiv-only)。
tags: [research, literature, search, citation]
---

# oc-lit 多源文献检索(CLI)

科研文献检索的**首选**工具。多源(OpenAlex + Crossref + arXiv)并发检索 + 去重 + OA 发现,平台托管各源凭证,你只管调命令。元数据走开放 API,**绝不代爬知网/万方等付费墙全文**。

> 旧的 `SKILLS_LITERATURE`(只查 DeepXiv arXiv)已降级为 legacy;新检索一律优先用 `oc-lit`。

## 用法

```bash
oc-lit search "<关键词>" [--sources openalex,crossref,arxiv] [--size 20] [--year-min 2020] [--lang zh|en]
```

- `--sources`:默认全查;可只选其一两个。
- `--size`:每源条数(1~100,默认 20)。
- `--year-min`:只要该年及以后。
- `--lang zh`:中文检索提示(DOI 缺失率高,自动走"标题+作者+年"模糊去重)。

输出 JSON:`{ sources: [{ id, title, authors, year, venue, doi, arxivId, citationCount, oa{isOA,url}, retracted, lang }], warnings }`。

## 默认行为

- **英文检索召回更高**:用户问中文问题时,先把核心术语翻成英文再 `--sources` 全查;需要中文文献时再加 `--lang zh` 跑一次中文 query。
- 3~8 个术语效果最佳,**不要**把整段问题塞进 query。
- 结果里 `oa.isOA=true` 才有合法全文链接;`oa.url` 为空说明无开放全文 → 提示用户经机构 IP 自取或上传 PDF/CAJ(随后可用 `oc-ingest` 解析),**不要**代下载付费墙全文。
- `retracted=true` 的文献要明确标注"已撤稿",不要当正常证据引用。
- 单源失败会进 `warnings`(其它源仍返回),据此告诉用户哪个源暂不可用。

## 引用接地红线

- 展示给用户的每条文献都带 `doi` / `arxivId`,便于回查;**不要瞎编 DOI/arXiv 编号**。
- 写报告/综述时,文献的"是否可信、是否撤稿、引用格式"交给 `oc-cite` 校验与生成,不要自己手搓引用。

## 安全

- 不打印/回显容器身份 token(`OPENCLAUDE_V3_CONTAINER_TOKEN`):不要 `echo`、`printenv`、`set -x`、`/proc/*/environ`。
- 不尝试发现或猜测平台各源 API key —— 它们只在 master,容器里没有也不需要。
- 失败(401/429/503)不要打印 token debug:401≠token 缺失;429 配额/频次过高,等几秒或减少检索;503 管理员临时关停,改用已有知识。

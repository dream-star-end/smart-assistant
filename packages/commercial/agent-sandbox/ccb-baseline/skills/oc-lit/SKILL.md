---
name: oc-lit
description: 用 `oc-lit` 命令行做多源文献元数据检索(OpenAlex / Crossref / arXiv / PubMed / Semantic Scholar,含中文与生医文献),去重 + 开放获取(OA)发现。用户要查文献、找论文综述素材、按主题检索近年研究、列参考候选时使用。优先于旧 SKILLS_LITERATURE(DeepXiv arXiv-only)。
tags: [research, literature, search, citation]
---

# oc-lit 多源文献检索(CLI)

科研文献检索的**首选**工具。多源(OpenAlex + Crossref + arXiv + PubMed + Semantic Scholar)并发检索 + 去重 + OA 发现,平台托管各源凭证,你只管调命令。元数据走开放 API,**绝不代爬知网/万方等付费墙全文**。

> 旧的 `SKILLS_LITERATURE`(只查 DeepXiv arXiv)已降级为 legacy;新检索一律优先用 `oc-lit`。

## 用法

```bash
oc-lit search "<关键词>" [--sources openalex,crossref,arxiv,pubmed,s2] [--size 20] [--year-min 2020] [--lang zh|en]

# 引用图扩展(找全相关工作/综述):沿 seed 文献的前后向引用扩展
oc-lit snowball <DOI|arXiv|OpenAlex id> [--direction backward|forward|both] [--size 20]

# OA 全文下载+自动入库(单条 identifier 或 records JSON 文件,≤5 条)
oc-lit fetch <doi|arxiv-id|records.json> [--project P] [--no-ingest]

# 异步批量下载(≤200 条,durable job;用 requestId 轮询/断点续跑)
oc-lit fetch-batch <records.json> --request-id <topic-slug> [--project P]
oc-lit job-status <requestId>
```

`snowball`:backward=seed 引用的文献,forward=引用 seed 的文献,both=两者。适合从一篇
关键论文出发滚雪球找全相关工作;输出同 search 的 SourceRecord(可再 oc-cite verify)。

### fetch / fetch-batch(OA 全文下载)

- **下载链(OA 优先,命中即停)**:已有 oa.url → Unpaywall PDF → arXiv → Europe PMC OA →
  出版商 OA 直 PDF →(平台显式配置时)机构 proxy 重放。只取**开放获取**定位器。
- records.json 形状:`[{ "id": "doi:10.x/y", "doi": "10.x/y", "arxivId": "…", "title": "…", "oa": {"url": "…"} }]`
  (直接把 `oc-lit search` 输出的 `sources` 数组存文件即可)。
- 每条结果带结构化状态:`status=fetched`(含 docId,已入文献库,可直接 `oc-litrag query`)/
  `needs_ocr`(下载成功但扫描件无文字层,需 oc-ocr)/ `failed`(带 `reason`:paywalled /
  no_oa_location / blocked_robot / not_pdf / too_large / timeout / fetch_error_4xx|5xx …,
  逐条 `attempts[]` 有每源明细)。**失败要如实向用户解释 reason,不要静默跳过**。
- 批量是 durable job:`fetch-batch` 立即返回 job;轮询 `job-status`,status=completed 后
  `result.records` 即逐条结果。中断/重启用**同一 requestId** 重发 `fetch-batch` 会断点续跑。
- 下载未开启(平台 fetch flag 关)会报 `FETCH_DISABLED`:如实告诉用户需管理员开启,不要绕。
- 批量下载前先去重(search 输出已去重),records 文件只保留需要的条目。

- `--sources`:默认全查;可只选其一两个。`pubmed`=NCBI PubMed(生医/临床文献主源);
  `s2`=Semantic Scholar(需平台开启,未开启时该源被跳过并给 warning)。
- `--size`:每源条数(1~100,默认 20)。
- `--year-min`:只要该年及以后。
- `--lang zh`:中文检索提示(DOI 缺失率高,自动走"标题+作者+年"模糊去重)。

输出 JSON:`{ sources: [{ id, title, authors, year, venue, doi, arxivId, citationCount, oa{isOA,url}, retracted, lang }], warnings }`。

## 默认行为

- **英文检索召回更高**:用户问中文问题时,先把核心术语翻成英文再 `--sources` 全查;需要中文文献时再加 `--lang zh` 跑一次中文 query。
- **生医/临床主题**(疾病、药物、临床试验、流行病学等)务必带上 `pubmed` 源(默认已含);其 DOI/撤稿标注可直接进 `oc-cite` 校验。
- 3~8 个术语效果最佳,**不要**把整段问题塞进 query。
- 结果里 `oa.isOA=true` 才有合法全文链接;`oa.url` 为空说明无开放全文 → 提示用户经机构 IP 自取或上传 PDF/CAJ(随后可用 `oc-ingest` 解析),**不要**代下载付费墙全文。
- `retracted=true` 的文献要明确标注"已撤稿",不要当正常证据引用。
- 单源失败会进 `warnings`(其它源仍返回),据此告诉用户哪个源暂不可用。

## 引用接地红线

- 展示给用户的每条文献都带 `doi` / `arxivId`,便于回查;**不要瞎编 DOI/arXiv 编号**。
- 写报告/综述时,文献的"是否可信、是否撤稿、引用格式"交给 `oc-cite` 校验与生成,不要自己手搓引用。

## 工具调用纪律(重要)

- **只用本 skill 对应的 `oc-*` 命令传参调用**;CLI 已把鉴权、端点、proxy 全部封装好,你只需给参数,不必关心底层怎么请求。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP 调用,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token —— 那样既会失败也不安全。
- 命令失败(401/429/503/超时)按下方「安全」段处理:重试本命令、或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

## 合规红线(下载链,写死在平台代码里,skill 侧同样遵守)

- **不做 sci-hub / libgen 及任何影子库**;用户要求"强力爬虫/想办法下付费墙"时,明确拒绝并
  给替代:OA 链(fetch)、请用户经机构 IP 自取后上传、或机构 proxy(让用户找管理员配
  research_config fetch.proxyUrl)。
- **不绕人机验证/验证码/Cloudflare**:`blocked_robot` 是终态,如实记录换路线,不重试不绕过。
- **不在对话里接收任何账号密码/订阅凭据**:用户贴出时,不重复、不落盘、不使用,提醒撤回,
  并引导走平台侧配置(科研凭据保险箱即将上线;当前让用户联系管理员配置平台级 secret)。
- ADS 引用请走 `oc-cite verify ads:<bibcode>`(官方 API + token),不要抓 ADS 网页。

## 安全

- 不打印/回显容器身份 token(`OPENCLAUDE_V3_CONTAINER_TOKEN`):不要 `echo`、`printenv`、`set -x`、`/proc/*/environ`。
- 不尝试发现或猜测平台各源 API key —— 它们只在 master,容器里没有也不需要。
- 失败(401/429/503)不要打印 token debug:401≠token 缺失;429 配额/频次过高,等几秒或减少检索;503 管理员临时关停,改用已有知识。

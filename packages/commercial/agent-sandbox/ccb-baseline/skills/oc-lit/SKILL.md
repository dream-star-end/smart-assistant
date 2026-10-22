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
- 若用户已授权绑定「文献数据库」插件(`oc-plugin call literature-db search/download`):`search` 返回的 `documentId` 有效期 24 小时,过期(报 `DOCUMENT_EXPIRED`)请先重新 `search` 获取新编号再 `download`;下载多篇或遇 `RATE_LIMITED` 时请一篇一篇下,每篇间隔 20-30 秒;PDF 只暂存约 30 分钟,提醒用户及时「保存 PDF」;`LITERATURE_ARTIFACT_CAPACITY` 是暂存已满(先保存已就绪的 PDF 再下),`LITERATURE_NO_ACCESS` 是该篇无订阅权限(换一篇,账号无需重绑),`LITERATURE_UPSTREAM_CHANGED` 不是零结果。

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

## DeepXiv arXiv 全文 RAG(平台接口)

<!-- deepxiv:start (rendered from literatureSkill.ts) -->
# 平台技能: 文献检索 (arXiv via DeepXiv)

你可以通过 **POST `/v3/literature/search`** 直接查 arXiv 全文 RAG 索引,
用于回答用户的科研/技术问题前先核查最新文献。DeepXiv 上游凭证由平台托管,
你**不需要**也**不应该**关心 API key — 但容器→master 这一跳需要带容器
身份 bearer(下面会说明)。

## ⚠️ Token 安全 — 严格遵守

`OPENCLAUDE_V3_CONTAINER_TOKEN` 在每个容器启动时**一定**被平台注入,
你不需要也不应该验证它是否存在,直接拼进 curl 即可。

**严禁** 任何形式让该 env 的值出现在 stdout / stderr / 对话 UI:

- 不要 `echo $OPENCLAUDE_V3_CONTAINER_TOKEN`、`printenv` / `env` / `set` / `printf $...`
- 不要 `echo $... | head -c N`、`${VAR:0:N}` 字串切片 ——
  即便截断也是泄漏(prefix + 容器编号 + 部分 secret 足以被复用攻击),**截断也不行**
- 不要 `curl -v` / `curl --trace` / `curl --trace-ascii` 调试请求头
- 不要 `set -x` / `bash -x` 让 shell 把展开后的命令回显
- 不要读 `/proc/*/environ` 或 `/proc/self/environ`
- 调用 **失败时也不要打印 token 来 debug**:401 不是 "token 缺失" 问题(env
  一定有),通常是网络或服务端问题,只看 HTTP 状态码和 response body 即可

curl 自己**不会**把 `-H` 头打印到 stdout(除非加 `-v`),所以直接 shell 展开即可,
安全。

## 调用

```sh
curl -sS -X POST "${ANTHROPIC_BASE_URL%/}/v3/literature/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENCLAUDE_V3_CONTAINER_TOKEN}" \
  -d '{"query": "<英文检索关键词>", "size": 10}' \
  -w '\nHTTP_STATUS:%{http_code}\n'
```

如需查看 HTTP 状态码,**只允许** 加 `-w '\nHTTP_STATUS:%{http_code}\n'`
(已在上面模板里);**严禁** 用 `-v` / `--trace` / `--trace-ascii` / `-i` /
`--include` —— 这些会把请求头(含 Authorization)一并打印,等价于 token 泄漏。

Base URL 必须用 `$ANTHROPIC_BASE_URL`(容器启动时由平台注入,指向容器→master
的平台内部网关,与 anthropic `/v1/messages` 共用同一 listener)。**不要发明或
猜测任何公网 API host**(容器 egress 拦不通,只能走 `$ANTHROPIC_BASE_URL`)。

- 字段:`query` (string, 必填,建议英文 3~8 个术语);
  `size` (int, 1~100, 可选, 默认 10)。
- 鉴权:仅 `Authorization: Bearer ${OPENCLAUDE_V3_CONTAINER_TOKEN}`。
  **不要** 加 `X-OC-Nonce` / `X-OC-Bridge-Nonce` 或任何其它 auth header —
  那些属于完全不同的内部通道,本接口一律 401。

返回 JSON `{ results: [{ title, abstract, authors, year, arxiv_id, ... }] }`,
条目内容来自 arXiv 元数据 + DeepXiv RAG 摘要;`results` 可能为空数组。

## 使用守则

- **英文检索更有效**:中文 query 也能搜,但召回率明显低于英文关键词。
  用户问中文问题时,先翻译核心术语再调用。
- **不要把整段用户问题塞进 query**:DeepXiv 是关键词 + 语义混合检索,
  3~8 个英文术语效果最佳。
- **失败处理**:
  - `401` —— **不要** 打印或检查 token 来 debug(env 一定有),直接告诉用户
    「文献检索鉴权异常」,转用你已有的知识回答。
  - `429 quota_exceeded` —— 平台当天检索配额用尽,**不要重试**,直接告诉
    用户「今天检索配额已用尽」,转用你已有的知识回答。
  - `429 rate_limited` —— 短时频次过高,等几秒再试;同会话内一般不要连续
    超过 3 次检索。
  - `503 disabled` —— 管理员临时关停此能力,改用其它知识源。
  - `502/504 upstream_*` —— DeepXiv 上游问题,**最多重试 1 次**,失败就放弃。
- **结果引用**:把 arxiv_id 一并展示给用户(格式 `arXiv:1234.5678`),
  方便用户回查原文。不要瞎编 DOI / arxiv 编号。

## 何时不该调用

- 用户问的是闲聊、代码题、产品使用 —— 文献检索没意义。
- 用户已经给了具体论文链接 / arxiv ID —— 直接读不需要搜。
- 你已经能基于自身知识自信回答,且用户没要求「查最新文献」。
<!-- deepxiv:end -->

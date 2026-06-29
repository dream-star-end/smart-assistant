# v5 商业版 · 科研 Agent 子系统 — 分 Phase 实施计划

> 依据 `v5-科研agent-完整方案.md`(定稿 v2)落地。本文件是设计权威 + 实施清单。
> 工作树:`/opt/openclaude/openclaude-v5-research-agent` @ `feat/v5-research-agent`(基于 feat/v5-aurora-rewrite)。
> 部署 lane:v5 commercial,`scripts/deploy-v5.sh`;改 CLI/容器代理须重建 runtime image。

---

## 0. 贯穿原则(落到工程不变量)

1. **引用接地是协议/门禁,不是 prompt 纪律**。LLM 只产结构化内容(claim+evidence);"引用是否真实、quote 是否 verbatim、DOI 是否可解析、是否撤稿"全部由确定性层(oc-litrag/oc-cite + 协议 schema)保证。唯一可写素材 = oc-litrag 抽出的 verbatim quote handle。
2. **能力全 CLI + skill,零新增 MCP**。复用 v5 平台持 token 模式(DeepXiv/oc-market 范本):容器薄 CLI → master proxy 持 key。CLI 用法以 baseline skill 教,**不新增 prompt slot**(避免 ALLOWED_SLOT_NAMES 双端维护;admin 开关由 proxy 503 表达)。
3. **编排走 CC 原生**。复用 science_research_team(main 编排 → researcher/scientist/coder/reviewer delegate),不引入任何 Python 编排运行时。
4. **重后端全 pluggable adapter + 优雅降级**。MinerU GPU / Qdrant / embedding service 一律 config-gated;缺省走免费公开 API(OpenAlex/Crossref/arXiv 无 key)+ 进程内 fallback。符合方案"MVP 渐进:先 master 进程内 worker + PG 状态表"。
5. **尊重 v5 follower 不变量**。新 durable scheduler 必须 gated behind `controlPlaneEnabled`(runtimeChannel='v3' 才跑);v5 channel 下任何 scheduler active 会触发 P0 CRASH(index.ts:2368-2374)。
6. **单一权威源**。研究平台 config 用一张 `research_config` 表(id=1, JSONB 分区 + AEAD 加密 secret),不裂成 4 张表。团队/agent 定义双权威源(entrypoint.ts + agentTeams.js)+ 测试同改。

---

## 0.5 计算放置 + 证据权威(Codex 终审补强 — 堵假引用红线)

### 计算放置模型(单一定义)— 证据权威全部 master 侧铸造(Codex 终审 R3)
- **master 侧权威执行(读字节/铸造证据/铸造 verified)**:
  - oc-lit 多源检索(API key/配额)。
  - **oc-ingest 解析**:容器只上传源**字节**(blob),**master 从字节铸造** NormalizedDocument(local 引擎 = master 进程内 pdfminer/pymupdf;外部引擎 = master 调 MinerU/Mistral)。容器**不做权威解析**(消除"容器解析后被信任"的伪造面)。
  - **oc-litrag index/query**:master 读权威 spans 建索引、检索、**铸造 quote handle**(text 从 master 权威 span 逐字取)。
  - **oc-cite verify/format/check**:全部 master proxy op;**verified 状态只能 master 铸造**。
  - 这些是"重后端走 worker"(方案 §8);小文档 inline 同步,大文档 async durable job(worker 受 controlPlaneEnabled 门控)。master worker **只读 master-owned 存储**。
- **容器侧执行(不碰证据权威面)**:仅**渲染**(Quarto/SciencePlots/slide)。渲染消费 **master 返回的已检 manifest(含 master 权威 quote 文本)**,只做排版,无伪造面。产物落容器 `/home/agent/.openclaude/research/<request_id>/`,经现有 `/api/media-sign` 签名交付 —— **单一 artifact 权威**。
- **blob 暂存**:`/v3/research/blob`(container POST 字节 → master 存 master-owned dir `OC_RESEARCH_BLOB_DIR` + sha256 + user/quota → blobId)。这是 ingest 唯一输入路径。

### 证据权威链(master 独立铸造,绝不信容器/LLM 提交)
1. **上传**:容器 POST 源字节 → master blob(immutable,记 sha256)。
2. **oc-ingest(master)**:从 blob 字节解析 → NormalizedDocument:`docId = sha256(规范化 span 序列)`(内容决定,容器无法冒名)、contentSha256、spans[{spanId, sectionPath, charStart, charEnd, **text(master 权威副本)**}]。**存 master-owned `research_documents` 表**(权威 span 文本在此),并 link source blob。
3. **oc-litrag(master)** 检索后铸造 **quote handle**:`{docId, spanId, charStart, charEnd, text=权威 span.text[charStart:charEnd]}`(master 逐字取,非容器/LLM 输入)。LLM 只拿 handle,**无法发明/篡改 quote 文本**。
4. **LLM(researcher)** 写 claim 只能引用既有 quoteId;claim 文本自由,support 必须指真实 handle。
5. **oc-cite check(master)** 对每条 claim.support 的 quote ref:① 按 docId/spanId 回查 master 权威 span;② **校验 [charStart,charEnd] 在 span 内,取权威子串作为 canonical quote 文本**(不信 manifest 里的 text,直接用 master 子串覆盖);③ identifier 已 verify 且未撤稿。全过 → **master 铸造 status='verified'** 并回 canonical quote 文本;LLM/容器提交的 status 一律忽略。
6. **渲染消费 master 已检 manifest**(canonical quote 文本);unsupported/unchecked claim 红标 / 移入"未核查",**不整篇拒答**(fail-closed)。
7. **verified 语义诚实标注**:MVP(无 MiniCheck)`verified` = **quote-bound + identifier-verified**,**非语义蕴含**(真 quote 也可能被过度解读)。P1.5 接 MiniCheck 增 `supported`(蕴含)层。skill/UI 如实说明。
8. **fallback 不碰 verification**:in-proc TF-IDF embedding 只影响召回(漏证据→claim 变 unsupported),**永不作为 proof**;verified 完全由权威链决定,与 embedding 质量解耦。
9. **已知技术债**:MVP 容器可上传"任意字节"冒充某文献全文,但 master 从该字节铸造权威 + quote 必为该字节子串 + identifier 独立回查真实文献库,故"假引用指向真实 DOI"会在闸③被拆穿;"上传伪造 PDF 自引"属于用户自欺范畴(非系统漏出假引用)。strict mode(P1.5)可加来源可信度校验。

---

## 1. 数据契约(packages/protocol,前后端共用)

新增 `packages/protocol/src/research.ts`(TypeBox,对齐既有 frames.ts 风格),导出 schema + 类型:

- **NormalizedDocument** — master 从源字节铸造的不可变解析文档(证据权威源,存 `research_documents`)。`{ docId(=内容派生 sha256), contentSha256, sourceBlobId?, lang, title?, spans: Span[], references[] }`;`Span { spanId, sectionPath, charStart, charEnd, text(master 权威副本) }`。
- **QuoteHandle** — 唯一可写素材(**master 铸造**,text=权威 span 子串)。`{ id, sourceId, docId, spanId, charStart, charEnd, text(canonical, master 取), score? }`。校验权威 = 回查 master span 的 range 子串(非 hash 相等)。
- **SourceRecord** — 文献元数据。`{ id, title, authors[], year, venue?, doi?, arxivId?, openalexId?, crossrefType?, oa{isOA,url?,license?}?, retracted?, identifiersVerified?, lang? }`
- **Claim** — 正文论断。`{ id, text, supports: QuoteRef[](quoteId+offset), status: 'verified'|'unsupported'|'unchecked', verdict?{verifier,supported,score,note} }`
- **EvidenceManifest** — researcher 产物。`{ sources: SourceRecord[], quotes: QuoteHandle[], claims: Claim[], coverage{verifiedClaims,total}, gates{quoteFirst,claimBound,identifier,retraction: GateResult} }`
- **ReportSchema** — 报告结构(章节/编号/交叉引用由引擎保证,非 LLM)。`{ title, abstract?, sections: Section[](id,heading,level,bodyMd,claimRefs[]), figures: Figure[], bibliography: SourceRef[], csl: 'gb-t-7714-2015'|'apa'|... }`
- **CitationVerdict** — oc-cite 输出。`{ identifier, resolved, record?, retracted, bibtex?, gbt7714?, apa? }`
- **ResearchArtifact** — 交付物索引。`{ kind:'report'|'slides'|'poster'|'bib'|'code'|'data', path, mime, size, signedUrl? }`
- **ResearchJob** / **PhaseCheckpoint** — durable 状态镜像(见 §2)。phase enum: `search_plan|metadata_results|pdf_ingested|quote_indexed|claims_extracted|citations_verified|report_rendered`。

测试:`packages/protocol/src/__tests__/research.test.ts`(schema 编解码 + 不变量:claim.status='verified' ⇒ supports 非空 & 全 quote 存在)。

---

## 2. Master durable 层(packages/commercial)— job 归属明确

**job 归属(Codex #1)**:
- **创建**:容器经 proxy(`/v3/research/job/submit`,verifyContainerIdentity)创建 job,落 PG。
- **消费**:**仅 master control-plane(runtimeChannel='v3')进程内 worker** 消费(ingest/index/cite_check/research_task 等重 master-side op);v5 follower 不消费(scheduler 不注册)。小文档 ingest/检索可由 proxy handler **inline 同步**(纯计算,channel 无关);大任务才入 async worker。容器侧只有**渲染**是本地同步(不入 job/worker,产物经 media-sign)。
- **runtime_channel**:`research_jobs.runtime_channel` 记录创建容器的 channel(审计/隔离用)。
- **部署顺序**:master 代码先上(含 worker)→ 再重建/滚动 runtime image(容器薄 CLI)。worker 逻辑在 commercial(master),不依赖 runtime image。

**migration** `0094_research_jobs.sql`:
- `research_jobs(id BIGSERIAL pk, request_id TEXT, user_id BIGINT FK users ON DELETE CASCADE, runtime_channel TEXT, kind TEXT CHECK in(ingest|index|cite_check|lit_search|render|research_task), status TEXT CHECK(queued|running|completed|failed|interrupted) default queued, phase TEXT, payload JSONB, result JSONB, error TEXT, locked_at TIMESTAMPTZ, attempts INT default 0, created_at/updated_at, UNIQUE(user_id,request_id))` + 部分索引(queued / running by locked_at)
- `research_phase_checkpoints(id, job_id FK ON DELETE CASCADE, phase TEXT, status, output JSONB, error, created_at)` + 索引 by job_id。
- `research_documents(doc_id TEXT pk(=内容派生 sha256), user_id FK ON DELETE CASCADE, content_sha256, source_blob_id, lang, title, normalized_json JSONB(权威 spans+references), created_at)` + 索引 by user_id。**证据权威源(master-owned span 文本在此)**。
- `research_artifacts(id, job_id FK, user_id, kind, storage_path, mime, size_bytes, sha256, created_at)` + 索引
- `research_blobs(blob_id TEXT pk, user_id FK, sha256, size_bytes, storage_path(master-owned), mime, created_at, expires_at)` — ingest 输入字节(master-owned)。

**store** `src/research/store.ts`:`createJob/getJob/claimNextJob(FOR UPDATE SKIP LOCKED)/transitionPhase/recordCheckpoint/completeJob/failJob/recoverStale/listArtifacts/registerArtifact/putBlob/getBlob/putDocument/getDocument/getSpan`(全走 query()/tx())。

**scheduler** `src/research/scheduler.ts`:仿 inbox/email.ts。`startResearchJobScheduler({intervalMs})`,drainTick:advisory lock(常量 'OCRS')→ claimNextJob batch → 执行 handler → 落 checkpoint/result。启动时 recoverStale(running & locked_at<now-N → interrupted)。**在 index.ts 注册时加入 `enabledSchedulers`,gated behind controlPlaneEnabled**;shutdown 停。

**job handler** `src/research/handlers.ts`:按 kind 调用 master-side 能力。短任务 proxy 同步返回;大任务 proxy 返回 job id,容器轮询 `/v3/research/job/poll`,可 resume。

**artifact/blob 存储权威**:
- 容器产物(report/figure/manifest):落容器 `/home/agent/.openclaude/research/<request_id>/`,registerArtifact 记 path+sha256+user,经现有 `/api/media-sign`(白名单扩展)签名交付 —— **单一 artifact 权威**。
- master-side 暂存输入 blob:`research_blobs` + master-owned dir(`OC_RESEARCH_BLOB_DIR`),仅 master worker 读,**不复用 media-sign**(那是面向容器路径的下行通道)。

测试:store CRUD + claimNextJob 并发(SKIP LOCKED)+ scheduler drain + v5 channel gating(v5 下不注册 scheduler、不 claim)+ blob/document ownership 隔离。

---

## 3. 研究平台 config(单一权威)

**migration** `0095_research_config.sql`:`research_config(id INT pk CHECK(id=1), enabled BOOL, config_json JSONB, secret_enc BYTEA, secret_nonce BYTEA, updated_at, updated_by, audit...)`。
- config_json(非密):openalex_mailto, crossref_mailto, unpaywall_email, ncpssd{enabled}, ingest{engine:'auto'|'mineru'|'mistral'|'local', mineru_endpoint?, grobid_endpoint?, mistral_endpoint?}, litrag{embed_backend:'local'|'http', embed_endpoint?, vector_backend:'inproc'|'qdrant', qdrant_url?}, cite{retraction:'crossref'|'off', strict_domains:['bio','clinical','policy']}
- secret_enc(AEAD):s2_api_key, mineru_api_key, mistral_api_key, embed_api_key, qdrant_api_key

**config 模块** `src/admin/researchConfig.ts`:仿 literatureConfig.ts。
- `config_version` 列(schema 版本,迁移用);config_json 写入前 **TypeBox 严格校验**(拒未知/越界字段)。
- `getResearchSkillConfig()`(narrow,不解密,给 skill/proxy gating) / `getResearchConfig(forApi)`(full 解密,仅 proxy) / `patchResearchConfig(patch,ctx)`(audit 不含明文 secret + 加密)。
- **显式 secret 操作**:`setSecret(name,value)` / `clearSecret(name)`,**绝不回显**;patch 只接受 `{secretOps:[...]}` 不接受裸 secret 落 config_json。
- admin 路由(router.ts):`PATCH /admin/settings/research-config`。

**DeepXiv 并存(Codex #5,非第二权威)**:`research_config` 是**新多源研究栈**的单一权威;`literature_deepxiv_config`(DeepXiv RAG)是**另一个独立上游**,保留但其 `SKILLS_LITERATURE` 文案降级为 legacy(标注"优先 oc-lit")。二者不治理同一件事,不构成权威分裂。

---

## 4. 能力层 CLI(4 个,oc-market 范式)

每个:`runtime/oc-<name>.sh`(shell wrapper)+ `packages/gateway/src/oc<Name>Cli.ts`(读容器 env,POST master,结构化 JSON stdout)+ `packages/commercial/src/research/<name>Proxy.ts`(verifyContainerIdentity + rate limit + 读 config + 上游/降级)+ `ccb-baseline/skills/<name>/SKILL.md` + Dockerfile COPY + manifest 加名。

### 4.1 oc-lit(多源 metadata 检索)— Phase 1
- 子命令:`search <query> [--sources ...] [--year-min] [--lang zh|en] [--size]`、`oa <doi|title>`(OA 发现)。
- master proxy `/v3/research/lit/search`:并发查 OpenAlex(free, mailto polite)+ Crossref(free, mailto)+ arXiv(free Atom);可选 S2(key)/Unpaywall(email)/ncpssd(中文 OA)。**去重**(DOI 优先,缺 DOI 用 标题+作者+年 模糊 key);**OA 发现**(Unpaywall + OpenAlex oa_location)。中文:标题+作者+期刊+年 模糊匹配,不靠纯 DOI。
- 降级:source 未配 key → 跳过该源 + 在 meta.warnings 标注,不整体失败。
- 输出:`{ sources: SourceRecord[], warnings[] }`。
- 现有 SKILLS_LITERATURE(DeepXiv)降级 legacy:skill 文案标注"优先用 oc-lit"。

### 4.2 oc-cite(引用接地门禁,四道闸权威)— **拆 Phase 1 + Phase 2(Codex #4)**
**Phase 1 部分(不依赖 span 存储)**:
- 子命令:`verify --doi|--arxiv|--openalex <id>...`(闸③ identifier 回查 + 闸④ 撤稿)、`format --id <id> --style gb-t-7714-2015|apa|bibtex`。
- master proxy `/v3/research/cite/verify|format`:DOI→Crossref/OpenAlex 回查;arXiv→arXiv API;撤稿→Crossref `update-to`/Retraction Watch(生医/临床/政策强制)。
- BibTeX 直接生成;**GB/T 7714-2015** 走 citeproc-js + zotero-chinese CSL(资产随镜像);APA 同源。
- 输出:`{ verdicts: CitationVerdict[] }`。

**Phase 2 部分(master proxy op,依赖 §0.5 证据权威链 + research_documents)**:
- 子命令:`check --manifest <path>` → 实为调 **master proxy `/v3/research/cite/check`**;**verified 由 master 铸造**,容器侧只是发起+收结果(非权威)。
- 闸①:每条 claim.support 的 quote ref(docId/spanId/charStart/charEnd)必须命中 master `research_documents` 权威 span;**校验 range 在 span 内,取权威子串作 canonical quote 文本覆盖**(不信 manifest text)。闸②:正文每句有 claimRef。
- 全过 → **master 铸造 status='verified'**(=quote-bound+identifier-verified,非语义蕴含)+ 回 canonical quote 文本;任一不过 → status='unsupported' 红标 / 移入"未核查",**不整篇拒答**(fail-closed)。LLM/容器提交的 status 一律忽略。
- 输出:`{ manifest: 已检 EvidenceManifest(canonical quotes), gates: {...} }`。

### 4.3 oc-ingest(解析路由器,**解析在 master**)— Phase 2
- 子命令:`parse <file> [--ocr auto|on|off]`。容器薄 CLI:上传字节到 `/v3/research/blob` → 调 `/v3/research/ingest/parse`(小文档 inline,大文档返 job id 轮询)。
- **master 从字节铸造** NormalizedDocument(§0.5):docId(内容派生)+ contentSha256 + 权威 spans + references,存 `research_documents`。
- 路由(master 内):.caj/.kdh→caj2pdf(best-effort)→OCR;中英文 PDF→引擎(config:auto→进程内 pdfminer/pymupdf;mineru/mistral 若配→master 调外部)。并联 GROBID 抽题录 merge。
- 降级:无 GPU/MinerU → 进程内文字层抽取 + GROBID(若配);扫描件无文字层且无 OCR → 明确报 `needs_ocr`,不静默产空。
- 输出给容器:`{ docId, lang, title?, sectionOutline, spanCount }`(供展示/后续 RAG 引用;权威 span 文本留 master)。

### 4.4 oc-litrag(quote-first RAG,**检索在 master**)— Phase 2
- 子命令:`index <docId...>`、`query <q> [--top-k] [--rerank]` → **quote handles**。容器薄 CLI 调 `/v3/research/litrag/*`。
- master 读 `research_documents` 权威 spans 建索引/检索。embedding adapter:local(缺省,确定性 TF-IDF/bag 余弦,dev/小规模)| http(config embed_endpoint,接 BGE-M3/SPECTER2)。vector:inproc | qdrant(config)。rerank:bge-reranker(config)否则跳过。**fallback 只影响召回,绝不影响 verified(§0.5#8)**。
- quote-first:检索命中 span → **master 取 span 子串铸造 QuoteHandle**(docId/spanId/charRange/canonical text),返回 QuoteHandle[](唯一可写素材);LLM 无法发明/篡改 quote 文本。
- 重操作(大库 index)走 durable job。

---

## 5. 确定性产物层 — Phase 3

- **报告**:复用镜像内 Quarto + pandoc(oc-docx.sh 已证存在)+ reference.docx 母版。新增 `oc-report` 路径:输入 ReportSchema(JSON)→ 渲染 Quarto .qmd(章节/编号/交叉引用/CSL 由引擎保证)→ PDF/docx/HTML。引用走 citeproc + GB/T7714 CSL。design-token 主题(1 套)。
- **图表**:新增 SciencePlots(pip,Nature/IEEE 样式)+ ColorBrewer;**禁生成式插画**(skill 明令);架构图 Mermaid/TikZ。scientist 出图走 matplotlib+SciencePlots skill。
- **slides**:1 套 slide 主题,Touying(Typst)可导 .pptx;slide schema + design-token。
- **去 AI 味**:anti-pattern 后处理 reviewer(P2);MVP 先 few-shot 真人样本 skill。
- 落地:`ccb-baseline/skills/` 增 `scientific-writing`(AJS 519 刊规范精要)、`scientific-figures`(SciencePlots 用法 + 禁插画)、`research-report`(oc-report 用法)。

---

## 6. team + skill 注入 — Phase 4(后端)

- entrypoint.ts:researcher persona 增"用 oc-lit/oc-ingest/oc-litrag 产 evidence manifest";reviewer persona 收窄为"只复核 evidence manifest(quote 是否 verbatim、claim 是否接地、撤稿)"。同步 agentTeams.js + runtimeEntrypointPolicy.test.ts。
- baseline skills 增:oc-lit / oc-cite / oc-ingest / oc-litrag 用法 + scientific-writing / scientific-figures + research-report。更新 V3_CCB_BASELINE_SKILL_NAMES(v3supervisor.ts)。
- SKILLS_LITERATURE 降级:文案标注 legacy/优先 oc-lit。

---

## 7. UI — Phase 5(packages/web-react)

新增 role:`research-report`(+按需 `literature-library`)。改 model.ts(role union + 字段)、render.ts(messageKind/MessageKind/messageSignature)、MessageRenderer.tsx(case)。
组件(chat/):
- `ResearchReportCard.tsx` — 正文 markdown,引用角标从 EvidenceManifest 渲染;未接地 claim 红标。
- `EvidencePopover.tsx` — 点角标弹 source span + DOI + OA;未核查段标注。
- `LiteratureLibraryPanel.tsx`(manage/ 或 chat/)— 检索结果(标题/作者/年/引用数/OA)+ BibTeX/GB-T7714 导出。
- (P2)`ReviewTableCard.tsx` 多论文对比矩阵;产物多主题预览。
设计 token 复用 styles.css;Media 复用 media.tsx 签名 URL。

---

## 8. Phase 顺序、验证、Codex 门

| Phase | 范围 | 验证 | 部署影响 |
|---|---|---|---|
| 0 | 协议 schema(§1)+ durable job/artifact/config(§2,§3) | unit:schema 不变量、store SKIP LOCKED 并发、v5 gating、migration apply | 无需 runtime image(纯 master+protocol);需 migrate |
| 1 | oc-lit + oc-cite(verify/format,§4.1+§4.2-P1)+ baseline skills | unit:proxy rate-limit/降级、去重、GB-T7714 格式;真机:对 OpenAlex/Crossref/arXiv 实测召回 + DOI 可解析率=100% | 需重建 runtime image(新 CLI) |
| 2 | oc-ingest + oc-litrag + oc-cite check(§4.3,§4.4,§4.2-P2)+ 证据权威链 + durable job 接线 | unit:解析路由/降级、master 铸造权威 doc/span、quote handle 服务端切片、check 回查权威 span + range 校验取 canonical 文本(拒容器/LLM 篡改 text/status)、quote-first verbatim 子串、RAG top-k;真机:CAJ/双栏样本 + 假引用拦截 | 需重建 runtime image |
| 3 | 确定性产物(§5)+ 写作/图表 skills | 真机:ReportSchema→PDF 章节/编号/交叉引用正确、SciencePlots 出图、零生成式插画 | 需重建 runtime image(SciencePlots pip + CSL + slide) |
| 4 | team/persona/skill 注入(§6) | unit:runtimeEntrypointPolicy 双源同步;真机:researcher 产 manifest、reviewer 复核 | 需重建 runtime image |
| 5 | UI(§7) | vite build 通过 + 真机卡片渲染 + 角标接地交互 | 前端 rsync dist |
| P1.5+ | MiniCheck strict / 独立 worker / CiteFix / PPTAgent / Paper2Poster / scholar / anti-pattern reviewer | 见方案 §12 | 渐进 |

**每 Phase 工作流(仓库 CLAUDE.md 强制)**:plan → Codex review plan → 实现 → Codex review code(只发关键 hunk + 让 Codex 自己 git diff)→ 迭代至 PASS → commit。

## 9. License 红线(落地前逐个核)
academic-search-mcp(AGPL)禁用;paper-search-mcp 剔 Sci-Hub;PPTAgent/Paper2Poster/AJS 等 cat LICENSE 核 MIT/Apache。已核可商用清单见方案 §13。

## 10. 已知技术债 / 短期权衡(诚实标注)
- litrag local embedding(TF-IDF)是 dev/小规模止血,生产必须配 BGE-M3/SPECTER2(config 已留)。偿还触发:接入向量 infra。
- oc-ingest local 解析对扫描件/CAJ 召回有限;MinerU GPU 成熟后切换(config 已留)。
- MiniCheck 支持判定(闸⑤)P1.5 才上;MVP 闸①②③④ 已守住核心红线。
- durable worker MVP 进程内;GPU/embedding 重负载成熟后拆独立 worker 服务(方案 §8 渐进)。

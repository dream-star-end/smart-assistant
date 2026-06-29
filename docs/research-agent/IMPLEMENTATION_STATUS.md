# v5 科研 Agent 子系统 — 实施状态

> 分支 `feat/v5-research-agent`(基于 feat/v5-aurora-rewrite)。每 Phase 经 Codex 双审至 PASS。
> 设计权威:`IMPLEMENTATION_PLAN.md`。

## P0 / MVP — 已完成 ✅(全部 Codex PASS)

| Phase | 内容 | 关键文件 | 验证 |
|---|---|---|---|
| 0a 协议 | 证据/报告/job 共享 schema + 引用格式化器 + 结构不变量 | `packages/protocol/src/research.ts` | 11 单测 |
| 0b durable | research_jobs/checkpoints/documents(证据权威)/artifacts/blobs 表 + store + scheduler(controlPlane 门控)+ research_config(AEAD) | `commercial/src/db/migrations/0094,0095`、`commercial/src/research/{store,scheduler}.ts`、`commercial/src/admin/researchConfig.ts` | 19 integ(真 PG) |
| 1 oc-lit + oc-cite(verify/format) | 多源检索(OpenAlex/Crossref/arXiv,含中文 OA,去重)+ identifier 回查 + 撤稿 + BibTeX/GB-T7714/APA | `commercial/src/research/{sources,litSearch,cite,researchProxy}.ts`、`gateway/src/oc{Lit,Cite}Cli.ts` | 50 单测 + 真实 API 烟测 |
| 2 oc-ingest + oc-litrag + oc-cite check | master 从字节铸造权威文档 + quote-first RAG + **证据权威链**(quote 回查权威 span + range canonical 覆盖 + master 自建 source + master 铸 verified) | `commercial/src/research/{ingest,litrag,checkManifest,researchHandlers}.ts` | 72 单测 + 2 端到端 integ |
| 3 确定性产物 | Quarto 报告(章节/编号/引用引擎保证,未接地红标)+ SciencePlots + slides;写作/图表/去AI味 skill | `gateway/src/{reportRender,ocReportCli}.ts`、`ccb-baseline/skills/{research-report,scientific-writing,scientific-figures,research-slides}` | 7 单测 + CLI 烟测 |
| 4 team 增强 | science_research_team persona/prompt 接入引用接地工作流;reviewer 收窄为 manifest 复核;存量 team 迁移 | `runtime/entrypoint.ts`、`web/public/modules/agentTeams.js` | runtimeEntrypointPolicy 18 测 |
| 5 UI | ResearchReportCard / EvidencePopover / LiteratureLibraryPanel(artifact 驱动,引用一键查源,未接地红标,GB-T7714/BibTeX 导出) | `web-react/src/components/chat/ResearchReportCard.tsx`、`lib/chat/{model,render}.ts` | render 18 测 + vite build |

**能力 CLI(平台持 token,容器薄 CLI → master /v3/research/\*)**:oc-lit / oc-cite / oc-ingest / oc-litrag(master 侧)+ oc-report(容器侧渲染)。baseline skills 全量注入。

**引用接地红线(验收 §14.1)**:verified 只由 master oc-cite check 铸造;quote 文本 = 权威 span 子串(覆盖任何提交篡改);source 由 master 从权威文档自建(忽略提交,杜绝"上传任意文本挂真 DOI");identifier 经回查;未接地 claim 红标 fail-closed。**假引用不会出现 [N] 角标 / 不进已验证参考文献。**

## 已知 MVP 边界(诚实标注,config 已留扩展位)

- **证据 DOI 路径**:当前 ingest 不填 `verifiedSource`(无 master OA-fetch),用户上传文档为 quote-bound verified 但 `identifierVerified=false`(不冒充已发表)。"已发表文献 DOI 接地"待 master 从 resolved DOI 的 OA 全文下载并 ingest(P1.5+)。
- **RAG embedding**:in-proc TF-IDF(确定性,dev/小规模);config-gated 接 BGE-M3/SPECTER2 + Qdrant(只影响召回,不碰 verified)。
- **解析引擎**:local 文字层抽取(pdf-parse);MinerU/Mistral config-gated;扫描件报 needs_ocr。
- **MiniCheck 蕴含(闸⑤)**:✅ 架构已落(config-gated,见下);MVP 默认 backend=off(无模型时优雅跳过),配 endpoint 即生效。
- **async durable worker**:proxy inline 覆盖 MVP(local 引擎秒级);大库/GPU 引擎入队待 MinerU 落地(基建已就绪)。

## 路线图(plan §12 后续 Phase)

- **P1.5**:✅ MiniCheck 蕴含闸⑤(config-gated,strict mode 降级 + 请求级预算);⏳ 独立 worker 服务拆分;RCS rerank 精排;master OA-fetch → verifiedSource DOI 接地。
- **P2**:CiteFix 引用纠错；引用图 snowball；PPTAgent 多主题 slides;Paper2Poster;anti-pattern reviewer(GPTDetector 软信号);scholar 入口 agent;单轮实验闭环。
- **P3**:Elo tournament debate;agentic tree-search 多轮实验;个性化写作风格库;PresAesth 美学闸。

## 部署(未上线)

- v5 lane:`scripts/deploy-v5.sh`;改 CLI/容器代理须重建 runtime image(新增 oc-lit/cite/ingest/litrag/report + SciencePlots pip + 7 baseline skills)。
- 需跑 migration 0094/0095;research_config 默认 disabled(admin 开启)。
- 前端 web-react 需 vite build + rsync dist。

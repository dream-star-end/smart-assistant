---
name: scansci-pdf
description: （已退役为重定向）文献检索/下载/引用请用 oc-lit / oc-cite / oc-ingest。当前镜像里的 `scansci-pdf` 仅 server 模式(只有 run/check)，没有 search/download/citation 等 CLI 子命令，别用它做这些。
tags: [research, papers, redirect, deprecated]
---

# scansci-pdf（已退役 → 用 oc-* 研究命令行）

> **重要**:当前镜像安装的 `scansci-pdf`(1.3.x)是 **server-only**——`scansci-pdf --help` 只有 `run`(起服务)和 `check`(查依赖)两个子命令,**没有** `search` / `download` / `citation` 等子命令。任何 `scansci-pdf search "..."` 之类的调用都会报 `No such command` 而失败。文献能力已统一迁到研究子系统的 oc-* 命令行,请直接用下表对应工具,**不要**再调用 scansci-pdf 做检索/下载/引用。

## 按任务对应的工具(唯一权威)

| 任务 | 用这个(经 Bash 调用) | 说明 |
|---|---|---|
| 按主题/关键词/模糊题名找文献、综述素材 | `oc-lit search "<3~8 个英文核心术语>"` | 多源 OpenAlex/Crossref/arXiv + 去重 + 开放获取(OA)发现 |
| 从一篇关键论文滚雪球找全相关工作 | `oc-lit snowball <DOI\|arXiv\|OpenAlex id>` | 前后向引用扩展 |
| 单个 DOI/arXiv/URL/精确题名定位元数据 | `oc-lit search` | `oa.isOA=true` 时给 `oa.url` 开放全文;付费墙无 OA 不代下载 |
| 生成/核验引用(BibTeX/RIS/APA/GB-T7714) | `oc-cite verify <DOI\|arXiv\|OpenAlex id>` | 接地校验,撤稿/未命中会标注;引用接地是红线 |
| 解析用户上传的 PDF/全文入库 | `oc-ingest` | 付费墙全文请用户上传后再解析 |

详细参数见 `skill_view("oc-lit")` / `skill_view("oc-cite")` / `skill_view("oc-ingest")`。拿不到全文时再用内置 WebSearch/WebFetch 兜底查来源/链接,不要假装已下载。

## 安全与隐私(若确需触碰 scansci-pdf server 配置)

- 不泄露 ScanSci 配置、API key、cookie、browser state、access token、代理凭据。
- **不要运行 `scansci-pdf config get` 之类配置 dump**;商业版刻意隐藏配置输出。
- 不要打印 `config.json` / `browser_state.json` / cookie / token 文件内容。

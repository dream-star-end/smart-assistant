---
name: scansci-pdf
description: 用 `scansci-pdf` 命令行检索学术论文、按 DOI/arXiv/题名下载 PDF、批量下载阅读清单、生成引用。用户要找论文、下载 PDF、解析 DOI/arXiv/题名、批量下载、查来源健康或导出引用时使用。
tags: [research, papers, pdf, citation]
---

# ScanSci PDF 论文助手（CLI）

当用户要找论文、下载论文 PDF、批量下载阅读清单、解析 DOI/arXiv/题名、检查论文来源健康或生成引用时，用这个技能。

论文能力由容器内的 **`scansci-pdf` 命令行**提供（用 Bash 调用，始终可用），不再是 MCP 工具。商业版 Web 是 chat-native：直接从用户消息推断论文任务，**不要**让用户去打开“设置”或单独的论文助手入口。用户只贴了 DOI/arXiv/题名/URL、没多说，就按“解析/下载或查看该论文”处理。

## 先发现命令

第一次用前先跑一次帮助，确认本镜像的精确子命令与参数：

```bash
scansci-pdf --help
scansci-pdf <subcommand> --help    # 如 scansci-pdf download --help
```

核心操作（子命令名以 `--help` 实际输出为准）：search、download、batch-download、citation、health-check、network-diagnose、source-scores、vpnsci-status / vpnsci-schools / vpnsci-test。

## 默认行为

- 模糊主题、题名片段、可能命中多篇 → 先 `scansci-pdf search`，列候选让用户选，再下载；不要对一堆模糊结果擅自批量下载。
- 单个 DOI / arXiv ID / URL / 精确题名 → `scansci-pdf download`，存入默认 ScanSci 数据目录，除非用户指定路径。
- 用户给了 DOI/arXiv/题名列表 → `scansci-pdf batch-download`，批量保持小规模，除非用户明确要大批量。
- 用户要 BibTeX/RIS/APA/MLA/Vancouver 或引用元数据 → `scansci-pdf citation`。
- 下载反复失败 → `scansci-pdf health-check` / `scansci-pdf network-diagnose`。
- 后续选择都留在对话里：搜索结果给简短编号候选，问用户下载哪个；UI 有结果卡片时用户可能点卡片动作发来后续 prompt。

## 给用户的回复规则

成功下载后，必须包含：

1. 论文题名或标识符。
2. 命令返回的来源/状态（若有）。
3. 精确的 PDF 绝对路径，通常在 `/home/agent/.local/share/scansci-pdf/papers/`。把路径单独成行打印，OpenClaude 会渲染成文件卡片。
4. 用户要的话给引用/BibTeX。

返回搜索结果时给足后续动作所需标识：题名、年份、第一作者、DOI 或 arXiv ID。回复简洁、可执行。

## 安全与隐私

- 不泄露 ScanSci 配置、API key、cookie、browser state、access token、代理凭据。
- **不要运行 `scansci-pdf config get` 之类的配置 dump 子命令**；商业版刻意隐藏配置输出。
- 不要打印 `config.json` / `browser_state.json` / cookie / token 文件内容。
- 用户没指定获取策略时优先合法/开放获取途径。
- 用户要机构/WebVPN/CARSI 登录或“隐身浏览器”时，说明当前 runtime 暴露的是 ScanSci 核心下载/检索/引用与状态检查；交互式远程浏览器登录需另行启用隔离浏览器 sidecar。

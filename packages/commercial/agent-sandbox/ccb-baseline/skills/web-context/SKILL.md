---
name: web-context
description: 用 `oc-web` 命令行把公开网页/URL 或已上传/已生成的本地文档(HTML/PDF/Office/文本)转成干净 Markdown 上下文喂给模型。用户要读公开链接、网页、公告、PDF、Office 文档或解析本地文件时使用。搜索请用内置 WebSearch,不要用 oc-web 抓搜索引擎结果页。
tags: [web, extract, pdf, document, markdown]
priority: 8
---

# 网页/文档上下文提取（oc-web CLI）

当用户要读取**公开 URL/网页/公告/PDF/Office 文档**，或要把**已上传/已生成的本地文档**解析成文本喂给你时，用容器内的 **`oc-web` 命令行**（Bash 调用，始终可用），不再是 MCP 工具。普通的开放网页检索可优先用模型内置 WebSearch/WebFetch；需要把整页/整文档转成干净 Markdown 时用 `oc-web`。

## 用法

```bash
oc-web extract <url>          # 抓公开 URL → 干净 Markdown（静态提取，保留重定向/DNS 在 SSRF 防护内）
oc-web parse <绝对路径>        # 解析本地文件 → Markdown
oc-web health                 # 检查解析器依赖是否可用
```

常用 flag：
- `--json`：输出完整结构化 JSON（含 ok/blocked/error/final_url/http_status 等），便于你程序化判断；默认直接打印 Markdown 正文。
- `--max-chars <n>`：限制输出字符数。
- `--timeout-ms <n>`：单次超时。
- `--mode auto|static|browser`：默认 `auto`（=静态提取）；`browser` 渲染暂不可用。
- `--max-file-bytes <n>`：`parse` 的输入文件大小上限。

退出码：`0` 成功；`1` 提取失败/被拦（blocked）/运行错误；`2` 用法错误。

## 搜索 vs 提取的分工(反模式,生产实证)

- **搜索一律用内置 WebSearch 工具**,拿到目标 URL 后再对**内容页**用 `oc-web extract`。
- **绝不用 `oc-web extract` 抓搜索引擎结果页**(baidu/bing/sogou/google/brave/yahoo 的 `/search?...` URL):SERP 是重 JS+反爬页面,实测要么超时、要么返回与查询无关的垃圾内容(比拿不到更糟——会污染你的结论)。`site:xxx` 这类站内检索同样交给 WebSearch。
- WebSearch 结果不足时的正确姿势:换关键词再搜、直接猜权威站点的内容页 URL、或如实告诉用户找不到;而不是去抓 SERP。
- `extract` 返回 `blocked`/`parser timed out`:内容页可加 `--timeout-ms 60000` 重试一次;仍失败就换 WebSearch 或如实说明受阻,不要反复重试同一 URL。

## 路径与安全边界

- `oc-web parse` 只接受**绝对路径**，且必须在白名单根下：`/home/agent/.openclaude/uploads`、`/home/agent/.openclaude/generated`、`/home/agent/.local/share/scansci-pdf/papers`。任意系统路径会被拒。
- `oc-web extract` 内置 SSRF/DNS/重定向/体积/压缩后体积/输出上限防护，并识别反爬拦截。
- **不要**尝试绕过 CAPTCHA、Cloudflare、登录墙或站点反爬。命令返回 `blocked`/`error` 时，如实说明受阻，改用官方 API、用户上传的文件，或用户提供的数据源。
- 输出结论时标明来源 URL、数据时间或文件路径；不要把网页抓取结果当成实时金融/法律/医疗等高风险事实的唯一依据。

## 典型流程

1. 用户给公开链接 → `oc-web extract <url>`，把返回的 Markdown 作为上下文回答，并标注来源。
2. 用户上传了 PDF/Office/HTML → 用其容器内绝对路径 `oc-web parse <path>`，再基于解析文本回答。
3. 需要判断是否被拦或拿元数据 → 加 `--json` 看 `blocked`/`http_status`/`final_url`。

## 工具调用纪律(重要)

- **只用本 skill 对应的命令/工具传参调用**;它已把鉴权、端点、底层请求全封装好,你只需给参数。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token。
- 命令失败时按本 skill 的失败处理重试或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

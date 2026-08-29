---
name: oc-ingest
description: 用 `oc-ingest` 把用户文档解析成可检索、可引用接地的权威文档；扫描PDF/图片先用 `oc-ocr` 异步文档解析，再把完整Markdown入库。用户上传 PDF/图片/CAJ/文档要读、分析、综述或提取证据时使用。
tags: [research, ingest, parse, pdf, ocr]
---

# oc-ingest 文档解析(CLI)

把用户的文档解析成**平台权威文档**:平台从文件字节铸造不可变的 NormalizedDocument(权威段落文本留在平台),返回 `docId`。这是引用接地链的第一环 —— 后续 oc-litrag 检索、oc-cite check 都基于这份权威文档。

## 用法

```bash
oc-ingest parse <文件路径>
```

- `<文件路径>`:用户上传到容器的文件(常在 `/home/agent/.openclaude/uploads/...`)。
- 支持:PDF(有文字层)、TXT、Markdown、HTML。
- 输出 `{ docId, lang, title, sections, spanCount }`;或 `{ needsOcr: true, reason }`(扫描件无文字层 / CAJ 等需 OCR 引擎)。

## 扫描件 / 图片 OCR

`needsOcr: true` 时不要让用户另找文字版，也不要逐页调用视觉模型。平台有可取消、可见进度的批量 OCR 队列：

```bash
oc-ocr run <原文件> --out <原文件名>.ocr.md --mode hybrid
oc-ingest parse <原文件名>.ocr.md
```

- 底层统一使用 SCNet 文档解析，保留表格 HTML、公式和逐页结构化 JSONL。`--mode` / `--fallback` 是旧命令兼容参数，不再选择不同引擎；继续使用默认 `hybrid` 即可。
- 进度在 stderr 持续显示；命令一开始会打印 ticket。连接中断后可用 `oc-ocr status <ticket>`、`oc-ocr download <ticket> --out ...` 续取。
- Ctrl-C / `oc-ocr cancel` 会立即停止本地等待和结果交付；SCNet 当前没有远端取消接口，已提交任务可能仍会在服务端处理完成。
- 结果默认保留 7 天；需要长期使用时应在任务完成后立即下载并入库。
- 若服务返回旋转页空结果，任务会明确失败而不是静默产出空文档；如实告知用户需要先校正页面方向后重试。
- OCR 输出按页完整写入 Markdown，不用摘要替代正文、不静默跳页；任一结果不完整时整单会明确失败。

## 默认行为

- 拿到 `docId` 后,告诉用户"已解析:<title>(N 段)",并用 `docId` 调 **oc-litrag query** 检索证据。
- 返回 `needsOcr: true` 时：按上面的 `oc-ocr → oc-ingest` 流程继续；若 OCR 服务明确失败，原样说明错误和可重试条件，**不要**假装解析成功。
- **权威段落文本不会回传到容器** —— 你拿不到全文,只能通过 oc-litrag query 取 quote handle 引用。这是引用接地的设计(防止 LLM 改写原文)。

## 引用接地链(必读)

1. `oc-ingest parse 文件` → 得 `docId`(平台铸造权威文档)。
2. `oc-litrag query "问题" --docs <docId>` → 得 quote handles(平台权威段落子串,写作唯一可引用素材)。
3. 写 claim 时引用 quote 的 id;最后 `oc-cite check` 校验 → 平台铸造 verified。

## 工具调用纪律(重要)

- **只用本 skill 对应的 `oc-ingest` / `oc-ocr` / `oc-litrag` 命令传参调用**;CLI 已把鉴权、端点、proxy 全部封装好,你只需给参数,不必关心底层怎么请求。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP 调用,**绝不**猜测或硬编码任何 URL / 端口 / 接口路径 / token —— 那样既会失败也不安全。
- 命令失败(401/429/503/超时)按下方「安全」段处理:重试本命令、或如实告诉用户,**绝不**改用 curl/HTTP 兜底。

## 安全

- 不打印/回显容器身份 token;不猜测平台引擎凭证(只在平台)。
- 上传的文件可能含敏感信息;不要把文件原始字节回显到对话。

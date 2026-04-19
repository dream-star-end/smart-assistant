// Document Parser — 把上传的 .docx / .pdf 在 gateway 端预解析为 markdown 文本,
// 直接塞进 user message,免得 agent 用 Read 读到二进制乱码。
//
// 设计原则:
//   - 解析失败 ≠ 上传失败。失败时返回 null,调用方就回退到原来的"路径告知 + Read"
//     策略,用户体验不会变差。
//   - 大文件硬截断在 200KB markdown 文本(再多 agent 也读不动),并在末尾标注。
//   - 解析时间预算每文件 5s,超时也回退。
//   - mammoth/pdf-parse 是 dynamic import,启动时不付加载成本,且任一缺失不会
//     连累 gateway 启动。
//
// alice 那次 .doc 上传失败是更早的 MIME 白名单问题(已修);现在做的是即便
// .docx/.pdf 上传成功,也能让 agent 真正"看到"内容,而不是被迫读路径。

import { readFile } from 'node:fs/promises'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'documentParser' })

const MAX_PARSED_CHARS = 200_000 // 截断阈值;200KB 文本 ~ 50K tokens 量级
// 不同解析器有不同的"合理超时":
//   - mammoth: extractRawText 是同步流式 unzip,本地 .docx 几乎都能 1s 内完成。
//     5s 用来兜超大文档(几百页技术规范)。
//   - pdf-parse v2: load() 调 pdfjs.getDocument(),底层是 worker。一篇 10MB 论文
//     冷启动约 8~15s。给 30s 余量,**仍然不够时承认"放弃等待"** —— 因为 v2 API
//     的 destroy() 只能 destroy 已 load 的 doc,不能真正 cancel loadingTask
//     (worker 会自己跑完再 GC,不是我们能精确控制的)。我们用页数上限 + 超时
//     限两道闸,worst case 是 worker 多挂 10s 直到自然退出,这是可接受的。
const DOCX_TIMEOUT_MS = 5_000
const PDF_TIMEOUT_MS = 30_000
// 页数上限:常见科研论文 6~25 页,会议长文 30~50 页,书的章节 30~80 页。
// 60 页足以覆盖 95% 的科研用例。超过的 PDF 用户通常会自己截章节而不是丢整本。
const PDF_MAX_PAGES = 60

export type ParseResult = {
  /** 解析出来的 markdown 文本(已截断到 MAX_PARSED_CHARS) */
  markdown: string
  /** 是否触发了硬截断 */
  truncated: boolean
  /** 解析器名称(用于日志和向 agent 提示来源) */
  parser: 'mammoth-docx' | 'pdf-parse' | 'plaintext'
}

/** 限时执行 — 超时则 reject 到 fallback。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function truncate(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= MAX_PARSED_CHARS) return { markdown, truncated: false }
  const head = markdown.slice(0, MAX_PARSED_CHARS)
  return {
    markdown: `${head}\n\n…（已截断:原文 ${markdown.length} 字符,只保留前 ${MAX_PARSED_CHARS}）`,
    truncated: true,
  }
}

/** .docx → 纯文本 via mammoth.extractRawText。
 *
 * mammoth 没有内置 markdown converter(只有 convertToHtml / extractRawText)。
 * 对科研文档,extractRawText 已能保留段落分隔,损失的是表格结构和标题层级 ——
 * 比让 agent 读 .docx 二进制好得多,且足以让 agent 理解大意。表格如果重要,
 * 用户会把数据贴到 chat 里。后续要保留更多结构,可以走 convertToHtml 再做
 * HTML→markdown 转换。
 */
async function parseDocx(filePath: string): Promise<ParseResult | null> {
  try {
    // dynamic import:启动期不加载;mammoth 缺失时返回 null 让上层回退。
    const mammoth = await import('mammoth')
    const buffer = await readFile(filePath)
    const result = await withTimeout(
      mammoth.extractRawText({ buffer }),
      DOCX_TIMEOUT_MS,
      'mammoth.extractRawText',
    )
    const value = (result as { value?: string })?.value ?? ''
    if (!value.trim()) return null
    const { markdown, truncated } = truncate(value)
    return { markdown, truncated, parser: 'mammoth-docx' }
  } catch (err) {
    log.warn('docx parse failed', { filePath }, err)
    return null
  }
}

/** .pdf → text via pdf-parse v2.x。
 *
 * pdf-parse v2 把 API 从 default function 换成了 class `PDFParse`,
 * 实例方法 `getText()` 返回 `{ text, ... }`。要用 destroy() 释放 worker。
 */
async function parsePdf(filePath: string): Promise<ParseResult | null> {
  let parser: {
    getText: (params?: { last?: number }) => Promise<{ text?: string }>
    destroy: () => Promise<void> | void
  } | null = null
  try {
    const { PDFParse } = (await import('pdf-parse')) as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        getText: (params?: { last?: number }) => Promise<{ text?: string }>
        destroy: () => Promise<void> | void
      }
    }
    const buffer = await readFile(filePath)
    parser = new PDFParse({ data: new Uint8Array(buffer) })
    // last=PDF_MAX_PAGES 让 PDFParse.shouldParse 在 [1, PDF_MAX_PAGES] 范围
    // 内才解析;对几百页的书自动只取前 60 页。这是限工作量、不是限取消的闸。
    const result = await withTimeout(
      parser.getText({ last: PDF_MAX_PAGES }),
      PDF_TIMEOUT_MS,
      'pdf-parse.getText',
    )
    const text = (result?.text ?? '').trim()
    if (!text) return null
    const { markdown, truncated } = truncate(text)
    return { markdown, truncated, parser: 'pdf-parse' }
  } catch (err) {
    log.warn('pdf parse failed', { filePath }, err)
    return null
  } finally {
    // PDFParse v2 的 destroy() 只能销毁已 load 的 doc(this.doc 非空)。
    // 超时分支 + 真正失败分支都会落到这里;destroy 是 idempotent + safe。
    // 注意:如果超时发生在 load() 还没完成时,doc 此刻仍为 undefined,
    // destroy() 是 no-op,后台 worker 会自己跑完再被 GC,无法显式取消 ——
    // 这是 PDFParse v2 API 的固有限制(没有暴露 loadingTask.destroy)。
    if (parser) {
      try {
        await parser.destroy()
      } catch {
        // ignore
      }
    }
  }
}

/** MIME → 可解析的解析器(返回 null 表示不支持,走 Read 回退)。 */
export async function parseDocument(
  filePath: string,
  mimeType: string,
): Promise<ParseResult | null> {
  // 注意:.doc(老格式 application/msword)mammoth 不能解析。返回 null 让上层
  // 走 Read 回退,Read 看到的是二进制,会礼貌地告诉用户"请转存为 .docx"。
  // 不在这里抛错,保持 graceful。
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filePath.toLowerCase().endsWith('.docx')
  ) {
    return parseDocx(filePath)
  }
  if (mimeType === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
    return parsePdf(filePath)
  }
  return null
}

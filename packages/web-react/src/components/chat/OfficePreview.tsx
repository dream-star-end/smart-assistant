/**
 * Office(docx / xlsx / pptx)轻量面板预览(二级懒加载块,OCV5-687):
 * 利用仓库已有的 fflate + 浏览器原生 DOMParser 解析标准 OOXML,零新增依赖、零首屏增量。
 * 超大文件(>8 MB)、加密包或旧版二进制格式不强解,清晰提示下载查看。
 */
import { unzipSync } from 'fflate'
import { AlertCircle, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'
import { fetchSignedCapped } from '../project/outputPreview'
import { Skeleton } from '../ui'
import { DataGridTable } from './DataGridTable'
import { useFreshSignedUrl } from './media'
import { extOf } from './workbench'

export const OFFICE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const MAX_XLSX_SPARSE_COL = 256
const MAX_DOCX_BLOCKS = 300
const MAX_PPTX_SLIDES = 60

const utf8 = new TextDecoder('utf-8', { fatal: false })

export type XlsxSheetData = {
  name: string
  headers: string[]
  rows: string[][]
  totalCols: number
}

export type DocxBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'list'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: string[][]; totalCols: number }

export type PptxSlideData = {
  number: number
  title: string
  lines: string[]
}

export type ParsedOfficeDoc =
  | { kind: 'xlsx'; sheets: XlsxSheetData[] }
  | { kind: 'docx'; blocks: DocxBlock[]; truncated: boolean }
  | { kind: 'pptx'; slides: PptxSlideData[]; totalSlides: number; truncated: boolean }

function localTag(node: Element): string {
  return (node.localName || node.tagName.replace(/^.*:/, '')).toLowerCase()
}

function attrLocal(el: Element, local: string): string | null {
  const direct =
    el.getAttribute(local) ?? el.getAttribute(`w:${local}`) ?? el.getAttribute(`r:${local}`)
  if (direct !== null) return direct
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    if ((a.localName || a.name.replace(/^.*:/, '')).toLowerCase() === local.toLowerCase()) {
      return a.value
    }
  }
  return null
}

function childElements(parent: Element | Document, tag?: string): Element[] {
  const out: Element[] = []
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    if (!tag || localTag(c) === tag) out.push(c)
  }
  return out
}

function descendantElements(root: Element | Document, tag: string): Element[] {
  const out: Element[] = []
  const walk = (el: Element | Document) => {
    const children = el.children
    for (let i = 0; i < children.length; i++) {
      const c = children[i]
      if (localTag(c) === tag) out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes || typeof DOMParser === 'undefined') return null
  const xml = utf8.decode(bytes)
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return null
  return doc
}

function findEntry(files: Record<string, Uint8Array>, relPath: string): Uint8Array | undefined {
  const clean = relPath.replace(/^\/+/, '')
  if (files[clean]) return files[clean]
  const lower = clean.toLowerCase()
  for (const [k, v] of Object.entries(files)) {
    if (k.replace(/^\/+/, '').toLowerCase() === lower) return v
  }
  return undefined
}

function colIndexFromRef(ref: string | null, fallback: number): number {
  if (!ref) return fallback
  const m = /^([A-Za-z]+)/.exec(ref)
  if (!m) return fallback
  let idx = 0
  const letters = m[1].toUpperCase()
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64)
  }
  return Math.max(0, idx - 1)
}

function collectSharedItemText(si: Element): string {
  const parts: string[] = []
  const walk = (el: Element) => {
    const tag = localTag(el)
    // 跳过拼音注音节点 <rPh>,避免中文旁注混进单元格文本
    if (tag === 'rph') return
    if (tag === 't') {
      parts.push(el.textContent ?? '')
      return
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i])
  }
  walk(si)
  return parts.join('')
}

export function parseXlsxArchive(files: Record<string, Uint8Array>): XlsxSheetData[] | null {
  const sharedStrings: string[] = []
  const sstDoc = parseXml(findEntry(files, 'xl/sharedStrings.xml'))
  if (sstDoc?.documentElement) {
    for (const si of childElements(sstDoc.documentElement, 'si')) {
      sharedStrings.push(collectSharedItemText(si))
    }
  }

  const relTargets = new Map<string, string>()
  const relsDoc = parseXml(findEntry(files, 'xl/_rels/workbook.xml.rels'))
  if (relsDoc?.documentElement) {
    for (const rel of childElements(relsDoc.documentElement, 'relationship')) {
      const id = attrLocal(rel, 'id')
      const target = attrLocal(rel, 'target')
      if (!id || !target) continue
      const normalized = target.startsWith('/')
        ? target.replace(/^\/+/, '')
        : `xl/${target.replace(/^\.\//, '')}`
      relTargets.set(id, normalized)
    }
  }

  const sheetSpecs: { name: string; path: string }[] = []
  const wbDoc = parseXml(findEntry(files, 'xl/workbook.xml'))
  if (wbDoc) {
    for (const sh of descendantElements(wbDoc, 'sheet')) {
      const name = attrLocal(sh, 'name') || `Sheet ${sheetSpecs.length + 1}`
      const rid = attrLocal(sh, 'id')
      const target =
        (rid && relTargets.get(rid)) || `xl/worksheets/sheet${sheetSpecs.length + 1}.xml`
      if (findEntry(files, target)) {
        sheetSpecs.push({ name, path: target })
      }
    }
  }
  if (sheetSpecs.length === 0) {
    const fallbacks = Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k.replace(/^\/+/, '')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (const [i, p] of fallbacks.entries()) {
      sheetSpecs.push({ name: `Sheet ${i + 1}`, path: p })
    }
  }
  if (sheetSpecs.length === 0) return null

  const sheets: XlsxSheetData[] = []
  for (const spec of sheetSpecs) {
    const doc = parseXml(findEntry(files, spec.path))
    if (!doc) continue
    const rawRows: string[][] = []
    let maxCol = 0
    for (const rowEl of descendantElements(doc, 'row')) {
      const rowArr: string[] = []
      let nextCol = 0
      let lastNonEmpty = -1
      for (const cEl of childElements(rowEl, 'c')) {
        const col = Math.min(colIndexFromRef(attrLocal(cEl, 'r'), nextCol), MAX_XLSX_SPARSE_COL - 1)
        nextCol = col + 1
        const t = attrLocal(cEl, 't') ?? ''
        let val = ''
        if (t === 'inlineStr') {
          const isEl = childElements(cEl, 'is')[0]
          val = isEl ? collectSharedItemText(isEl) : ''
        } else {
          const vText = childElements(cEl, 'v')[0]?.textContent ?? ''
          if (t === 's') {
            const idx = Number(vText)
            val = Number.isInteger(idx) && idx >= 0 ? (sharedStrings[idx] ?? '') : vText
          } else if (t === 'b') {
            val = vText === '1' ? 'TRUE' : vText === '0' ? 'FALSE' : vText
          } else {
            val = vText
          }
        }
        while (rowArr.length <= col) rowArr.push('')
        rowArr[col] = val
        if (val.trim().length > 0) lastNonEmpty = Math.max(lastNonEmpty, col)
      }
      if (lastNonEmpty >= 0) {
        const trimmed = rowArr.slice(0, lastNonEmpty + 1)
        rawRows.push(trimmed)
        if (trimmed.length > maxCol) maxCol = trimmed.length
      } else if (rawRows.length > 0) {
        // 保留表中间的有意义空行,末尾纯空行统一在收尾剔除
        rawRows.push([])
      }
    }
    while (rawRows.length > 0 && rawRows[rawRows.length - 1].every((c) => c === '')) {
      rawRows.pop()
    }
    if (rawRows.length === 0 || maxCol === 0) {
      sheets.push({ name: spec.name, headers: [], rows: [], totalCols: 0 })
      continue
    }
    const [first, ...rest] = rawRows
    const hasHeader = first.some((c) => c.trim().length > 0)
    const headers = Array.from({ length: maxCol }, (_, i) =>
      hasHeader ? (first[i] ?? '') : `列 ${i + 1}`,
    )
    sheets.push({ name: spec.name, headers, rows: rest, totalCols: maxCol })
  }
  return sheets.length > 0 ? sheets : null
}

function collectWordParagraphText(p: Element): string {
  const parts: string[] = []
  const walk = (el: Element) => {
    const tag = localTag(el)
    if (tag === 't') {
      parts.push(el.textContent ?? '')
      return
    }
    if (tag === 'tab') {
      parts.push('\t')
      return
    }
    if (tag === 'br' || tag === 'cr') {
      parts.push('\n')
      return
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i])
  }
  walk(p)
  return parts.join('')
}

export function parseDocxArchive(
  files: Record<string, Uint8Array>,
): { blocks: DocxBlock[]; truncated: boolean } | null {
  const doc = parseXml(findEntry(files, 'word/document.xml'))
  if (!doc) return null
  const body = descendantElements(doc, 'body')[0]
  if (!body) return null
  const blocks: DocxBlock[] = []
  let truncated = false

  for (let i = 0; i < body.children.length; i++) {
    const el = body.children[i]
    const tag = localTag(el)
    if (tag === 'p') {
      const text = collectWordParagraphText(el).trim()
      if (!text) continue
      if (blocks.length >= MAX_DOCX_BLOCKS) {
        truncated = true
        break
      }
      const pPr = childElements(el, 'ppr')[0]
      const styleEl = pPr ? childElements(pPr, 'pstyle')[0] : undefined
      const styleVal = (styleEl ? attrLocal(styleEl, 'val') : '') ?? ''
      const isList = pPr ? childElements(pPr, 'numpr').length > 0 : false
      const headingMatch =
        /^(?:heading\s*|标题\s*)([1-4])$/i.exec(styleVal) ??
        (/^title$/i.test(styleVal) ? ['title', '1'] : null)
      if (headingMatch) {
        const level = Math.min(4, Math.max(1, Number(headingMatch[1]) || 1)) as 1 | 2 | 3 | 4
        blocks.push({ kind: 'heading', level, text })
      } else if (isList) {
        blocks.push({ kind: 'list', text })
      } else {
        blocks.push({ kind: 'paragraph', text })
      }
    } else if (tag === 'tbl') {
      if (blocks.length >= MAX_DOCX_BLOCKS) {
        truncated = true
        break
      }
      const rows: string[][] = []
      let totalCols = 0
      for (const tr of childElements(el, 'tr')) {
        const cells: string[] = []
        for (const tc of childElements(tr, 'tc')) {
          const cellLines = childElements(tc, 'p')
            .map((p) => collectWordParagraphText(p).trim())
            .filter(Boolean)
          cells.push(cellLines.join('\n'))
        }
        if (cells.length > 0) {
          rows.push(cells)
          if (cells.length > totalCols) totalCols = cells.length
        }
      }
      if (rows.length > 0 && totalCols > 0) {
        blocks.push({ kind: 'table', rows, totalCols })
      }
    }
  }
  return { blocks, truncated }
}

export function parsePptxArchive(
  files: Record<string, Uint8Array>,
): { slides: PptxSlideData[]; totalSlides: number; truncated: boolean } | null {
  const slideEntries = Object.entries(files)
    .map(([k, bytes]) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(k.replace(/^\/+/, ''))
      return m ? { number: Number(m[1]), bytes } : null
    })
    .filter((x): x is { number: number; bytes: Uint8Array } => x !== null)
    .sort((a, b) => a.number - b.number)

  if (slideEntries.length === 0) return null
  const totalSlides = slideEntries.length
  const truncated = totalSlides > MAX_PPTX_SLIDES
  const slides: PptxSlideData[] = []

  for (const entry of slideEntries.slice(0, MAX_PPTX_SLIDES)) {
    const doc = parseXml(entry.bytes)
    if (!doc) continue
    let title = ''
    const lines: string[] = []
    for (const sp of descendantElements(doc, 'sp')) {
      const ph = descendantElements(sp, 'ph')[0]
      const phType = (ph ? attrLocal(ph, 'type') : '')?.toLowerCase() ?? ''
      const isTitle = phType === 'title' || phType === 'ctrtitle'
      const spLines: string[] = []
      for (const p of descendantElements(sp, 'p')) {
        const text = descendantElements(p, 't')
          .map((t) => t.textContent ?? '')
          .join('')
          .trim()
        if (text) spLines.push(text)
      }
      if (spLines.length === 0) continue
      if (isTitle && !title) {
        title = spLines.join(' ')
      } else {
        lines.push(...spLines)
      }
    }
    if (!title && lines.length > 0) {
      title = lines.shift() ?? ''
    }
    slides.push({ number: entry.number, title, lines })
  }
  return { slides, totalSlides, truncated }
}

export function parseOfficeBytes(bytes: Uint8Array, filename: string): ParsedOfficeDoc | null {
  // 标准 OOXML 必须是 PK\x03\x04 ZIP 归档
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    return null
  }
  const ext = extOf(filename)
  if (ext === 'xlsx') {
    const sheets = parseXlsxArchive(files)
    return sheets ? { kind: 'xlsx', sheets } : null
  }
  if (ext === 'docx') {
    const parsed = parseDocxArchive(files)
    return parsed ? { kind: 'docx', ...parsed } : null
  }
  if (ext === 'pptx') {
    const parsed = parsePptxArchive(files)
    return parsed ? { kind: 'pptx', ...parsed } : null
  }
  return null
}

type OfficeLoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; doc: ParsedOfficeDoc }
  | { phase: 'too-large' }
  | { phase: 'unsupported' }
  | { phase: 'failed' }

export default function OfficePreview({
  path,
  name,
  refreshKey = '',
}: {
  path: string
  name: string
  refreshKey?: string
}) {
  const { get } = useFreshSignedUrl(path)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<OfficeLoadState>({ phase: 'loading' })
  const [sheetIdx, setSheetIdx] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 与 refreshKey 驱动重新拉取
  useEffect(() => {
    const controller = new AbortController()
    setState({ phase: 'loading' })
    setSheetIdx(0)
    fetchSignedCapped(get, OFFICE_PREVIEW_MAX_BYTES, { signal: controller.signal, truncate: false })
      .then((r) => {
        if (controller.signal.aborted) return
        if (r.kind === 'too-large') {
          setState({ phase: 'too-large' })
          return
        }
        const doc = parseOfficeBytes(r.bytes, name)
        setState(doc ? { phase: 'ready', doc } : { phase: 'unsupported' })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setState({ phase: 'failed' })
      })
    return () => controller.abort()
  }, [get, name, attempt, refreshKey])

  if (state.phase === 'loading') {
    return (
      <div className="space-y-2 px-5 py-5" data-testid="output-preview-loading">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    )
  }
  if (state.phase === 'too-large') {
    return <OfficeNotice text="文件超过 8 MB，不在面板里预览；可以下载查看。" />
  }
  if (state.phase === 'unsupported') {
    return <OfficeNotice text="无法在面板中解析此文件（可能已加密或为旧版格式）；可以下载查看。" />
  }
  if (state.phase === 'failed') {
    return (
      <OfficeNotice
        text="没能读取这个文件（可能已被移动或删除）。"
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  }

  const { doc } = state
  if (doc.kind === 'xlsx') {
    const active = doc.sheets[sheetIdx] ?? doc.sheets[0]
    return (
      <div data-testid="output-preview-office">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-surface px-3.5 py-1.5 text-caption text-faint">
          <span>轻量预览 · 完整公式与样式请下载查看</span>
          {doc.sheets.length > 1 && (
            <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="工作表">
              {doc.sheets.map((s, idx) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: 工作表顺序固定
                  key={idx}
                  type="button"
                  role="tab"
                  data-testid="office-sheet-tab"
                  aria-selected={idx === sheetIdx}
                  onClick={() => setSheetIdx(idx)}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-caption transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    idx === sheetIdx
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {active && (
          <DataGridTable
            key={sheetIdx}
            headers={active.headers}
            rows={active.rows}
            totalCols={active.totalCols}
            testId="output-preview-xlsx"
          />
        )}
      </div>
    )
  }

  if (doc.kind === 'docx') {
    return (
      <div className="flex flex-col" data-testid="output-preview-docx">
        <div className="border-b border-border/60 bg-hover/30 px-4 py-1.5 text-caption text-faint">
          轻量预览 · 仅展示正文与表格，完整排版与公式请下载查看
        </div>
        {doc.blocks.length === 0 ? (
          <div className="px-5 py-8 text-center text-meta text-muted">
            未提取到可预览的正文文本，请下载查看完整文档。
          </div>
        ) : (
          <div className="space-y-3 px-5 py-4 text-body text-fg">
            {doc.blocks.map((b, idx) => {
              if (b.kind === 'heading') {
                const cls =
                  b.level === 1
                    ? 'text-base font-semibold text-fg'
                    : b.level === 2
                      ? 'text-sm font-semibold text-fg'
                      : 'text-sm font-medium text-fg'
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 文档段落按静态顺序渲染
                  <h4 key={idx} className={cls}>
                    {b.text}
                  </h4>
                )
              }
              if (b.kind === 'list') {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 文档列表项按静态顺序渲染
                  <div key={idx} className="flex gap-2 pl-2">
                    <span className="text-faint" aria-hidden>
                      •
                    </span>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap">{b.text}</p>
                  </div>
                )
              }
              if (b.kind === 'table') {
                const [first, ...rest] = b.rows
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 文档内嵌表格按静态顺序渲染
                  <div key={idx} className="overflow-x-auto rounded-lg border border-border/70">
                    <table className="w-max min-w-full border-collapse text-left text-xs">
                      {first && (
                        <thead className="bg-hover/50">
                          <tr>
                            {Array.from({ length: b.totalCols }, (_, ci) => (
                              <th
                                // biome-ignore lint/suspicious/noArrayIndexKey: 列按顺序展示
                                key={ci}
                                className="border-r border-b border-border/50 px-3 py-1.5 font-medium text-fg last:border-r-0"
                              >
                                {first[ci] ?? ''}
                              </th>
                            ))}
                          </tr>
                        </thead>
                      )}
                      <tbody>
                        {rest.map((r, ri) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 行按顺序展示
                          <tr key={ri}>
                            {Array.from({ length: b.totalCols }, (_, ci) => (
                              <td
                                // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按顺序展示
                                key={ci}
                                className="border-r border-b border-border/40 px-3 py-1.5 whitespace-pre-wrap text-fg last:border-r-0"
                              >
                                {r[ci] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 文档段落按静态顺序渲染
                <p key={idx} className="whitespace-pre-wrap leading-relaxed">
                  {b.text}
                </p>
              )
            })}
            {doc.truncated && (
              <p
                className="border-t border-border/60 pt-2 text-caption text-muted"
                data-testid="output-preview-docx-truncated"
              >
                文档较长，当前仅展示前 {MAX_DOCX_BLOCKS} 段内容；完整文档请下载查看。
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col" data-testid="output-preview-pptx">
      <div className="border-b border-border/60 bg-hover/30 px-4 py-1.5 text-caption text-faint">
        轻量预览 · 共 {doc.totalSlides} 页文字大纲，完整版式与图表请下载查看
      </div>
      <div className="space-y-3 px-4 py-4">
        {doc.slides.map((s) => (
          <section
            key={s.number}
            className="rounded-lg border border-border/70 bg-surface p-3.5"
            data-testid="office-slide"
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted">
                第 {s.number} 页
              </span>
              {s.title && (
                <h4 className="min-w-0 flex-1 truncate text-body font-semibold text-fg">
                  {s.title}
                </h4>
              )}
            </div>
            {s.lines.length > 0 ? (
              <ul className="space-y-1 pl-4 text-meta text-fg list-disc">
                {s.lines.map((line, li) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 幻灯片行按静态顺序渲染
                  <li key={li}>{line}</li>
                ))}
              </ul>
            ) : !s.title ? (
              <p className="text-caption text-faint">（本页无文本，可能仅含图片或图形）</p>
            ) : null}
          </section>
        ))}
        {doc.truncated && (
          <p className="text-center text-caption text-muted">
            幻灯片较多，当前仅展示前 {MAX_PPTX_SLIDES} / {doc.totalSlides}{' '}
            页；完整演示文稿请下载查看。
          </p>
        )}
      </div>
    </div>
  )
}

function OfficeNotice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-2 px-6 py-12 text-center text-meta text-muted"
      data-testid="output-preview-notice"
    >
      <AlertCircle size={18} className="text-faint" aria-hidden />
      <p>{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw size={12} aria-hidden />
          继续
        </button>
      )}
    </div>
  )
}

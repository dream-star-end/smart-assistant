/**
 * 结构化表格预览(OCV5-687):供 CSV / TSV 与 XLSX 轻量预览共用。
 * 位于懒加载块内,不进入首屏闭包;支持粘性表头、横向与纵向滚动、大文件截断提示与展开更多。
 */
import { useMemo, useState } from 'react'
import { extOf } from './workbench'

export const DEFAULT_PREVIEW_ROWS = 200
export const EXPANDED_PREVIEW_ROWS = 1000
export const MAX_PREVIEW_COLS = 80

export type ParsedDelimitedTable = {
  headers: string[]
  rows: string[][]
  totalCols: number
  byteTruncated: boolean
}

/** 在引号外统计首行分隔符数量,兼容扩展名为 .csv 但实际以制表符或分号分隔的导出文件。 */
function detectDelimiter(sample: string, preferred?: ',' | '\t'): ',' | '\t' | ';' {
  if (preferred) return preferred
  let inQuotes = false
  let commas = 0
  let tabs = 0
  let semis = 0
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i]
    if (ch === '"') {
      if (inQuotes && sample[i + 1] === '"') {
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes) {
      if (ch === '\n' || ch === '\r') break
      if (ch === ',') commas++
      else if (ch === '\t') tabs++
      else if (ch === ';') semis++
    }
  }
  if (tabs > commas && commas === 0) return '\t'
  if (semis > commas && commas === 0 && tabs === 0) return ';'
  return ','
}

/**
 * RFC 4180 CSV / TSV 解析:处理 UTF-8 BOM、双引号包裹字段、转义 ""、字段内换行与逗号。
 * 若字节层已按上限截断(byteTruncated=true),裁去末尾不完整的一行,避免展示半截脏数据。
 */
export function parseDelimitedTable(
  rawText: string,
  opts: { filename?: string; byteTruncated?: boolean } = {},
): ParsedDelimitedTable {
  let text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
  const byteTruncated = opts.byteTruncated === true
  if (byteTruncated) {
    const lastNl = text.lastIndexOf('\n')
    if (lastNl > 0) text = text.slice(0, lastNl + 1)
  }
  const ext = opts.filename ? extOf(opts.filename) : ''
  const delimiter = detectDelimiter(text, ext === 'tsv' ? '\t' : undefined)

  const parsed: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      parsed.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    parsed.push(row)
  }
  // 去掉末尾纯空行
  while (
    parsed.length > 0 &&
    parsed[parsed.length - 1].length === 1 &&
    parsed[parsed.length - 1][0] === ''
  ) {
    parsed.pop()
  }
  if (parsed.length === 0) {
    return { headers: [], rows: [], totalCols: 0, byteTruncated }
  }
  let totalCols = 0
  for (const r of parsed) {
    if (r.length > totalCols) totalCols = r.length
  }
  const [first, ...rest] = parsed
  const hasHeaderText = first.some((c) => c.trim().length > 0)
  const headers = Array.from({ length: totalCols }, (_, i) =>
    hasHeaderText ? (first[i] ?? '') : `列 ${i + 1}`,
  )
  return { headers, rows: rest, totalCols, byteTruncated }
}

export function DataGridTable({
  headers,
  rows,
  totalCols = headers.length,
  byteTruncated = false,
  testId = 'output-preview-csv',
}: {
  headers: string[]
  rows: string[][]
  totalCols?: number
  byteTruncated?: boolean
  testId?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const rowCap = expanded ? EXPANDED_PREVIEW_ROWS : DEFAULT_PREVIEW_ROWS
  const shownCols = Math.min(totalCols, MAX_PREVIEW_COLS)
  const shownRows = rows.slice(0, rowCap)
  const rowsTruncated = byteTruncated || rows.length > rowCap
  const colsTruncated = totalCols > MAX_PREVIEW_COLS

  if (totalCols === 0 && rows.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-meta text-muted" data-testid={testId}>
        表格内容为空
      </div>
    )
  }

  return (
    <div className="flex flex-col" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-hover/30 px-3.5 py-1.5 text-caption text-muted">
        <span className="tabular-nums">
          {byteTruncated ? `至少 ${rows.length} 行` : `共 ${rows.length} 行`} · {totalCols} 列
        </span>
        {(rowsTruncated || colsTruncated) && (
          <span
            className="flex flex-wrap items-center gap-2 text-muted"
            data-testid="output-preview-table-truncated"
          >
            <span>
              {byteTruncated
                ? `文件较大，当前仅预览前 ${shownRows.length} 行${colsTruncated ? `、前 ${shownCols} 列` : ''}；完整数据请下载查看`
                : `已展示前 ${shownRows.length} / ${rows.length} 行${colsTruncated ? `、前 ${shownCols} / ${totalCols} 列` : ''}；完整数据请下载查看`}
            </span>
            {!byteTruncated && !expanded && rows.length > DEFAULT_PREVIEW_ROWS && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                展开更多
              </button>
            )}
          </span>
        )}
      </div>
      <div className="max-h-[58vh] w-full overflow-auto" data-testid="output-preview-table-scroll">
        <table
          className="w-max min-w-full border-collapse text-left text-xs [overflow-wrap:normal]"
          data-testid="output-preview-table"
        >
          <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_0_var(--color-border)]">
            <tr>
              <th
                scope="col"
                className="w-10 border-r border-border/60 bg-hover/50 px-2.5 py-2 text-right font-normal tabular-nums text-faint"
              >
                #
              </th>
              {Array.from({ length: shownCols }, (_, ci) => {
                const label = headers[ci]?.trim() ? headers[ci] : `列 ${ci + 1}`
                return (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: 列按固定列序渲染
                    key={ci}
                    scope="col"
                    title={label}
                    className="max-w-[20rem] truncate whitespace-nowrap border-r border-border/40 bg-hover/50 px-3 py-2 font-medium text-fg last:border-r-0"
                  >
                    {label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 数据行按行号静态展示
              <tr key={ri} className="transition-colors hover:bg-hover/40">
                <td className="border-r border-b border-border/50 bg-surface px-2.5 py-1.5 text-right tabular-nums text-faint">
                  {ri + 1}
                </td>
                {Array.from({ length: shownCols }, (_, ci) => {
                  const val = r[ci] ?? ''
                  return (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按列序静态展示
                      key={ci}
                      title={val || undefined}
                      className="max-w-[22rem] truncate whitespace-nowrap border-r border-b border-border/40 px-3 py-1.5 tabular-nums text-fg last:border-r-0"
                    >
                      {val}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function CsvTablePreview({
  text,
  name,
  byteTruncated = false,
}: {
  text: string
  name: string
  byteTruncated?: boolean
}) {
  const table = useMemo(
    () => parseDelimitedTable(text, { filename: name, byteTruncated }),
    [text, name, byteTruncated],
  )
  return (
    <DataGridTable
      headers={table.headers}
      rows={table.rows}
      totalCols={table.totalCols}
      byteTruncated={table.byteTruncated}
      testId="output-preview-csv"
    />
  )
}

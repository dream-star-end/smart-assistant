/**
 * OCV5-687 产出正文预览单测:
 *  - CSV / TSV RFC 4180 表格解析与渲染、横向滚动容器、行数与 >1 MB 字节截断提示及「展开更多」
 *  - Office(xlsx 多表与稀疏列 / docx 标题·列表·表格 / pptx 分页文字大纲)真实 OOXML ZIP 轻量预览及超限/损坏兜底
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { loadBeforeAll } from '../../test/moduleLoad'
import { prefetchMarkdownImpl } from '../Markdown'
import { FilePreview } from './OutputPreview'

loadBeforeAll(prefetchMarkdownImpl)
loadBeforeAll(() => import('./OfficePreview'))

const fetchSignedCapped = vi.hoisted(() => vi.fn())
vi.mock('../project/outputPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../project/outputPreview')>()),
  fetchSignedCapped,
}))

afterEach(cleanup)
beforeEach(() => {
  fetchSignedCapped.mockReset()
})

function buildXlsxBytes(): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="季度营收" sheetId="1" r:id="rId1"/>
          <sheet name="地区明细" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
        <si><t>季度</t></si>
        <si><t>备注</t></si>
        <si><t>Q1 增长</t></si>
        <si><t>华东区</t></si>
      </sst>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="inlineStr"><is><t>金额</t></is></c>
            <c r="C1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>2</v></c>
            <c r="C2" t="b"><v>1</v></c>
          </row>
        </sheetData>
      </worksheet>`,
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>大区</t></is></c></row>
          <row r="2"><c r="A2" t="s"><v>3</v></c></row>
        </sheetData>
      </worksheet>`,
    ),
  })
}

function buildDocxBytes(): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>年度市场复盘</w:t></w:r>
          </w:p>
          <w:p>
            <w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>
            <w:r><w:t>核心指标达成率 118%</w:t></w:r>
          </w:p>
          <w:p>
            <w:r><w:t>总结说明第一段。</w:t></w:r>
          </w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>结果</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:p><w:r><w:t>转化率</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>12.4%</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>`,
    ),
  })
}

function buildPptxBytes(): Uint8Array {
  return zipSync({
    'ppt/slides/slide1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp>
            <p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>产品路线图汇报</a:t></a:r></a:p></p:txBody>
          </p:sp>
          <p:sp>
            <p:nvSpPr><p:nvPr/></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>个人版体验重构进展</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:spTree></p:cSld>
      </p:sld>`,
    ),
    'ppt/slides/slide2.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp>
            <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>下一步计划</a:t></a:r></a:p></p:txBody>
          </p:sp>
          <p:sp>
            <p:nvSpPr><p:nvPr/></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>完成产出面板表格预览</a:t></a:r></a:p></p:txBody>
          </p:sp>
        </p:spTree></p:cSld>
      </p:sld>`,
    ),
  })
}

describe('CSV / TSV 表格预览 (OCV5-687)', () => {
  test('RFC 4180 引号字段、内嵌逗号与转义双引号正确渲染为可横向滚动表格', () => {
    const csv = '\uFEFF姓名,部门,备注\nAlice,研发,"含,逗号与""引号"""\nBob,运营,正常\n'
    render(
      <FilePreview path="/w/team.csv" name="team.csv" kind="csv" replayed={csv} view="preview" />,
    )
    const scroll = screen.getByTestId('output-preview-table-scroll')
    expect(scroll.className).toContain('overflow-auto')
    const table = screen.getByTestId('output-preview-table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((el) => el.textContent)
    expect(headers).toEqual(['#', '姓名', '部门', '备注'])
    expect(within(table).getByText('含,逗号与"引号"')).toBeInTheDocument()
    expect(screen.getByText('共 2 行 · 3 列')).toBeInTheDocument()
    expect(screen.queryByTestId('output-preview-table-truncated')).not.toBeInTheDocument()
  })

  test('大行数 CSV 默认截断前 200 行并给下载提示,点击「展开更多」可查看后续行', () => {
    const lines = ['id,val', ...Array.from({ length: 240 }, (_, i) => `${i + 1},row-${i + 1}`)]
    render(
      <FilePreview
        path="/w/big.csv"
        name="big.csv"
        kind="csv"
        replayed={lines.join('\n')}
        view="preview"
      />,
    )
    expect(screen.getByTestId('output-preview-table-truncated')).toHaveTextContent(
      '已展示前 200 / 240 行',
    )
    expect(screen.queryByText('row-235')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开更多' }))
    expect(screen.getByText('row-235')).toBeInTheDocument()
  })

  test('>1 MB 容器 CSV 按首段完整行截断预览,丢弃末尾半截行并提示下载完整文件', async () => {
    const chunk = new TextEncoder().encode('id,name\n1,Alice\n2,Bob\n3,HalfCutRowWithoutNewline')
    fetchSignedCapped.mockResolvedValueOnce({
      kind: 'ok',
      bytes: chunk,
      type: 'text/csv',
      truncated: true,
    })
    render(
      <FilePreview path="/w/huge.csv" name="huge.csv" kind="csv" replayed={null} view="preview" />,
    )
    expect(await screen.findByTestId('output-preview-table-truncated')).toHaveTextContent(
      '文件较大，当前仅预览前 2 行',
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.queryByText(/HalfCutRowWithoutNewline/)).not.toBeInTheDocument()
  })
})

describe('Office (xlsx / docx / pptx) 轻量预览 (OCV5-687)', () => {
  test('xlsx: 默认渲染首表(含共享字符串、行内字符串、稀疏列对齐),支持切换第二个工作表', async () => {
    fetchSignedCapped.mockResolvedValueOnce({
      kind: 'ok',
      bytes: buildXlsxBytes(),
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      truncated: false,
    })
    render(
      <FilePreview
        path="/w/revenue.xlsx"
        name="revenue.xlsx"
        kind="office"
        replayed={null}
        view="preview"
      />,
    )
    const table = await screen.findByTestId('output-preview-table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', '季度', '金额', '备注'])
    expect(within(table).getByText('Q1 增长')).toBeInTheDocument()
    expect(within(table).getByText('TRUE')).toBeInTheDocument()

    const tabs = screen.getAllByTestId('office-sheet-tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['季度营收', '地区明细'])
    fireEvent.click(tabs[1])
    expect(await screen.findByText('华东区')).toBeInTheDocument()
  })

  test('docx: 渲染标题、列表项、正文段落与内嵌表格', async () => {
    fetchSignedCapped.mockResolvedValueOnce({
      kind: 'ok',
      bytes: buildDocxBytes(),
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      truncated: false,
    })
    render(
      <FilePreview
        path="/w/review.docx"
        name="review.docx"
        kind="office"
        replayed={null}
        view="preview"
      />,
    )
    const box = await screen.findByTestId('output-preview-docx')
    expect(within(box).getByText('年度市场复盘')).toBeInTheDocument()
    expect(within(box).getByText('核心指标达成率 118%')).toBeInTheDocument()
    expect(within(box).getByText('12.4%')).toBeInTheDocument()
  })

  test('pptx: 按页序渲染幻灯片标题与文字要点', async () => {
    fetchSignedCapped.mockResolvedValueOnce({
      kind: 'ok',
      bytes: buildPptxBytes(),
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      truncated: false,
    })
    render(
      <FilePreview
        path="/w/deck.pptx"
        name="deck.pptx"
        kind="office"
        replayed={null}
        view="preview"
      />,
    )
    const box = await screen.findByTestId('output-preview-pptx')
    const slides = within(box).getAllByTestId('office-slide')
    expect(slides).toHaveLength(2)
    expect(slides[0]).toHaveTextContent('第 1 页')
    expect(slides[0]).toHaveTextContent('产品路线图汇报')
    expect(slides[1]).toHaveTextContent('完成产出面板表格预览')
  })

  test('损坏或超 8 MB 的 Office 文件优雅回退下载提示', async () => {
    fetchSignedCapped.mockResolvedValueOnce({ kind: 'too-large', total: 12 * 1024 * 1024 })
    const { unmount } = render(
      <FilePreview
        path="/w/huge.xlsx"
        name="huge.xlsx"
        kind="office"
        replayed={null}
        view="preview"
      />,
    )
    expect(await screen.findByTestId('output-preview-notice')).toHaveTextContent('文件超过 8 MB')
    unmount()

    fetchSignedCapped.mockResolvedValueOnce({
      kind: 'ok',
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      type: 'application/octet-stream',
      truncated: false,
    })
    render(
      <FilePreview
        path="/w/encrypted.docx"
        name="encrypted.docx"
        kind="office"
        replayed={null}
        view="preview"
      />,
    )
    expect(await screen.findByTestId('output-preview-notice')).toHaveTextContent(
      '无法在面板中解析此文件',
    )
  })
})

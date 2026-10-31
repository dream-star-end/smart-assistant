import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'
import { buildHarnessPage, serveHarnessPage } from './harness-page.mjs'

const { chromium } = createRequire(import.meta.url)('playwright-core')
const _here = dirname(fileURLToPath(import.meta.url))

function makeLargeCsv() {
  const header = '序号,地区,负责人,季度营收,同比增长,长备注说明字段用于验证横向滚动'
  const rows = Array.from(
    { length: 230 },
    (_, i) =>
      `${i + 1},华东-${i + 1},张三,${10000 + i * 50},+18.${i % 9}%,"这是一段较长的业务备注文本第 ${i + 1} 行，含,逗号"`,
  )
  return `${[header, ...rows].join('\n')}\n`
}

function makeXlsxBuffer() {
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="汇总总览" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>`,
      ),
      'xl/sharedStrings.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
        <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
          <si><t>大区</t></si>
          <si><t>华东大区</t></si>
        </sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1">
              <c r="A1" t="s"><v>0</v></c>
              <c r="B1" t="inlineStr"><is><t>总销售额</t></is></c>
            </row>
            <row r="2">
              <c r="A2" t="s"><v>1</v></c>
              <c r="B2"><v>985000</v></c>
            </row>
          </sheetData>
        </worksheet>`,
      ),
    }),
  )
}

function makeDocxBuffer() {
  return Buffer.from(
    zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度经营复盘纪要</w:t></w:r></w:p>
            <w:p><w:r><w:t>核心结论：华东大区超额完成季度目标。</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
      ),
    }),
  )
}

test(
  'OCV5-687 output panel aggregates session turns without empty flash, previews CSV/Office in panel, and deduplicates downloads',
  { timeout: 180000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-outpanel-687-'))
    const csvBytes = Buffer.from(makeLargeCsv(), 'utf8')
    const xlsxBytes = makeXlsxBuffer()
    const docxBytes = makeDocxBuffer()

    let assets
    let http
    let browser
    try {
      await buildHarnessPage({ harness: 'ocv5-687-outpanel-preview-harness.tsx', assetDir: dir })
      assets = await serveHarnessPage(dir)

      http = createServer(async (req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (reqUrl.pathname === '/api/media-sign') {
          let body = ''
          for await (const chunk of req) body += chunk
          const { paths } = JSON.parse(body)
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify(
              Object.fromEntries(paths.map((p) => [p, `/api/media?file=${encodeURIComponent(p)}`])),
            ),
          )
          return
        }
        if (reqUrl.pathname === '/api/media') {
          const target = reqUrl.searchParams.get('file') ?? ''
          if (target.endsWith('.csv')) {
            res.writeHead(200, {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition':
                "attachment; filename*=UTF-8''%E9%94%80%E5%94%AE%E6%98%8E%E7%BB%86.csv",
              'content-length': String(csvBytes.byteLength),
            })
            res.end(csvBytes)
            return
          }
          if (target.endsWith('.xlsx')) {
            res.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-length': String(xlsxBytes.byteLength),
            })
            res.end(xlsxBytes)
            return
          }
          if (target.endsWith('.docx')) {
            res.writeHead(200, {
              'content-type':
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'content-length': String(docxBytes.byteLength),
            })
            res.end(docxBytes)
            return
          }
        }
        const upstream = await fetch(new URL(req.url ?? '/', assets.url))
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
        res.end(Buffer.from(await upstream.arrayBuffer()))
      })
      await new Promise((done) => http.listen(0, '127.0.0.1', done))
      const baseUrl = `http://127.0.0.1:${http.address().port}`

      browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox'],
      })
      const page = await browser.newPage({
        viewport: { width: 1280, height: 840 },
        acceptDownloads: true,
      })
      const downloads = []
      page.on('download', (d) => downloads.push(d))

      // 1) 首轮运行中: 显示进行中态, 不闪「还没有产出 / 没有产出文件」
      await page.goto(`${baseUrl}/?mode=first-running`)
      await page.getByTestId('outputs-running').waitFor()
      assert.equal(await page.getByTestId('outputs-empty').count(), 0)
      assert.equal(await page.getByTestId('outputs-none').count(), 0)

      // 2) 多轮对话(第 2 轮无新增文件): 无需点箭头, 直接看到第 1 轮的全部产出且 CSV 默认渲染成表格
      await page.getByTestId('switch-multi-turn').click()
      await page.getByTestId('outputs-hero').waitFor()
      assert.equal(await page.getByTestId('outputs-none').count(), 0)
      assert.equal(await page.getByTestId('outputs-file').count(), 3)
      await page.getByTestId('output-preview-table').waitFor()
      assert.match(
        await page.getByTestId('output-preview-table-truncated').innerText(),
        /200 \/ 230/,
      )
      const scrollMetrics = await page
        .getByTestId('output-preview-table-scroll')
        .evaluate((el) => {
          el.scrollLeft = 80
          return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft }
        })
      assert.equal(
        scrollMetrics.scrollWidth > scrollMetrics.clientWidth && scrollMetrics.scrollLeft > 0,
        true,
        `expected horizontal scroll, got ${JSON.stringify(scrollMetrics)}`,
      )

      // 3) 聊天中点击 xlsx / docx / csv 卡片主区域: 先在右侧面板预览, 0 次下载触发
      const chat = page.getByTestId('chat-stream')
      await chat.getByRole('button', { name: /季度汇总\.xlsx/ }).click()
      await page.getByTestId('output-preview-xlsx').waitFor()
      assert.match(await page.getByTestId('output-preview-xlsx').innerText(), /华东大区/)
      assert.match(await page.getByTestId('output-preview-xlsx').innerText(), /985000/)

      await chat.getByRole('button', { name: /复盘纪要\.docx/ }).click()
      await page.getByTestId('output-preview-docx').waitFor()
      assert.match(await page.getByTestId('output-preview-docx').innerText(), /季度经营复盘纪要/)

      await chat.getByRole('button', { name: /销售明细\.csv/ }).click()
      await page.getByTestId('output-preview-csv').waitFor()
      assert.equal(
        downloads.length,
        0,
        'clicking previewable file cards must preview without downloading',
      )

      // 4) 独立下载按钮连续双击: 只触发 1 次下载, 不重复下载
      const dlLink = chat.getByRole('link', { name: '下载 销售明细.csv' })
      const firstDownload = page.waitForEvent('download')
      await dlLink.dblclick()
      const dl = await firstDownload
      await dlLink.click()
      await page.waitForTimeout(300)
      assert.equal(
        downloads.length,
        1,
        'rapid repeated clicks on download must only trigger a single download',
      )
      assert.equal(readFileSync(await dl.path(), 'utf8'), csvBytes.toString('utf8'))

      await page.close()
    } finally {
      if (browser) await browser.close()
      if (http) {
        http.closeAllConnections()
        await new Promise((done) => http.close(done))
      }
      if (assets) await assets.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'builtinBrowser.js'),
  'utf-8',
)
  .replace(/^import .*$/gm, '')
  .replace(/export function/g, 'function')

const helpers = new Function(
  `${SRC}; return { normalizeBrowserUrl, isBuiltinBrowserUrl, getBuiltinBrowserUrlForClick, truncateText, buildBrowserSelectionPrompt };`,
)() as {
  normalizeBrowserUrl: (raw: string, baseHref?: string) => string | null
  isBuiltinBrowserUrl: (raw: string, baseHref?: string) => boolean
  getBuiltinBrowserUrlForClick: (ev: any, anchor: any, baseHref?: string) => string | null
  truncateText: (value: string, limit?: number) => string
  buildBrowserSelectionPrompt: (ctx: any, req: string) => string
}

function fakeAnchor(opts: {
  href: string
  download?: boolean
  closestMatch?: boolean
}) {
  return {
    hasAttribute(name: string) {
      return name === 'download' && !!opts.download
    },
    closest(selector: string) {
      return opts.closestMatch && selector.includes('.doc-card') ? {} : null
    },
    getAttribute(name: string) {
      return name === 'href' ? opts.href : null
    },
  }
}

const LEFT_CLICK = { button: 0 }

describe('builtin browser URL normalization', () => {
  it('accepts absolute http(s), protocol-relative, host-like, localhost, and relative URLs', () => {
    assert.equal(helpers.normalizeBrowserUrl('https://example.com/a'), 'https://example.com/a')
    assert.equal(
      helpers.normalizeBrowserUrl('//example.com/a', 'https://oc.test/chat'),
      'https://example.com/a',
    )
    assert.equal(helpers.normalizeBrowserUrl('example.com/a'), 'https://example.com/a')
    assert.equal(helpers.normalizeBrowserUrl('example.com?foo=1'), 'https://example.com/?foo=1')
    assert.equal(helpers.normalizeBrowserUrl('example.com#hero'), 'https://example.com/#hero')
    assert.equal(helpers.normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000/')
    assert.equal(helpers.normalizeBrowserUrl('localhost:3000?debug'), 'http://localhost:3000/?debug')
    assert.equal(helpers.normalizeBrowserUrl('192.168.1.42:3000'), 'http://192.168.1.42:3000/')
    assert.equal(helpers.normalizeBrowserUrl('10.0.0.5:5173/app'), 'http://10.0.0.5:5173/app')
    assert.equal(helpers.normalizeBrowserUrl('8.8.8.8'), 'http://8.8.8.8/')
    assert.equal(
      helpers.normalizeBrowserUrl('/preview', 'https://oc.test/chat'),
      'https://oc.test/preview',
    )
  })

  it('rejects unsafe protocols', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:a@b']) {
      assert.equal(helpers.normalizeBrowserUrl(url, 'https://oc.test/'), null)
      assert.equal(helpers.isBuiltinBrowserUrl(url, 'https://oc.test/'), false)
    }
  })
})

describe('builtin browser link interception guard', () => {
  it('opens ordinary http(s) links', () => {
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        LEFT_CLICK,
        fakeAnchor({ href: 'https://example.com/app' }),
        'https://oc.test/',
      ),
      'https://example.com/app',
    )
  })

  it('preserves modified clicks, middle clicks, downloads, doc/media cards, same-origin links, and unsafe links', () => {
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        { button: 0, metaKey: true },
        fakeAnchor({ href: 'https://example.com' }),
        'https://oc.test/',
      ),
      null,
    )
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        { button: 1 },
        fakeAnchor({ href: 'https://example.com' }),
        'https://oc.test/',
      ),
      null,
    )
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        LEFT_CLICK,
        fakeAnchor({ href: 'https://example.com/file.zip', download: true }),
        'https://oc.test/',
      ),
      null,
    )
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        LEFT_CLICK,
        fakeAnchor({ href: 'https://example.com/doc.pdf', closestMatch: true }),
        'https://oc.test/',
      ),
      null,
    )
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        LEFT_CLICK,
        fakeAnchor({ href: '/preview' }),
        'https://oc.test/chat',
      ),
      null,
    )
    assert.equal(
      helpers.getBuiltinBrowserUrlForClick(
        LEFT_CLICK,
        fakeAnchor({ href: 'javascript:alert(1)' }),
        'https://oc.test/',
      ),
      null,
    )
  })
})

describe('builtin browser prompt builder', () => {
  it('truncates long text snippets', () => {
    const out = helpers.truncateText('a'.repeat(600), 500)
    assert.equal(out.length, 500)
    assert.match(out, /…$/)
  })

  it('builds DOM-selection context prompt', () => {
    const prompt = helpers.buildBrowserSelectionPrompt(
      {
        mode: 'dom',
        url: 'https://oc.test/preview',
        title: 'Preview',
        selector: 'button#save.primary',
        tag: 'button',
        attributes: { id: 'save', class: 'primary' },
        rect: { x: 10, y: 20, width: 120, height: 32 },
        ancestry: ['main', 'form', 'button#save'],
        text: '保存',
        outerHTML: '<button id="save" class="primary">保存</button>',
      },
      '按钮更醒目',
    )
    assert.match(prompt, /CSS selector: `button#save\.primary`/)
    assert.match(prompt, /按钮更醒目/)
    assert.match(prompt, /```html/)
    assert.match(prompt, /outerHTML 摘要/)
  })

  it('builds coordinate fallback prompt', () => {
    const prompt = helpers.buildBrowserSelectionPrompt(
      {
        mode: 'coordinate',
        url: 'https://external.example/app',
        urlNote: '当前 iframe URL 因跨域策略不可读取',
        click: { x: 100, y: 50, xPct: 25, yPct: 10 },
        viewport: { width: 400, height: 500 },
      },
      '改这里的卡片间距',
    )
    assert.match(prompt, /坐标 fallback/)
    assert.match(prompt, /URL 备注: 当前 iframe URL 因跨域策略不可读取/)
    assert.match(prompt, /x=100, y=50 \(25%, 10%\)/)
    assert.match(prompt, /iframe 视口: 400 × 500/)
  })
})

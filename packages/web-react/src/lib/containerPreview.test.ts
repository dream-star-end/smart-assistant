import { afterEach, describe, expect, test } from 'vitest'

import { buildContainerWebReviewPrompt, containerPreviewHrefFromTarget } from './containerPreview'

afterEach(() => {
  document.body.replaceChildren()
})

describe('container preview link interception', () => {
  test('canonicalizes explicit localhost and wildcard-host links', () => {
    document.body.innerHTML = '<a id="a" href="http://0.0.0.0:5173/app#demo"><span>预览</span></a>'
    const target = document.querySelector('span')
    expect(containerPreviewHrefFromTarget(target)).toBe('http://127.0.0.1:5173/app')
  })

  test('leaves public, relative, download and platform-control links untouched', () => {
    for (const href of ['https://example.com', '/settings', 'http://localhost:18789/']) {
      document.body.innerHTML = `<a href="${href}">link</a>`
      expect(containerPreviewHrefFromTarget(document.querySelector('a'))).toBeNull()
    }
    document.body.innerHTML = '<a download href="http://localhost:3000/">download</a>'
    expect(containerPreviewHrefFromTarget(document.querySelector('a'))).toBeNull()
  })
})

test('review prompt contains only actionable structured element metadata', () => {
  const prompt = buildContainerWebReviewPrompt({
    sourceUrl: 'http://localhost:3000/',
    currentUrl: 'http://localhost:3000/settings',
    title: 'Settings\nPage',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
    annotations: [
      {
        id: 'a1',
        pageUrl: 'http://localhost:3000/settings',
        pageTitle: 'Settings Page',
        comment: '按钮改成品牌蓝色，并占满一行',
        target: {
          selector: '#save',
          tag: 'button',
          role: 'button',
          text: '保存',
          bounds: { x: 12, y: 100, width: 366, height: 44 },
        },
      },
    ],
  })

  expect(prompt).toContain('移动端 390 × 844 CSS px（DPR 2）')
  expect(prompt).toContain('CSS 选择器："#save"')
  expect(prompt).toContain('按钮改成品牌蓝色')
  expect(prompt).toContain('不要只描述方案')
  expect(prompt).not.toContain('session')
})

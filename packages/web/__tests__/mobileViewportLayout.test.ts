import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public')
const INDEX = readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf-8')
const STYLE = readFileSync(resolve(PUBLIC_DIR, 'style.css'), 'utf-8')
const MAIN = readFileSync(resolve(PUBLIC_DIR, 'modules', 'main.js'), 'utf-8')

describe('mobile visual viewport layout guard', () => {
  it('asks Android Chrome to resize content instead of overlaying the keyboard', () => {
    assert.match(
      INDEX,
      /<meta\s+name=["']viewport["'][^>]*interactive-widget=resizes-content/,
      'viewport meta should include interactive-widget=resizes-content',
    )
  })

  it('keeps old-Android height fallbacks and a visualViewport CSS override for the app shell', () => {
    assert.match(
      STYLE,
      /--oc-visual-viewport-height:\s*100vh/,
      'root should define a 100vh fallback for browsers without 100dvh',
    )
    assert.match(
      STYLE,
      /@supports\s*\(\s*height:\s*100dvh\s*\)[\s\S]*--oc-visual-viewport-height:\s*100dvh/,
      'modern browsers should default the viewport variable to 100dvh',
    )
    assert.match(
      STYLE,
      /\.app\s*\{[\s\S]*height:\s*100vh;[\s\S]*height:\s*100dvh;[\s\S]*height:\s*var\(--oc-visual-viewport-height,\s*100dvh\)/,
      '.app should keep 100vh/100dvh fallbacks before the JS-updated CSS variable',
    )
  })

  it('syncs visualViewport height into CSS and uses it for composer autosize', () => {
    assert.match(MAIN, /window\.visualViewport\?\.addEventListener\('resize'/)
    assert.match(MAIN, /window\.visualViewport\?\.addEventListener\('scroll'/)
    assert.match(
      MAIN,
      /setProperty\('--oc-visual-viewport-height',\s*`\$\{Math\.round\(height\)\}px`\)/,
      'main.js should write visualViewport height into the CSS variable',
    )
    assert.match(
      MAIN,
      /const viewportHeight = _getVisibleViewportHeight\(\) \|\| window\.innerHeight[\s\S]*Math\.min\(viewportHeight \* 0\.35, el\.scrollHeight\)/,
      'autoResize should use visible viewport height, not raw window.innerHeight only',
    )
  })
})

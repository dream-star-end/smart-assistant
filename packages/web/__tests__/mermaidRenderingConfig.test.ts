import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public')
const MARKDOWN = readFileSync(resolve(PUBLIC_DIR, 'modules', 'markdown.js'), 'utf-8')
const THEME = readFileSync(resolve(PUBLIC_DIR, 'modules', 'theme.js'), 'utf-8')
const STYLE = readFileSync(resolve(PUBLIC_DIR, 'style.css'), 'utf-8')

describe('Mermaid rendering config', () => {
  it('renders flowchart labels as SVG text so the SVG sanitizer keeps them', () => {
    assert.match(THEME, /export function mermaidConfigForTheme/)
    assert.match(THEME, /htmlLabels:\s*false/)
    assert.match(THEME, /flowchart:\s*\{\s*htmlLabels:\s*false\s*\}/)
  })

  it('uses the shared config for initial render and theme changes', () => {
    assert.match(
      MARKDOWN,
      /import\s*\{[^}]*mermaidConfigForTheme[^}]*\}\s*from\s*'\.\/theme\.js\?v=/,
    )
    assert.match(MARKDOWN, /mermaid\.initialize\(mermaidConfigForTheme\(effectiveTheme\(\)\)\)/)
    assert.match(THEME, /mermaid\.initialize\(mermaidConfigForTheme\(theme\)\)/)
  })

  it('keeps Mermaid labels readable across app themes', () => {
    assert.match(STYLE, /\.mermaid-block svg text,\n\.mermaid-block svg tspan/)
    assert.match(STYLE, /fill:\s*var\(--text-primary\) !important/)
    assert.match(STYLE, /\.mermaid-block \.nodeLabel,\n\.mermaid-block \.edgeLabel,/)
    assert.match(STYLE, /color:\s*var\(--text-primary\) !important/)
  })
})

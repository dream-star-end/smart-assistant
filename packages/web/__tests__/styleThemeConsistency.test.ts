import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static style.css consistency test (波次 3).
 *
 * Locks in:
 * 1. No `@media (prefers-color-scheme: ...)` overrides — app uses
 *    `[data-theme=...]` which honors user preference even when it
 *    diverges from OS setting. Mixing the two creates split-personality
 *    components.
 * 2. The `--danger-*` semantic surface token family is defined in BOTH
 *    `[data-theme="dark"]` and `[data-theme="light"]` blocks.
 * 3. `.msg-body.msg-error` consumes the tokens (not raw hex literals).
 */

const STYLE = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'style.css'),
  'utf-8',
)

describe('style.css theme consistency (波次 3)', () => {
  it('no prefers-color-scheme media queries — data-theme is the single source of truth', () => {
    const matches = STYLE.match(/@media\s*\([^)]*prefers-color-scheme/g) ?? []
    assert.equal(
      matches.length,
      0,
      `Found ${matches.length} prefers-color-scheme @media blocks; should be 0 — ` +
        `theme is driven by [data-theme=...] which already resolves "system" → light/dark.`,
    )
  })

  it('--danger surface tokens are defined in dark theme block', () => {
    // Match the entire [data-theme="dark"] { ... } block, then assert all 4
    // danger surface tokens appear inside it.
    const darkBlock = STYLE.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)^\}/m)
    assert.ok(darkBlock, 'expected [data-theme="dark"] { ... } block')
    const body = darkBlock[1]
    for (const tok of ['--danger-soft', '--danger-border', '--danger-fg-strong', '--danger-bg-strong']) {
      assert.match(body, new RegExp(`${tok}\\s*:`), `dark theme missing ${tok}`)
    }
  })

  it('--danger surface tokens are defined in light theme block', () => {
    const lightBlock = STYLE.match(/\[data-theme="light"\]\s*\{([\s\S]*?)^\}/m)
    assert.ok(lightBlock, 'expected [data-theme="light"] { ... } block')
    const body = lightBlock[1]
    for (const tok of ['--danger-soft', '--danger-border', '--danger-fg-strong', '--danger-bg-strong']) {
      assert.match(body, new RegExp(`${tok}\\s*:`), `light theme missing ${tok}`)
    }
  })

  it('.msg-body.msg-error consumes --danger tokens, not raw red hex literals', () => {
    // Find the .msg-body.msg-error rule + its sibling .msg-error-* rules
    // (the entire 错误卡 region). Anchor from comment to next major selector.
    const startIdx = STYLE.indexOf('.msg-body.msg-error')
    assert.ok(startIdx >= 0, 'expected .msg-body.msg-error selector')
    // Region ends at next non-msg-error rule (msg.assistant .avatar follows in source).
    const endIdx = STYLE.indexOf('.msg.assistant .avatar', startIdx)
    assert.ok(endIdx > startIdx, 'expected .msg.assistant .avatar to follow msg-error block')
    const region = STYLE.slice(startIdx, endIdx)

    // Positive: token references must appear
    for (const tok of ['var(--danger-border)', 'var(--danger-soft)', 'var(--danger-fg-strong)', 'var(--danger-bg-strong)']) {
      assert.match(region, new RegExp(tok.replace(/[()]/g, '\\$&')), `msg-error region missing ${tok}`)
    }

    // Negative: hardcoded red hex literals must NOT appear in the region
    // (#fef2f2 light bg, #991b1b light fg, #fca5a5 border, #b91c1c hover/summary,
    //  rgba(127, 29, 29, ...) old detail-pre bg, rgba(252, 165, 165, ...) old dark border).
    // Allow #dc2626 inside var(--danger-bg-strong) but not bare.
    const bannedLiterals = ['#fef2f2', '#991b1b', '#fca5a5', '#b91c1c', 'rgba(127, 29, 29', 'rgba(252, 165, 165']
    for (const lit of bannedLiterals) {
      assert.ok(
        !region.includes(lit),
        `msg-error region still has hardcoded ${lit} — should be a --danger token`,
      )
    }
  })
})

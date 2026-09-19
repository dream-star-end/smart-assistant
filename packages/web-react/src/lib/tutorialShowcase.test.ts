import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TUTORIAL_CASE_BY_ID } from './tutorialCaseCatalog'
import { TUTORIAL_SHOWCASES, showcaseAsset, showcaseById, showcaseTask } from './tutorialShowcase'

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../public')

describe('public-data showcase evidence', () => {
  it('only projects existing case IDs and never upgrades pending replay', () => {
    expect(TUTORIAL_SHOWCASES).toHaveLength(2)
    expect(new Set(TUTORIAL_SHOWCASES.map((s) => s.caseId)).size).toBe(2)
    for (const item of TUTORIAL_SHOWCASES) {
      expect(TUTORIAL_CASE_BY_ID[item.caseId].replay.status).toBe('pending_capture')
      expect(item.evidence.caseId).toBe(item.caseId)
      expect(item.evidence.schemaVersion).toBe(1)
      expect(item.evidence.metrics.length).toBeGreaterThan(0)
      expect(item.evidence.highlights.length).toBeGreaterThan(0)
      expect(item.evidence.limitations.length).toBeGreaterThan(0)
      expect(item.evidence.checks.length).toBeGreaterThan(0)
      expect(item.evidence.checks.every((c) => c.passed)).toBe(true)
      expect(Number.isFinite(Date.parse(item.evidence.generatedAt))).toBe(true)
    }
    expect(showcaseById('coding-swe-bench-fix')).toBeUndefined()
    expect(showcaseById(null)).toBeUndefined()
  })
  it('verifies committed input/output bytes and SHA-256, not just a success badge', () => {
    for (const item of TUTORIAL_SHOWCASES) {
      for (const filename of ['dashboard.html', 'report.md', 'metrics.json', 'derived.csv']) {
        expect(item.evidence.outputs.some((o) => o.path === showcaseAsset(item, filename))).toBe(true)
      }
      for (const file of [...item.evidence.inputs, ...item.evidence.outputs]) {
        expect(file.path.startsWith('/tutorials/cases/' + item.caseId + '/')).toBe(true)
        expect(file.path).not.toContain('..')
        const data = readFileSync(new URL('../../public' + file.path, import.meta.url))
        expect(data.byteLength, file.path).toBe(file.bytes)
        expect(createHash('sha256').update(data).digest('hex'), file.path).toBe(file.sha256)
      }
    }
  })
  it('ties real browser cover images to the exact HTML artifact they depict', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'tutorials/showcase-covers/manifest.json'), 'utf8'))
    expect(manifest.covers).toHaveLength(TUTORIAL_SHOWCASES.length)
    for (const entry of manifest.covers) {
      expect(showcaseById(entry.caseId)).toBeDefined()
      for (const [path, hash] of [[entry.path, entry.sha256], [entry.sourcePath, entry.sourceSha256]]) {
        expect(path).not.toContain('..')
        const bytes = readFileSync(resolve(publicRoot, '.' + path))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
      }
    }
  })
  it('adapts the request without mutating catalog or pretending files were attached', () => {
    for (const item of TUTORIAL_SHOWCASES) {
      const original = TUTORIAL_CASE_BY_ID[item.caseId].starterPrompt
      const task = showcaseTask(item)
      expect(task.id).toBe(item.caseId)
      expect(task.starterPrompt).toBe(item.prompt)
      expect(task.starterPrompt).toContain('先')
      expect(task.starterPrompt).not.toBe(original)
      expect(TUTORIAL_CASE_BY_ID[item.caseId].starterPrompt).toBe(original)
    }
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  extractCapturedArtifact,
  parseArgs,
  parseArtifactSpec,
} from '../v5-document-artifact-pair.mjs'

function capture(path = 'deliverables/report.pdf', content = Buffer.from('%PDF-1.7\n')) {
  const digest = createHash('sha256').update(content).digest('hex')
  return {
    entries: [
      {
        path,
        type: 'file',
        mode: 0o644,
        bytes: content.length,
        sha256: digest,
        contentBase64: content.toString('base64'),
      },
    ],
  }
}

describe('V5 document artifact pair evidence', () => {
  test('locks the case, artifact path, kind and QA expectations', () => {
    const spec = parseArtifactSpec({
      schemaVersion: 1,
      caseId: 'pdf-formal-notice',
      kind: 'pdf',
      artifactPath: 'deliverables/report.pdf',
      expect: { requiredText: ['工作会议'], pageCount: 1 },
    })
    assert.equal(spec.expect.kind, 'pdf')
    assert.equal(spec.artifactPath, 'deliverables/report.pdf')
    assert.throws(
      () =>
        parseArtifactSpec({
          schemaVersion: 1,
          caseId: 'bad',
          kind: 'pdf',
          artifactPath: '../escape.pdf',
        }),
      /artifactPath is invalid/,
    )
    assert.throws(
      () =>
        parseArtifactSpec({
          schemaVersion: 1,
          caseId: 'bad',
          kind: 'pdf',
          artifactPath: 'report.xlsx',
        }),
      /differs from kind/,
    )
  })

  test('reconstructs exact captured bytes and rejects corruption or ambiguity', () => {
    const spec = parseArtifactSpec({
      schemaVersion: 1,
      caseId: 'pdf-formal-notice',
      kind: 'pdf',
      artifactPath: 'deliverables/report.pdf',
    })
    const document = capture()
    const artifact = extractCapturedArtifact(document, spec)
    assert.equal(artifact.bytes.toString(), '%PDF-1.7\n')
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)

    const corrupted = structuredClone(document)
    corrupted.entries[0].contentBase64 = Buffer.from('other').toString('base64')
    assert.throws(() => extractCapturedArtifact(corrupted, spec), /bytes differ/)

    const duplicated = { entries: [document.entries[0], structuredClone(document.entries[0])] }
    assert.throws(() => extractCapturedArtifact(duplicated, spec), /exactly one/)
  })

  test('requires separate absolute pair, evidence, render and output paths', () => {
    const parsed = parseArgs([
      '--arm-a',
      '/secure/a.json',
      '--arm-b',
      '/secure/b.json',
      '--spec',
      '/secure/spec.json',
      '--artifact-dir',
      '/secure/renders',
      '--output',
      '/secure/result.json',
      '--apply',
    ])
    assert.equal(parsed.apply, true)
    assert.equal(parsed.artifactDir, '/secure/renders')
    assert.throws(
      () =>
        parseArgs([
          '--arm-a',
          '/secure/a.json',
          '--arm-b',
          '/secure/a.json',
          '--spec',
          '/secure/spec.json',
          '--artifact-dir',
          '/secure/renders',
          '--output',
          '/secure/result.json',
        ]),
      /must differ/,
    )
  })
})

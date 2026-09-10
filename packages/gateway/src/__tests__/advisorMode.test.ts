import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { symlinkSync } from 'node:fs'

import {
  buildAdvisorSnapshot,
  collectAuthorizedArtifacts,
  extractGeneratedPaths,
  formatAdvisorConsultPrompt,
  matchConsultIdentity,
} from '../advisorMode.js'

describe('advisorMode snapshot', () => {
  it('marks missing history/tools/artifacts instead of pretending complete', () => {
    const snap = buildAdvisorSnapshot({
      question: 'why red?',
      concern: 'assert',
      advisorModel: 'gpt-6-astra',
      source: { userTask: 'fix the test' },
    })
    assert.deepEqual(snap.missing, [
      'injected_constraints',
      'history_tape',
      'current_turn_tools',
      'authorized_artifacts',
    ])
    assert.match(formatAdvisorConsultPrompt(snap), /缺失证据/)
    assert.match(formatAdvisorConsultPrompt(snap), /why red/)
  })

  it('matchConsultIdentity requires both question and concern', () => {
    assert.equal(
      matchConsultIdentity({ question: 'a', concern: 'b' }, { question: 'a', concern: 'b' }),
      true,
    )
    assert.equal(
      matchConsultIdentity({ question: 'a', concern: 'b' }, { question: 'a', concern: 'c' }),
      false,
    )
  })

  it('collectAuthorizedArtifacts reads generated files and rejects symlink escape', async () => {
    const root = join(tmpdir(), `oc-adv-art-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const file = join(root, 'note.txt')
    await writeFile(file, 'hello advisor')
    const outside = join(tmpdir(), `oc-adv-secret-${Date.now()}.txt`)
    await writeFile(outside, 'secret')
    const link = join(root, 'escape.txt')
    symlinkSync(outside, link)
    const rows = collectAuthorizedArtifacts({
      generatedRoot: root,
      mentioned: [file, link, outside],
    })
    assert.equal(rows.find((r) => r.path === file || r.path.endsWith('note.txt'))?.content, 'hello advisor')
    assert.equal(rows.find((r) => r.path === link)?.missing, 'symlink_rejected')
    assert.equal(rows.find((r) => r.path === outside)?.missing, 'escape_rejected')
  })

  it('extractGeneratedPaths only keeps volume generated names', () => {
    const paths = extractGeneratedPaths([
      'see /home/agent/.openclaude/generated/ocv5-210-report.md and /etc/passwd',
    ])
    assert.deepEqual(paths, ['/home/agent/.openclaude/generated/ocv5-210-report.md'])
  })
})

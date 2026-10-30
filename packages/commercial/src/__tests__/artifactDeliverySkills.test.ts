import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const sandbox = new URL('../../agent-sandbox/', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, sandbox), 'utf8')
const deliverySkills = [
  'ccb-baseline/skills/document-writing/SKILL.md',
  'ccb-baseline/skills/office-suite/SKILL.md',
  'ccb-baseline/skills/office-pdf/SKILL.md',
  'ccb-baseline/skills/office-spreadsheet/SKILL.md',
  'platform-runtime/codex-skills/document-writing/SKILL.md',
]

for (const path of deliverySkills) {
  test(`${path}: every main deliverable has its own generated path`, () => {
    const skill = read(path)
    assert.doesNotMatch(skill, /只打印 zip 路径|print the zip path only|当前镜像未装/)
    assert.match(skill, /\/home\/agent\/\.openclaude\/generated\//)
    assert.doesNotMatch(skill, /\/home\/agent\/\.openclaude\/(?!generated\/)/)
    assert.match(skill, /逐个.*各?主要.*(完整|绝对路径)|逐个.*每个主要.*完整|full FINAL absolute path of every main deliverable/)
  })
}

for (const path of [deliverySkills[0]!, deliverySkills[1]!, deliverySkills[4]!]) {
  test(`${path}: a bundle supplements individual Word and PDF files`, () => {
    const skill = read(path)
    assert.match(skill, /≥5/)
    assert.match(skill, /用户明确要求压缩包|explicit user request for an archive/)
    assert.match(skill, /额外附带|additionally include/)
    assert.match(skill, /不能替代|must not replace/)
    assert.ok(skill.includes('`.docx`') && skill.includes('`.pdf`'))
  })
}

test('PDF scans use the installed OCR and ingest tools automatically', () => {
  const skill = read('ccb-baseline/skills/office-pdf/SKILL.md')
  assert.match(skill, /`oc-ocr`.*自动识别/)
  assert.match(skill, /`oc-ingest`/)
  assert.ok(skill.includes('skill_view("oc-ingest")'))
  assert.doesNotMatch(skill, /属 P1 增强|需要 OCR/)
})

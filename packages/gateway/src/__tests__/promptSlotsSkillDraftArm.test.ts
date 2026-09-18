/**
 * promptSlots 记忆侧阶段 B 用例:
 *  - skills 审计 S-08:skill-eval draft arm 的草稿描述用 parseFrontmatter 读(与 skillStore 同源),
 *    不再裸正则 + 只剥双引号;
 *  - MSC MEM-01:userProfileAlwaysCharCount 只算会被注入的 oc-user-always 块。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/promptSlotsSkillDraftArm.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-skill-draft-arm-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
Reflect.deleteProperty(process.env, 'OPENCLAUDE_PLATFORM_PROMPTS_DIR')

const { buildSkillsSlot, userProfileAlwaysCharCount, USER_PROFILE_INJECT_MAX_CHARS } = await import(
  '../promptSlots.js'
)

const AGENT = 'draft-arm-agent'

function seedSkill(name: string, desc: string): void {
  const dir = join(TEST_HOME, 'agents', AGENT, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`)
}

function writeDraft(skillMd: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-skill-draft-'))
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  return dir
}

function summaryLine(content: string, name: string): string {
  const line = content.split('\n').find((l) => l.startsWith(`- **${name}**`))
  assert.ok(line, `SKILLS 摘要里应有 ${name}:\n${content}`)
  return line
}

describe('S-08 skill-eval draft arm 描述解析', () => {
  it('JSON 引号 + 冒号 + CRLF 的草稿描述按 frontmatter 解析(与 skillStore 同源)', async () => {
    seedSkill('deploy-flow', '现版描述')
    const dir = writeDraft(
      '---\r\nname: deploy-flow\r\ndescription: "部署前: 先跑冒烟, 再发布"\r\n---\r\n# body\r\ndescription: 正文里的假描述\r\n',
    )
    const slot = await buildSkillsSlot({
      agentId: AGENT,
      skillEvalDraft: { name: 'deploy-flow', dir },
    })
    assert.ok(slot)
    const line = summaryLine(slot.content, 'deploy-flow')
    assert.match(
      line,
      /部署前: 先跑冒烟, 再发布$/,
      `应用草稿描述且不带引号/CR:${JSON.stringify(line)}`,
    )
    assert.doesNotMatch(line, /"/)
    assert.doesNotMatch(line, /\r/)
    assert.doesNotMatch(line, /现版描述/)
  })

  it('草稿 frontmatter 没有 description 时,正文里的 description: 行不会被误读,保持现版描述', async () => {
    seedSkill('review-flow', '现版描述保持')
    const dir = writeDraft(
      '---\nname: review-flow\n---\n# body\n\ndescription: 这是正文,不是 frontmatter\n',
    )
    const slot = await buildSkillsSlot({
      agentId: AGENT,
      skillEvalDraft: { name: 'review-flow', dir },
    })
    assert.ok(slot)
    const line = summaryLine(slot.content, 'review-flow')
    assert.match(line, /现版描述保持$/)
    assert.doesNotMatch(line, /这是正文/)
  })

  it('单引号草稿描述同样剥引号;草稿读不到 → 保持现版描述', async () => {
    seedSkill('quote-flow', '现版')
    const dir = writeDraft("---\nname: quote-flow\ndescription: '单引号描述'\n---\n")
    const slot = await buildSkillsSlot({
      agentId: AGENT,
      skillEvalDraft: { name: 'quote-flow', dir },
    })
    assert.ok(slot)
    assert.match(summaryLine(slot.content, 'quote-flow'), /单引号描述$/)

    const missing = await buildSkillsSlot({
      agentId: AGENT,
      skillEvalDraft: { name: 'quote-flow', dir: join(TEST_HOME, 'no-such-draft') },
    })
    assert.ok(missing)
    assert.match(summaryLine(missing.content, 'quote-flow'), /现版$/)
  })

  it('draft arm 只替换目标技能,其它技能描述不变', async () => {
    seedSkill('other-flow', '别的技能')
    const dir = writeDraft('---\nname: deploy-flow\ndescription: 新草稿\n---\n')
    const slot = await buildSkillsSlot({
      agentId: AGENT,
      skillEvalDraft: { name: 'deploy-flow', dir },
    })
    assert.ok(slot)
    assert.match(summaryLine(slot.content, 'other-flow'), /别的技能$/)
    assert.match(summaryLine(slot.content, 'deploy-flow'), /新草稿$/)
  })
})

describe('MEM-01 userProfileAlwaysCharCount', () => {
  it('只数单个合法 always 块(trim 后),全文其余部分不计', () => {
    const block = '简洁回答,中文优先'
    const text = `外面一大段${'x'.repeat(6000)}\n<!-- oc-user-always:start -->\n  ${block}  \n<!-- oc-user-always:end -->\n尾巴`
    assert.equal(userProfileAlwaysCharCount(text), block.length)
    assert.ok(text.length > USER_PROFILE_INJECT_MAX_CHARS, '全文超 limit 但 always 块远小于 limit')
  })

  it('无块 / 标记不合法 / 空块 / 非字符串 → 0', () => {
    assert.equal(userProfileAlwaysCharCount('legacy identity'), 0)
    assert.equal(userProfileAlwaysCharCount('<!-- oc-user-always:start -->x'), 0)
    assert.equal(
      userProfileAlwaysCharCount(
        '<!-- oc-user-always:start -->a<!-- oc-user-always:start -->b<!-- oc-user-always:end -->',
      ),
      0,
    )
    assert.equal(
      userProfileAlwaysCharCount('<!-- oc-user-always:start -->   <!-- oc-user-always:end -->'),
      0,
    )
    assert.equal(userProfileAlwaysCharCount(undefined as unknown as string), 0)
  })
})

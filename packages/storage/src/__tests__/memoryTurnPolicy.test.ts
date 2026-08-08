import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'memory-turn-policy-'))
const {
  MEMORY_TURN_POLICY_TTL_MS,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  writeMemoryTurnPolicy,
  readMemoryTurnPolicy,
  clearMemoryTurnPolicy,
} = await import('../memoryTurnPolicy.js')

test('普通任务只开放按需 Core，明确忽略拒绝，明确连续任务开放全部检索', () => {
  assert.deepEqual(
    classifyMemoryTurnPolicy('请评阅一下该采购方案文件，看看有什么问题？', 'webchat'),
    { allowed: true, reason: 'on_demand_core' },
  )
  assert.deepEqual(
    classifyMemoryTurnPolicy('我有过敏性鼻炎，咳嗽变异性哮喘，长期接触手机壳的部位出现疹子', 'webchat'),
    { allowed: true, reason: 'on_demand_core' },
  )
  assert.deepEqual(
    classifyMemoryTurnPolicy('把我的各种琐碎的记忆都删掉，或者新开会话不要加载记忆，我不需要新开会话有倾向性', 'webchat'),
    { allowed: false, reason: 'explicit_ignore' },
  )
  assert.deepEqual(
    classifyMemoryTurnPolicy('请检索一下如图的会话，是否可以在该会话基础上继续问答。', 'webchat'),
    { allowed: true, reason: 'explicit_continuity' },
  )
  for (const text of [
    '请根据我的偏好推荐一台电脑',
    '按我的习惯安排今天的任务',
    '请用已保存的资料回答',
    'Based on what you know about me, recommend a laptop.',
  ]) {
    assert.deepEqual(classifyMemoryTurnPolicy(text, 'webchat'), {
      allowed: true,
      reason: 'explicit_continuity',
    })
  }
  for (const text of [
    'What does continue do in JavaScript?',
    '请解释继续教育政策',
  ]) {
    assert.deepEqual(classifyMemoryTurnPolicy(text, 'webchat'), {
      allowed: true,
      reason: 'on_demand_core',
    })
  }
  assert.deepEqual(classifyMemoryTurnPolicy('nightly memory maintenance', 'cron'), {
    allowed: true,
    reason: 'trusted_cron',
  })
})

test('policy 原子读写、过期和清理', async () => {
  await writeMemoryTurnPolicy('s1', { allowed: true, reason: 'explicit_continuity' }, 1000)
  assert.deepEqual(await readMemoryTurnPolicy('s1', 1001), {
    allowed: true,
    reason: 'explicit_continuity',
  })
  assert.equal(await readMemoryTurnPolicy('s1', 1000 + MEMORY_TURN_POLICY_TTL_MS), null)
  await clearMemoryTurnPolicy('s1')
  assert.equal(await readMemoryTurnPolicy('s1', 1001), null)
})

test('delegate 只能继承父 policy，不能按子任务文字升级', () => {
  assert.deepEqual(inheritMemoryTurnPolicy({ allowed: false, reason: 'clean_default' }), {
    allowed: false,
    reason: 'inherited_parent_deny',
  })
  assert.deepEqual(inheritMemoryTurnPolicy({ allowed: true, reason: 'explicit_continuity' }), {
    allowed: true,
    reason: 'inherited_parent_allow',
  })
  assert.deepEqual(inheritMemoryTurnPolicy({ allowed: true, reason: 'on_demand_core' }), {
    allowed: true,
    reason: 'inherited_parent_core',
  })
  assert.deepEqual(inheritMemoryTurnPolicy({ allowed: true, reason: 'inherited_parent_core' }), {
    allowed: true,
    reason: 'inherited_parent_core',
  })
  assert.deepEqual(inheritMemoryTurnPolicy(null), {
    allowed: false,
    reason: 'inherited_parent_deny',
  })
})

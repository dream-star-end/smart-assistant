import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.OPENCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'memory-turn-policy-'))
const {
  MEMORY_TURN_POLICY_TTL_MS,
  DEFAULT_MEMORY_SEARCH_POLICY,
  MANAGED_AGENT_OPENCLAUDE_HOME,
  classifyMemoryTurnPolicy,
  inheritMemoryTurnPolicy,
  resolveMemoryTurnPolicyRoot,
  writeMemoryTurnPolicy,
  readMemoryTurnPolicy,
  clearMemoryTurnPolicy,
} = await import('../memoryTurnPolicy.js')

test('普通任务默认开放 Core+session，明确忽略拒绝，明确连续任务开放全部检索', () => {
  assert.deepEqual(
    classifyMemoryTurnPolicy('请评阅一下该采购方案文件，看看有什么问题？', 'webchat'),
    { allowed: true, reason: 'on_demand_session' },
  )
  assert.deepEqual(
    classifyMemoryTurnPolicy('我有过敏性鼻炎，咳嗽变异性哮喘，长期接触手机壳的部位出现疹子', 'webchat'),
    { allowed: true, reason: 'on_demand_session' },
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
    'resume parsing the file',
    '延续性研究综述怎么写',
  ]) {
    assert.deepEqual(classifyMemoryTurnPolicy(text, 'webchat'), {
      allowed: true,
      reason: 'on_demand_session',
    })
  }
  assert.deepEqual(classifyMemoryTurnPolicy('nightly memory maintenance', 'cron'), {
    allowed: true,
    reason: 'trusted_cron',
  })
})

test('真实连续性口令「之前那个…继续推进」判为 continuity；忽略历史优先于 continuity', () => {
  assert.deepEqual(
    classifyMemoryTurnPolicy(
      '之前那个参照 dashi-taskboard 开发任务面板的会话，继续推进',
      'webchat',
    ),
    { allowed: true, reason: 'explicit_continuity' },
  )
  for (const text of [
    '接着上次把面板做完',
    '上次那个方案呢',
    '刚才那个还没做完',
    '请延续上次的讨论',
    'follow up on the taskboard session',
    'please resume from the last session',
    'resume the previous conversation',
  ]) {
    assert.deepEqual(classifyMemoryTurnPolicy(text, 'webchat'), {
      allowed: true,
      reason: 'explicit_continuity',
    }, text)
  }
  assert.deepEqual(
    classifyMemoryTurnPolicy('忽略历史，之前那个会话继续推进', 'webchat'),
    { allowed: false, reason: 'explicit_ignore' },
  )
  assert.deepEqual(
    classifyMemoryTurnPolicy('从头开始，接着上次那个方案', 'webchat'),
    { allowed: false, reason: 'explicit_ignore' },
  )
})

test('policy 原子读写；过期 allow 降级为默认检索，过期 deny 保持 fail-closed', async () => {
  await writeMemoryTurnPolicy('s1', { allowed: true, reason: 'explicit_continuity' }, 1000)
  assert.deepEqual(await readMemoryTurnPolicy('s1', 1001), {
    allowed: true,
    reason: 'explicit_continuity',
  })
  assert.deepEqual(
    await readMemoryTurnPolicy('s1', 1000 + MEMORY_TURN_POLICY_TTL_MS),
    DEFAULT_MEMORY_SEARCH_POLICY,
  )
  await writeMemoryTurnPolicy('s-deny', { allowed: false, reason: 'explicit_ignore' }, 1000)
  assert.deepEqual(await readMemoryTurnPolicy('s-deny', 1000 + MEMORY_TURN_POLICY_TTL_MS), {
    allowed: false,
    reason: 'explicit_ignore',
  })
  await writeMemoryTurnPolicy('s-clean', { allowed: false, reason: 'clean_default' }, 1000)
  assert.deepEqual(await readMemoryTurnPolicy('s-clean', 1000 + MEMORY_TURN_POLICY_TTL_MS), {
    allowed: false,
    reason: 'clean_default',
  })
  await clearMemoryTurnPolicy('s1')
  assert.deepEqual(await readMemoryTurnPolicy('s1', 1001), DEFAULT_MEMORY_SEARCH_POLICY)

  const brokenKey = 's-broken-deny'
  const brokenDir = join(process.env.OPENCLAUDE_HOME!, '.memory-turn-policy')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(
    join(brokenDir, `${createHash('sha256').update(brokenKey).digest('hex')}.json`),
    JSON.stringify({
      schemaVersion: 1,
      allowed: false,
      reason: 'explicit_ignore',
      expiresAt: 'not-a-number',
    }),
  )
  assert.deepEqual(await readMemoryTurnPolicy(brokenKey, 1), {
    allowed: false,
    reason: 'explicit_ignore',
  })
})

test('policy 文件缺失时退回默认检索策略，而不是 null', async () => {
  assert.deepEqual(await readMemoryTurnPolicy('never-written', 1), DEFAULT_MEMORY_SEARCH_POLICY)
  assert.equal(DEFAULT_MEMORY_SEARCH_POLICY.reason, 'on_demand_session')
  assert.equal(DEFAULT_MEMORY_SEARCH_POLICY.allowed, true)
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
  assert.deepEqual(inheritMemoryTurnPolicy({ allowed: true, reason: 'on_demand_session' }), {
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

test('policy root 优先显式变量，Cursor 临时 HOME 才回退到持久 volume', () => {
  assert.equal(
    resolveMemoryTurnPolicyRoot(
      { OC_MEMORY_POLICY_HOME: '/pin', OPENCLAUDE_HOME: '/other', HOME: '/tmp/openclaude-cursor.abc' },
      '/loaded',
    ),
    '/pin',
  )
  assert.equal(
    resolveMemoryTurnPolicyRoot(
      { OPENCLAUDE_HOME: '/oc', HOME: '/tmp/openclaude-cursor.abc' },
      '/loaded',
    ),
    '/oc',
  )
  assert.equal(
    resolveMemoryTurnPolicyRoot(
      { HOME: '/tmp/openclaude-cursor.abc' },
      '/tmp/openclaude-cursor.abc/.openclaude',
      (path) => path === MANAGED_AGENT_OPENCLAUDE_HOME,
    ),
    MANAGED_AGENT_OPENCLAUDE_HOME,
  )
  assert.equal(
    resolveMemoryTurnPolicyRoot(
      { HOME: '/home/agent' },
      '/home/agent/.openclaude',
      () => true,
    ),
    '/home/agent/.openclaude',
  )
  assert.equal(
    resolveMemoryTurnPolicyRoot(
      { HOME: '/tmp/openclaude-cursor.abc' },
      '/loaded-from-paths',
      () => false,
    ),
    '/loaded-from-paths',
  )
})

test('OC_MEMORY_POLICY_HOME 让读写不依赖模块加载时的 paths.home', async () => {
  const alt = mkdtempSync(join(tmpdir(), 'memory-policy-alt-'))
  process.env.OC_MEMORY_POLICY_HOME = alt
  try {
    await writeMemoryTurnPolicy('alt-key', { allowed: true, reason: 'explicit_continuity' }, 1000)
    assert.equal(existsSync(join(alt, '.memory-turn-policy')), true)
    assert.deepEqual(await readMemoryTurnPolicy('alt-key', 1001), {
      allowed: true,
      reason: 'explicit_continuity',
    })
    await clearMemoryTurnPolicy('alt-key')
  } finally {
    delete process.env.OC_MEMORY_POLICY_HOME
  }
})

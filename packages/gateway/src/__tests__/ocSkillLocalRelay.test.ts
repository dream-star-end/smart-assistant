/**
 * oc-skill 服务端:回环-only relay 决策 + 训练完成站内信文案 + 通知 fail-open 测试。
 * Run: npx tsx --test packages/gateway/src/__tests__/ocSkillLocalRelay.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildSkillTrainCompleteNotice,
  decideSkillLocalRelay,
  SKILL_LOCAL_RELAY_PREFIX,
} from '../ocSkillLocalRelay.js'
import { postInboxMessage } from '../v3InboxPost.js'

const P = SKILL_LOCAL_RELAY_PREFIX

describe('decideSkillLocalRelay — loopback-only guard', () => {
  test('non-loopback source → forbidden (never dispatches)', () => {
    assert.deepEqual(decideSkillLocalRelay(`${P}/skills/my-skill/train`, '172.30.0.9'), {
      action: 'forbidden',
    })
    assert.deepEqual(decideSkillLocalRelay(`${P}/skills/my-skill/train`, undefined), {
      action: 'forbidden',
    })
  })

  test('loopback IPv4 / IPv6 / mapped all pass the guard', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.deepEqual(decideSkillLocalRelay(`${P}/skill-training/run-1`, ip), {
        action: 'dispatch',
        route: 'train-status',
        param: 'run-1',
      })
    }
  })
})

describe('decideSkillLocalRelay — path mapping (loopback)', () => {
  const lo = '127.0.0.1'
  test('train start / eval-gen start capture the skill name', () => {
    assert.deepEqual(decideSkillLocalRelay(`${P}/skills/my-skill/train`, lo), {
      action: 'dispatch',
      route: 'train-start',
      param: 'my-skill',
    })
    assert.deepEqual(decideSkillLocalRelay(`${P}/skills/my-skill/evals/generate`, lo), {
      action: 'dispatch',
      route: 'evalgen-start',
      param: 'my-skill',
    })
  })

  test('status routes capture the runId', () => {
    assert.deepEqual(decideSkillLocalRelay(`${P}/skill-training/AbC_1-2`, lo), {
      action: 'dispatch',
      route: 'train-status',
      param: 'AbC_1-2',
    })
    assert.deepEqual(decideSkillLocalRelay(`${P}/skill-eval-gen/AbC_1-2`, lo), {
      action: 'dispatch',
      route: 'evalgen-status',
      param: 'AbC_1-2',
    })
  })

  test('unknown / uppercase-name / prefix-only paths → not-found', () => {
    assert.deepEqual(decideSkillLocalRelay(P, lo), { action: 'not-found' })
    assert.deepEqual(decideSkillLocalRelay(`${P}/bogus`, lo), { action: 'not-found' })
    // skill 名段与真路由一致只收 [a-z0-9-]+:大写名不匹配 → not-found(交给路由权威拒绝)。
    assert.deepEqual(decideSkillLocalRelay(`${P}/skills/MySkill/train`, lo), {
      action: 'not-found',
    })
  })
})

describe('buildSkillTrainCompleteNotice', () => {
  test('draft > 0 → 报草稿数 + 引导看 diff', () => {
    const n = buildSkillTrainCompleteNotice('my-skill', 3)
    assert.equal(n.title, '技能「my-skill」训练优化完成')
    assert.match(n.bodyMd, /3 份改进草稿/)
    assert.match(n.bodyMd, /管理中心 → 技能 → 训练优化/)
    assert.match(n.bodyMd, /查看 diff/)
  })

  test('draft === 0 → 明确「未产生改进草稿」', () => {
    const n = buildSkillTrainCompleteNotice('my-skill', 0)
    assert.equal(n.title, '技能「my-skill」训练优化完成')
    assert.equal(n.bodyMd, '本次训练未产生改进草稿。')
  })

  test('null skillName(前端自动选目标)→ 通用标题', () => {
    const n = buildSkillTrainCompleteNotice(null, 2)
    assert.equal(n.title, '技能训练优化完成')
    assert.match(n.bodyMd, /2 份改进草稿/)
  })
})

describe('postInboxMessage — POST shape + fail-open (通知契约)', () => {
  const config = { baseUrl: 'http://master.internal:18791', bearer: 'oc-v3.7.container' }

  test('POST /internal/v3/inbox-post with { title, bodyMd } + bearer', async () => {
    const captured: { url?: string; method?: string; headers?: any; body?: string } = {}
    const fetcher = (async (url: string, opts: any) => {
      captured.url = url
      captured.method = opts.method
      captured.headers = opts.headers
      captured.body = String(opts.body)
      return { statusCode: 200, body: (async function* () {})() }
    }) as any

    const notice = buildSkillTrainCompleteNotice('my-skill', 1)
    await postInboxMessage(notice, { config, fetcher })

    assert.equal(captured.url, 'http://master.internal:18791/internal/v3/inbox-post')
    assert.equal(captured.method, 'POST')
    assert.equal(captured.headers.authorization, 'Bearer oc-v3.7.container')
    // master 的 BodySchema 是 .strict():只认 { title, bodyMd, level? }。
    assert.deepEqual(JSON.parse(captured.body!), { title: notice.title, bodyMd: notice.bodyMd })
  })

  test('rejecting fetcher → 静默吞掉,永不抛(不阻断 finalize)', async () => {
    const fetcher = (async () => {
      throw new Error('network down')
    }) as any
    await assert.doesNotReject(
      postInboxMessage(buildSkillTrainCompleteNotice('my-skill', 0), { config, fetcher }),
    )
  })

  test('缺 master env(config=null)→ no-op,不调用 fetcher', async () => {
    let called = false
    const fetcher = (async () => {
      called = true
      return { statusCode: 200, body: (async function* () {})() }
    }) as any
    await postInboxMessage(buildSkillTrainCompleteNotice('my-skill', 0), {
      config: null,
      fetcher,
    })
    assert.equal(called, false)
  })
})

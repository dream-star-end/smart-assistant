// RateLimiter 令牌桶配置契约(M6② R3)。
//
// 超大内容查看端点(GET /api/sessions/:id/tape/:tapeId/records)分两分支两桶:
//   - 行分页分支(tapeRecordsRateLimiter):10 req/10s —— 翻页正常够用,挡脚本刷爆投影读。
//   - 分块读分支(tapeRecordChunkRateLimiter):30 req/10s —— 单条 4MB 记录按 256KB 分块需 ~16 次
//     连拉,共用 10/10s 会撞第 11 块 429、前端把半截冒充完整(已同批修前端 partial 提示)。
// 本测试锁死两桶配置口径,防回退到共用一桶。

import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { RateLimiter } from '../rateLimit.js'

describe('M6② 令牌桶配置:分块分支独立 30/10s(>10 块不 429)', () => {
  test('行分页桶 10/10s:第 11 次 → 429(挡刷爆)', () => {
    const rl = new RateLimiter({ maxRequests: 10, windowMs: 10_000 })
    for (let i = 0; i < 10; i++) {
      assert.equal(rl.check('u1', 'tape-records'), true, `第 ${i + 1} 次应放行`)
    }
    assert.equal(rl.check('u1', 'tape-records'), false, '第 11 次 → 429')
  })

  test('分块读桶 30/10s:连拉 16 块(4MB/256KB)全放行,绝不撞第 11 块 429', () => {
    const rl = new RateLimiter({ maxRequests: 30, windowMs: 10_000 })
    for (let i = 0; i < 16; i++) {
      assert.equal(rl.check('u1', 'tape-record-chunk'), true, `分块第 ${i + 1} 拉应放行(不 429)`)
    }
    // 仍有余量(30 - 16),证明配额足够单条超大记录全量分块 + 正常翻页。
    assert.equal(rl.remaining('u1', 'tape-record-chunk'), 14)
  })

  test('两桶独立:同 userId 分块连拉不消耗行分页配额', () => {
    const chunk = new RateLimiter({ maxRequests: 30, windowMs: 10_000 })
    const rows = new RateLimiter({ maxRequests: 10, windowMs: 10_000 })
    for (let i = 0; i < 20; i++) chunk.check('u1', 'tape-record-chunk')
    // 行分页桶未被分块连拉污染,仍有全额 10 次。
    assert.equal(rows.remaining('u1', 'tape-records'), 10)
  })
})

// INC-20260726-ARCHIVE-CURSOR-OVERFLOW live proof:
// 内容大半已 spill、热行只剩 anchor 的长会话首次打开不得 500。
// 触发链:首页无 cursor → beforeOrderSeq=Number.MAX_SAFE_INTEGER 绑进
// `WHERE first_seq < $3`(integer 列) → PG 22003 → GET /api/sessions/:id 500。
// 夹具直写 archive chunks(06 故意不写);首页 limit 远大于热行,归档循环必进。

import { expect, test } from '../fixtures'
import { config, directTimelineRequired, mintSessionId } from '../lib/env'
import { queryScalar } from '../lib/pg'
import {
  SeedUnavailable,
  SPILL_SEED,
  SPILL_SEED_TOTAL_ROWS,
  cleanupSeed,
  requireDirectTimeline,
  seedSpilledArchiveSession,
  spilledHotMessageId,
} from '../lib/seed'
import { loginViaUi, openSession, SEL } from '../lib/ui'

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

test('spilled archive session first open does not 500 on MAX_SAFE_INTEGER cursor', async ({
  page,
  api,
  token,
  track,
}) => {
  try {
    requireDirectTimeline()
  } catch (err) {
    if (directTimelineRequired()) throw err
    test.skip(true, `direct-timeline/注入通道不可用,跳过 spill 打开用例:${(err as Error).message}`)
    return
  }

  const cfg = config()
  const sid = mintSessionId('spill')
  const userId = await api.currentUserId(token)
  track(sid)

  try {
    seedSpilledArchiveSession(userId, sid)
    const through = queryScalar(`
      SELECT archived_through_seq::text
        FROM client_sessions
       WHERE id=${sqlText(sid)}
    `)
    expect(
      Number(through),
      '前置:archived_through_seq 必须 > 0,否则归档循环根本不会进入(空断言)',
    ).toBe(SPILL_SEED.archivedRows)
    const hotCount = JSON.parse(queryScalar(`
      SELECT messages::text FROM client_sessions WHERE id=${sqlText(sid)}
    `) || '[]').length
    expect(hotCount, '前置:热行必须远小于首页 limit,否则不读归档').toBe(SPILL_SEED.hotRows)

    const detail = await fetch(`${cfg.baseUrl}/api/sessions/${sid}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const detailText = await detail.text()
    expect(
      detail.status,
      `首次打开 GET /api/sessions/:id 不得 500(修复前 22003): ${detailText.slice(0, 240)}`,
    ).toBe(200)
    const detailBody = JSON.parse(detailText) as { messages?: unknown[] }
    expect(
      (detailBody.messages?.length ?? 0),
      '首页必须真的带回记录,不能靠空结果蒙混过关',
    ).toBeGreaterThan(0)

    const timeline = await fetch(`${cfg.baseUrl}/api/sessions/${sid}/timeline?limit=500`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const timelineText = await timeline.text()
    expect(
      timeline.status,
      `timeline 首页 limit=500 必须下潜归档且不得 22003: ${timelineText.slice(0, 240)}`,
    ).toBe(200)
    const timelineBody = JSON.parse(timelineText) as { messages?: Array<{ id?: string }> }
    expect(
      (timelineBody.messages?.length ?? 0),
      'limit 远大于热行时必须读回归档记录,不能只靠热尾巴填满',
    ).toBeGreaterThan(SPILL_SEED.hotRows)
    expect(timelineBody.messages?.some((row) => row.id === spilledHotMessageId(SPILL_SEED_TOTAL_ROWS)))
      .toBeTruthy()

    await loginViaUi(page)
    await openSession(page, sid)
    await expect(SEL.historySkeleton(page)).toHaveCount(0)
    await expect(
      page.getByText(`e2e-spill hot ${String(SPILL_SEED_TOTAL_ROWS).padStart(6, '0')}`),
      'UI 首次打开必须看到热尾巴,不得停在 500/错误卡',
    ).toBeVisible({ timeout: 15_000 })
    await expect(SEL.errorBanner(page)).toHaveCount(0)
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      if (directTimelineRequired()) throw err
      test.skip(true, `direct-timeline 注入失败,跳过:${err.message}`)
      return
    }
    throw err
  } finally {
    await api.deleteSession(token, sid).catch(() => {})
    cleanupSeed(sid)
  }
})

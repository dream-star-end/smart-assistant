// 用例 6:归档分页("从云端加载更早的历史")逐页拉取,断言无重复行 / 无空页死循环。
// 回归目标:分页游标 bug(重复行 / 空页 hasMore 死循环)。
// 策略:核心不变量(无重复 seq、空页不谎报 hasMore、游标严格递减、有限步终止)在任意
// 账号上都可自验;若存在带归档(archivedCount>0)的会话,再叠加 UI 逐页加载断言。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import type { Api } from '../lib/api';
import { loginViaUi, openSession, SEL } from '../lib/ui';

const PAGE_LIMIT = 20;
const HARD_CAP = 500; // 防死循环硬上限(远大于任何合理归档页数)

/** 走完整归档翻页,断言:无重复 seq / 空页不谎报 hasMore / 游标严格递减 / 有限步终止。 */
async function walkArchiveInvariants(api: Api, token: string, sid: string): Promise<number> {
  let before: number | undefined = undefined;
  const seen = new Set<number>();
  let iters = 0;
  for (;;) {
    const pageData = await api.getArchive(token, sid, before, PAGE_LIMIT);
    iters++;
    expect(iters, '归档翻页步数超过硬上限(疑似空页死循环)').toBeLessThan(HARD_CAP);

    if (pageData.messages.length === 0) {
      // 空页绝不能声称还有更多(否则前端会死循环拉取)。
      expect(pageData.hasMore, '空页不得 hasMore=true(死循环根因)').toBeFalsy();
      break;
    }
    // 升序:首条最老。收集并查重。
    let minSeq = Number.POSITIVE_INFINITY;
    for (const m of pageData.messages) {
      const seq = Number((m as any)._seq);
      expect(Number.isFinite(seq), '归档消息应带数值 _seq').toBeTruthy();
      expect(seen.has(seq), `跨页出现重复 seq=${seq}`).toBeFalsy();
      seen.add(seq);
      if (seq < minSeq) minSeq = seq;
    }
    const oldest = typeof pageData.oldestSeq === 'number' ? pageData.oldestSeq : minSeq;
    if (before !== undefined) {
      expect(oldest, '游标必须严格递减(否则不收敛)').toBeLessThan(before);
    }
    before = oldest;
    if (!pageData.hasMore) break;
  }
  return seen.size;
}

test('归档分页:无重复行 / 无空页死循环 / 游标收敛', async ({ page, api, token, track }) => {
  const cfg = config();

  // 优先找一个已有归档(archivedCount>0)的会话(只读,不清理);找不到则用新建空会话验负例。
  const list = await api.listSessions(token);
  let archivedSid: string | null = null;
  for (const s of list.slice(0, 25)) {
    const d = await api.getSession(token, s.id).catch(() => null);
    if (d && Number(d.archivedCount ?? 0) > 0) {
      archivedSid = s.id;
      break;
    }
  }

  // 目标会话:有归档的用它;否则建一个 e2e 空会话验"空归档 = 干净终止 + 无假加载"。
  let targetSid = archivedSid;
  if (!targetSid) {
    targetSid = mintSessionId('archive');
    track(targetSid);
    const put = await api.putSession(token, targetSid, { title: 'e2e-archive-empty', model: cfg.model });
    expect(put.ok).toBeTruthy();
  }

  // ── API 层不变量(始终自验)──────────────────────────────────────────────
  const total = await walkArchiveInvariants(api, token, targetSid);

  // ── UI 层:仅当存在真实归档时,断言"从云端加载更早的历史"逐页无重复且终止 ──────
  await loginViaUi(page);
  await openSession(page, targetSid);

  const cloudBtn = SEL.loadMoreCloud(page);
  if (archivedSid && total > 0) {
    let clicks = 0;
    let prevRows = -1;
    while ((await cloudBtn.count()) > 0 && clicks < HARD_CAP) {
      const rowsBefore = await page.locator('[data-testid="user-row"], [data-testid="assistant-row"]').count();
      await cloudBtn.first().click();
      // 轮询行数增加(加载生效)或按钮消失(到底);不死 sleep。
      await expect
        .poll(async () => {
          const now = await page.locator('[data-testid="user-row"], [data-testid="assistant-row"]').count();
          const gone = (await cloudBtn.count()) === 0;
          return now > rowsBefore || gone;
        }, { timeout: 15_000 })
        .toBeTruthy();
      const rowsNow = await page.locator('[data-testid="user-row"], [data-testid="assistant-row"]').count();
      expect(rowsNow, '每次加载后行数应单调不减(无回退/无重复清空)').toBeGreaterThanOrEqual(rowsBefore);
      expect(rowsNow, '行数应真增长(否则空页死循环)').toBeGreaterThan(prevRows);
      prevRows = rowsNow;
      clicks++;
    }
    expect(clicks, 'UI 逐页加载应在硬上限内终止').toBeLessThan(HARD_CAP);
    await expect(cloudBtn, '加载到底后云端加载按钮应消失').toHaveCount(0);
  } else {
    // 无归档:绝不出现"从云端加载更早的历史"假入口(负例回归)。
    await expect(cloudBtn, '空归档会话不应出现云端加载按钮').toHaveCount(0);
  }
});

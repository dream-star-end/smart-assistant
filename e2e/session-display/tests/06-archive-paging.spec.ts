// 用例 6:更早历史分页 —— 无重复行 / 无空页死循环 / 游标收敛 / 一行不丢。
// 回归目标:INC-20260721-LAZY-TIMELINE-LOSS(超长会话懒加载丢内容、翻不动、游标不收敛)。
//
// 2026-07-26 门禁审计后的重写。原实现有两处结构性假绿,都在这里根治:
//   ① UI 逐页断言包在 `if (archivedSid && total > 0)` 里,而 v5-evals 是纯验证账号、
//      每条用例结束即删会话 —— 永远凑不出带归档的会话,分支从落地起一次没跑过
//      (实测整条用例 2.47s,不可能跑过翻页循环)。现在用 seedPagedArchivedSession
//      直写 PG 造出**必须翻页**的真实会话,分支无条件执行。
//   ② 分支里用的「从云端加载更早的历史」/「加载更多历史」两句文案,生产组件里一次都没
//      渲染过(loadOlderHistoryLabel 无调用点),`cloudBtn.count()` 恒 0 —— 即使凑出归档
//      会话,while 循环也进不去,负例 toHaveCount(0) 恒真。现在锁真实控件
//      history-page-loader 的四态文案。
//   同时把 API 层不变量从 legacy `/archive` 端点**扩到 UI 真正调用的 `/timeline`**:
//   前端「查看更早历史记录」走的是 timeline 游标(useChatSocket.loadOlderHistory),
//   只验 /archive 等于验了一条用户到不了的路;/archive 仍在服务旧客户端,顺带一起验。
//
// 虚拟列表说明:翻页后新行前插在视口之上,DOM 只挂载可见窗口 —— 所以"没丢行/没重复"
// 不能靠数 DOM 节点,而是在 timeline 端点的 union 上判定(同一端点、同一游标语义);
// UI 层负责证明控件真的能点、真的收敛、真的在有限步内到底。

import { test, expect } from '../fixtures';
import { directTimelineRequired, mintSessionId } from '../lib/env';
import type { Api } from '../lib/api';
import {
  PAGED_SEED_TOTAL_ROWS,
  SeedUnavailable,
  cleanupSeed,
  pagedSeedMessageId,
  requireDirectTimeline,
  seedPagedArchivedSession,
} from '../lib/seed';
import { loginViaUi, openSession, SEL, TEXT } from '../lib/ui';

const PAGE_LIMIT = 20;
const HARD_CAP = 500; // API 层防死循环硬上限(远大于任何合理归档页数)
/**
 * UI 逐页点击上限。夹具 260 行 / 首屏 100 行 → 实测(生产读路径 readClientTimelinePage,
 * 本地 fixture PG)恰好 3 页:100 / 100 / 60,游标 beforeOrderSeq 161 → 61 → null,
 * 即 2 次点击到底。12 是 4 倍余量:超出即"空页死循环 / 游标不收敛"。
 */
const UI_CLICK_CAP = 12;

/** 走完整 legacy 归档翻页(旧客户端仍在用):无重复 seq / 空页不谎报 hasMore / 游标严格递减。 */
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

/**
 * 走 UI 真正调用的 timeline 游标分页,返回按加载顺序拼出的全部消息 id。
 * 不变量:页非空 / hasMore 必带新游标 / 游标不得重复出现 / 有限步终止。
 */
async function walkTimelinePages(api: Api, token: string, sid: string): Promise<string[]> {
  const ids: string[] = [];
  const cursorsSeen = new Set<string>();
  let cursor: string | null = null;
  let generation: number | null = null;
  for (let page = 1; ; page++) {
    expect(page, 'timeline 翻页步数超过硬上限(疑似游标不收敛)').toBeLessThan(HARD_CAP);
    const data = await api.getTimelinePage(token, sid, cursor, 100);
    expect(data.messages.length, `timeline 第 ${page} 页返回空页(空页 + hasMore = 死循环)`)
      .toBeGreaterThan(0);
    if (generation === null) generation = data.timelineGeneration;
    expect(data.timelineGeneration, 'timelineGeneration 在同一次遍历内不得漂移').toBe(generation);
    for (const message of data.messages) {
      const id = String((message as { id?: unknown }).id ?? '');
      if (id) ids.push(id);
    }
    if (!data.hasMore) {
      expect(data.nextCursor, '到底页不得再给游标(否则前端会继续拉)').toBeFalsy();
      break;
    }
    const next = data.nextCursor;
    expect(typeof next === 'string' && next.length > 0, 'hasMore=true 必须带下一页游标').toBeTruthy();
    expect(cursorsSeen.has(next as string), `游标重复出现(不收敛): ${String(next).slice(0, 32)}`)
      .toBeFalsy();
    cursorsSeen.add(next as string);
    cursor = next;
  }
  return ids;
}

test('归档分页:无重复行 / 无空页死循环 / 游标收敛', async ({ page, api, token, track }) => {
  // 能力门:注入通道不可用即跳过;发布门下 OC_E2E_REQUIRE_DIRECT_TIMELINE=1 → 直接失败,
  // 不允许"因为造不出数据所以什么都没验"再次发生。
  try {
    requireDirectTimeline();
  } catch (err) {
    if (directTimelineRequired()) throw err;
    test.skip(true, `direct-timeline/注入通道不可用,跳过分页用例:${(err as Error).message}`);
    return;
  }

  const sid = mintSessionId('paging');
  const userId = await api.currentUserId(token);
  track(sid);

  try {
    seedPagedArchivedSession(userId, sid);
    const expectedIds = Array.from(
      { length: PAGED_SEED_TOTAL_ROWS },
      (_, i) => pagedSeedMessageId(i + 1),
    ).sort();

    // ── API 层:UI 同源端点(timeline 游标)的完整遍历 ─────────────────────────
    const loadedIds = await walkTimelinePages(api, token, sid);
    const uniqueLoaded = new Set(loadedIds);
    expect(
      loadedIds.length - uniqueLoaded.size,
      `跨页出现重复行(重复 ${loadedIds.length - uniqueLoaded.size} 条)`,
    ).toBe(0);
    expect(
      [...uniqueLoaded].sort(),
      '翻完全部页后必须拿回一模一样的历史:少一行 = 懒加载丢内容,多一行 = 跨页重复',
    ).toEqual(expectedIds);

    // legacy /archive(旧客户端仍在读):本夹具刻意不注入归档 chunk(理由见 lib/seed.ts
    // 的长注释:存储层首页游标 int32 越界,archived_through_seq>0 的会话 timeline 读会抛),
    // 所以这里锁的是"空归档必须干净终止":一次读、空页、hasMore=false、不谎报还有更多。
    const archivedSeen = await walkArchiveInvariants(api, token, sid);
    expect(archivedSeen, '本夹具没有归档行,/archive 必须诚实地返回空(非空 = 归档水位算错)')
      .toBe(0);

    // ── UI 层:真实控件必须出现、可点、有限步到底 ────────────────────────────
    await loginViaUi(page);
    await openSession(page, sid);

    const loader = SEL.historyPageLoader(page);
    const olderBtn = SEL.historyOlderBtn(page);
    await expect(
      loader,
      '首屏只给一页,「更早历史」入口必须在场(不在场 = 用户翻不到更早内容)',
    ).toBeVisible({ timeout: 20_000 });
    await expect(olderBtn, '入口初始必须是可点的「查看更早历史记录」').toContainText(TEXT.historyOlder);
    await expect(olderBtn).toBeEnabled();

    let clicks = 0;
    for (;;) {
      const label = ((await olderBtn.innerText()) || '').trim();
      if (label.includes(TEXT.historyEnd)) break;
      expect(label, `分页控件进入失败态: ${label}`).not.toContain(TEXT.historyLoadFailed);
      expect(clicks, 'UI 逐页加载未在硬上限内到底(空页死循环 / 游标不收敛)')
        .toBeLessThan(UI_CLICK_CAP);
      await olderBtn.click();
      clicks++;
      // 轮询"这一页加载结束"(按钮离开加载态):只改什么时候读,不放宽读到什么。
      await expect
        .poll(async () => ((await olderBtn.innerText()) || '').trim(), { timeout: 30_000 })
        .not.toContain(TEXT.historyLoading);
      await expect(
        page.getByText(TEXT.historyLoadFailed),
        `第 ${clicks} 次加载更早历史失败(用户点了但拉不回来)`,
      ).toHaveCount(0);
    }
    expect(clicks, '一次都没点到:夹具没造出第二页,UI 分支又变成空跑').toBeGreaterThan(0);
    await expect(olderBtn, '到底后必须显示「已到最早记录」(否则用户会一直点空页)')
      .toContainText(TEXT.historyEnd);
    await expect(olderBtn, '到底后入口必须禁用').toBeDisabled();
    test.info().annotations.push({
      type: 'archive-ui-paging',
      description: `executed: ${clicks} 次点击翻完 ${PAGED_SEED_TOTAL_ROWS} 行(seeded)`,
    });

    // 到底之后再走一遍 timeline:读路径不得有副作用(内容与代不因 UI 翻页而变)。
    const reloadedIds = new Set(await walkTimelinePages(api, token, sid));
    expect([...reloadedIds].sort(), 'UI 翻页后服务端时间线内容发生变化(读路径有副作用)')
      .toEqual(expectedIds);
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      if (directTimelineRequired()) throw err;
      test.skip(true, `direct-timeline 注入失败,跳过:${err.message}`);
      return;
    }
    throw err;
  } finally {
    await api.deleteSession(token, sid).catch(() => {});
    cleanupSeed(sid);
  }
});

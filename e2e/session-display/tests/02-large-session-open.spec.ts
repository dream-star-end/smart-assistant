// 用例 2(@smoke,§9 依赖):预置大会话(多卷投影)→ 打开计时。
//   断言:首屏可交互 < 预算(默认 3s);有超预算卷 → 折叠卡出现;点击展开出内容。
// 未部署 §9(无 OC_E2E_PG_URL / 迁移 0170 缺失)→ skip-with-reason,结构保留。
// 回归目标:大会话 20s 白屏 / 挂历史 22-31s。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { SeedUnavailable, requireSection9, seedLargeSession, cleanupSeed } from '../lib/seed';
import { loginViaUi, SEL } from '../lib/ui';

const TTI_BUDGET = Number(process.env.OC_E2E_TTI_BUDGET_MS ?? 3000);

// 只取 { page, api }:不依赖会强制登录的 token/track fixture,§9 缺失时纯 env 门 skip、零登录。
test('@smoke 大会话打开 < 3s 可交互 + 超预算卷折叠可展开', async ({ page, api }) => {
  const cfg = config();
  const sid = mintSessionId('large');

  // §9 门(纯 env 探测,skip 前不登录,不消耗登录限流)。
  try {
    requireSection9();
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      test.skip(true, `§9 未部署,跳过大会话用例:${err.message}`);
      return;
    }
    throw err;
  }

  const { userId, token } = await api.login();
  try {
    seedLargeSession(userId, sid);

    await loginViaUi(page);

    // 打开计时:导航到会话 → composer 可交互。
    const t0 = Date.now();
    await page.goto(`${cfg.baseUrl}/s/${sid}`, { waitUntil: 'commit' });
    await SEL.composer(page).waitFor({ state: 'visible', timeout: 20_000 });
    const tti = Date.now() - t0;
    expect(tti, `首屏可交互耗时 ${tti}ms 应 < ${TTI_BUDGET}ms(回归:20s 白屏)`).toBeLessThan(TTI_BUDGET);

    // 骨架屏应已消失(不永挂)。
    await expect(SEL.historySkeleton(page)).toHaveCount(0, { timeout: 20_000 });

    // 超预算/building 卷 → 折叠卡"本轮完整输出 N MB"。
    const fold = SEL.collapseCard(page).first();
    await expect(fold, '应出现折叠卡(超预算卷不全量水合)').toBeVisible({ timeout: 15_000 });

    // 点击可展开的折叠卡 → 出内容("已展开"分节头 / 正文)。building 卷不可展开,
    // 故点第一张 canExpand 的卡:用文案含"点击加载"筛。
    const expandable = page.getByRole('button', { name: /本轮完整输出.*点击加载/ }).first();
    if (await expandable.count()) {
      await expandable.click();
      await expect(
        page.getByText(/已展开|继续加载更多|收起/).first(),
        '展开后应出现分节头/内容',
      ).toBeVisible({ timeout: 15_000 });
    }
  } finally {
    await api.deleteSession(token, sid).catch(() => {});
    cleanupSeed(sid);
  }
});

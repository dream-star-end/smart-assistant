// 用例 2(@smoke,direct-timeline 依赖):预置含 2 MiB 工具记录的 finalized tape → 打开计时。
//   断言:首屏可交互 < 预算(默认 3s);真实最终答复直出;真实工具记录经 Range 惰性水合。
// 未部署迁移 0176(或无 OC_E2E_PG_URL)→ skip-with-reason。
// 回归目标:大会话 20s 白屏 / 挂历史 22-31s。

import { test, expect } from '../fixtures';
import { config, directTimelineRequired, mintSessionId } from '../lib/env';
import { SeedUnavailable, requireDirectTimeline, seedLargeSession, cleanupSeed } from '../lib/seed';
import { loginViaUi, SEL } from '../lib/ui';

const TTI_BUDGET = Number(process.env.OC_E2E_TTI_BUDGET_MS ?? 3000);

// 只取 { page, api }:不依赖会强制登录的 token/track fixture,能力缺失时纯 env 门 skip、零登录。
test('@smoke 大会话打开 < 3s 可交互 + 真实答复直出 + 工具记录惰性水合', async ({ page, api }) => {
  const cfg = config();
  const sid = mintSessionId('large');

  // direct-timeline 门(纯 env 探测,skip 前不登录,不消耗登录限流)。
  try {
    requireDirectTimeline();
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      if (directTimelineRequired()) throw err;
      test.skip(true, `direct-timeline 未部署,跳过大会话用例:${err.message}`);
      return;
    }
    throw err;
  }

  const { userId, token } = await api.login();
  try {
    seedLargeSession(userId, sid);

    await loginViaUi(page);

    const payloadProbe = page.waitForResponse(
      (response) => {
        const request = response.request();
        const url = new URL(response.url());
        return url.pathname.startsWith(`/api/sessions/${sid}/tape/`) &&
          url.pathname.endsWith('/records/0/payload') &&
          request.headers().range === 'bytes=0-0';
      },
      { timeout: 20_000 },
    );

    // 打开计时:导航到会话 → composer 可交互。
    const t0 = Date.now();
    await page.goto(`${cfg.baseUrl}/s/${sid}`, { waitUntil: 'commit' });
    await SEL.composer(page).waitFor({ state: 'visible', timeout: 20_000 });
    const tti = Date.now() - t0;
    expect(tti, `首屏可交互耗时 ${tti}ms 应 < ${TTI_BUDGET}ms(回归:20s 白屏)`).toBeLessThan(TTI_BUDGET);

    // 骨架屏应已消失(不永挂)。
    await expect(SEL.historySkeleton(page)).toHaveCount(0, { timeout: 20_000 });

    await expect(page.getByText('e2e 首屏可见的真实最终答复')).toBeVisible({ timeout: 15_000 });
    const probe = await payloadProbe;
    expect(probe.status(), '真实大记录必须走 206 Range payload 端点').toBe(206);
    await expect(SEL.turnProcessCard(page), '旧过程投影不得替代真实 logical record').toHaveCount(0);

    const tool = page.getByRole('button', { name: /^终端\s+e2e-long-output\s+完成$/ });
    await expect(tool, '真实 Bash 工具记录应在 payload 水合后可见').toBeVisible({ timeout: 15_000 });
    await tool.click();
    await expect(
      page.locator('pre').filter({ hasText: 'E2E_TOOL_FINAL_MARKER' }),
      '展开后必须包含 2 MiB payload 的最后标记，禁止截断或摘要替身',
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await api.deleteSession(token, sid).catch(() => {});
    cleanupSeed(sid);
  }
});

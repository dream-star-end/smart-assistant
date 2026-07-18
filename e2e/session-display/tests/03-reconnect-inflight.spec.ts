// 用例 3:发消息后立即断 WS(离线)→ 恢复 → 断言:
//   要么回复正常到达,要么出现明确失败卡+重试;**绝不允许**永久静默无任何状态。
// 回归目标:静默丢 turn(master 挂历史期间 WS 断连 → if(cleaned) return 静默丢弃)。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { pollUntil } from '../lib/poll';
import { loginViaUi, openSession, sendMessage, waitForTurnSettled, SEL } from '../lib/ui';

test('断线重连:回复到达或明确失败,绝不永久静默', async ({ page, api, token, track }) => {
  const cfg = config();
  const sid = mintSessionId('reconn');
  const uniq = Date.now().toString(36);
  track(sid);
  const put = await api.putSession(token, sid, { title: `e2e-reconnect-${uniq}`, model: cfg.model });
  expect(put.ok).toBeTruthy();

  await loginViaUi(page);
  await openSession(page, sid);
  await sendMessage(page, `e2e-reconnect-${uniq} 请只回复:OK`);

  // user 行应立即上屏(乐观态)。
  await expect(SEL.userRows(page).filter({ hasText: `e2e-reconnect-${uniq}` })).toHaveCount(1);

  // 立即断网(丢 WS + 所有请求)——模拟在飞期间的连接中断。
  await page.context().setOffline(true);
  // 保持离线一小段(轮询确认离线态生效,不死 sleep)。
  await pollUntil(async () => (await page.evaluate(() => !navigator.onLine)) || null, {
    timeoutMs: 8_000,
    intervalMs: 300,
    label: 'browser offline',
  });
  await page.waitForTimeout(4_000); // 让在飞 turn 跨越断连窗口

  // 恢复网络 → 前端应重连 WS 并 reconcile。
  await page.context().setOffline(false);

  // 核心断言:有限时间内必达终态之一(回复 or 失败卡+重试),绝不永久静默。
  // waitForTurnSettled 超时会抛(= 永久静默 = 用例失败,正是要防的回归)。
  const outcome = await waitForTurnSettled(page, { timeoutMs: Math.max(90_000, cfg.turnTimeoutMs) });
  expect(['reply', 'error']).toContain(outcome);

  if (outcome === 'error') {
    // 失败必须可重试(横幅"重试发送" 或 内联"重新尝试")。
    const retryable =
      (await SEL.retryBannerBtn(page).count()) > 0 || (await SEL.retryInlineBtn(page).count()) > 0;
    expect(retryable, '失败态必须给出重试入口').toBeTruthy();
  } else {
    await expect(SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).first()).toBeVisible();
  }
});

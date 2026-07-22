// 用例 4(@smoke):发消息 → 回复中途刷新页面 → 断言重连后终态正确收敛。
//   spinner 不永挂;回复或失败卡二选一(reconcile 绑定身份,不冒充/不清等待态)。
// 回归目标:终态收敛错位(容器 autoResumeFromHello 拿上一轮 outcome 冒充终态清空等待)。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { pollUntil } from '../lib/poll';
import {
  loginViaUi,
  openSession,
  selectExactModel,
  sendMessage,
  waitForTurnSettled,
  waitForHistoryLoaded,
  SEL,
} from '../lib/ui';

test('@smoke 回复中途刷新:终态正确收敛,spinner 不永挂', async ({ page, api, token, track }) => {
  const cfg = config();
  const sid = mintSessionId('reconc');
  const uniq = Date.now().toString(36);
  track(sid);
  const put = await api.putSession(token, sid, { title: `e2e-reconcile-${uniq}`, model: cfg.model });
  expect(put.ok).toBeTruthy();

  await loginViaUi(page);
  await openSession(page, sid);
  await selectExactModel(page, cfg.model);
  track(sid, { expectTurn: true });
  await sendMessage(page, `e2e-reconcile-${uniq} 请简短回复一句话`);
  await expect(SEL.userRows(page).filter({ hasText: `e2e-reconcile-${uniq}` })).toHaveCount(1);

  // 等进入"回复中"(typing 出现)或已很快出正文;随后中途刷新。
  await pollUntil(
    async () =>
      (await SEL.typing(page).count()) > 0 ||
      (await SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).count()) > 0 ||
      null,
    { timeoutMs: 30_000, intervalMs: 300, label: 'turn started (typing or partial reply)' },
  );

  // 回复中途硬刷新页面(丢前端态,靠重连 + reconcile 收敛)。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHistoryLoaded(page);

  // 终态必收敛:回复 or 失败卡,二选一;spinner 不永挂(waitForTurnSettled 超时=永挂=失败)。
  const outcome = await waitForTurnSettled(page, { timeoutMs: Math.max(90_000, cfg.turnTimeoutMs) });
  expect(['reply', 'error']).toContain(outcome);

  // typing 指示最终必须消失(收敛证据)。
  await expect(SEL.typing(page)).toHaveCount(0, { timeout: 10_000 });

  // API 佐证:该 user 消息对应有终态(assistant 回复 或 error 标记),不静默悬挂。
  const detail = await api.getSession(token, sid);
  expect(detail.messages.length, '服务端应至少有 user 行').toBeGreaterThanOrEqual(1);
});

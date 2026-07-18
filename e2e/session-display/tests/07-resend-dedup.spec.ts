// 用例 7:同 clientMessageId 重发(协议级双发同帧,模拟快速双击/断线重发)→
//   断言不出双回复(服务端幂等 idempotencyKey=web:<cmid>:0 去重)。
// 回归目标:resend 去重失效导致重复计费 / 双回复。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { driveTurn, mintClientMessageId } from '../lib/ws';
import { loginViaUi, openSession, SEL } from '../lib/ui';

test('resend-dedup:同 clientMessageId 重发不出双回复/不双计费', async ({ page, api, token, track }) => {
  const cfg = config();
  const sid = mintSessionId('dedup');
  const uniq = Date.now().toString(36);
  const cmid = mintClientMessageId();
  track(sid);

  const put = await api.putSession(token, sid, { title: `e2e-dedup-${uniq}`, model: cfg.model });
  expect(put.ok).toBeTruthy();

  // 协议级:同一连接连发两帧,cmid 与 idempotencyKey 完全相同 → 服务端应去重为单 turn。
  const result = await driveTurn({
    token,
    sessionId: sid,
    text: `e2e-dedup-${uniq} 请只回复:OK`,
    clientMessageId: cmid,
    sendTimes: 2,
  });

  // 错误帧分类:busy/duplicate/in-progress 类 = 服务端拒绝了重复帧 = **去重生效**的证据
  // (不是失败);其余错误帧才算真失败(真 turn 被打断)。
  const BENIGN = /CODEX_TURN_BUSY|turn.*(busy|in progress|already)|duplicate|dedup|idempot/i;
  const benign = result.errors.filter((e) => BENIGN.test(e));
  const fatal = result.errors.filter((e) => !BENIGN.test(e));
  expect(fatal, `出现非去重类错误帧(真 turn 被打断): ${fatal.join(' | ')}`).toHaveLength(0);
  // 至少有一条证据表明去重发生了:要么第二帧被 busy/dup 拒绝,要么两帧合并成单 turn
  // (下方 API user 行=1 亦是证据);此处仅记录,不硬断言拒绝路径(不同引擎/构建机制不同)。
  if (benign.length > 0) console.log(`[dedup] 第二帧被去重拒绝(预期): ${benign[0].slice(0, 120)}`);

  // 绝不双计费:cost_charged 至多 1 次(免单套餐可能 0 次)。
  expect(result.costCount, `重复帧导致了 ${result.costCount} 次计费(应 ≤ 1)`).toBeLessThanOrEqual(1);

  // API 佐证:该 cmid 只落 1 条 user 行、至多 1 条 assistant 回复(无双回复)。
  const detail = await api.getSession(token, sid);
  const userMatches = detail.messages.filter(
    (m: any) => (m.role === 'user') && (m.id === cmid || m._clientMessageId === cmid),
  );
  expect(userMatches.length, '同 cmid 应只有 1 条 user 行(去重)').toBe(1);
  const assistantMsgs = detail.messages.filter((m: any) => m.role === 'assistant' && String(m.text ?? '').trim());
  expect(assistantMsgs.length, '不应出现双回复').toBeLessThanOrEqual(1);

  // UI 佐证:打开会话,marker 的 user 行恰 1、assistant 正文行至多 1。
  await loginViaUi(page);
  await openSession(page, sid);
  await expect(SEL.userRows(page).filter({ hasText: `e2e-dedup-${uniq}` })).toHaveCount(1);
  const assistantRowCount = await SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).count();
  expect(assistantRowCount, 'UI 不应出现双回复').toBeLessThanOrEqual(1);
});

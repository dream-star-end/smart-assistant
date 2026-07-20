// 用例 5(direct-timeline 依赖,DB 注入):直接注入 verified terminal(not_accepted) 状态 →
//   断言状态卡显示"消息未开始处理 / 已确认未计费" + 重试;late-tape manual_reconcile 不显示。
// 未部署迁移 0176 / 无注入通道 → skip-with-reason。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { SeedUnavailable, requireDirectTimeline, seedTurnStatuses, cleanupSeed } from '../lib/seed';
import { loginViaUi, openSession, SEL, TEXT } from '../lib/ui';
import { mintClientMessageId } from '../lib/ws';

// 只取 { page, api }:direct-timeline/注入不可用时纯 env 门 skip、零登录(不消耗登录限流)。
test('verified turn status:未计费状态展示 + late-tape 状态不显示', async ({ page, api }) => {
  const cfg = config();
  // 能力门:不可用即跳过(不制造假失败),skip 前不登录。
  try {
    requireDirectTimeline();
  } catch (err) {
    test.skip(true, `direct-timeline/注入通道不可用,跳过状态用例:${(err as Error).message}`);
    return;
  }

  const sid = mintSessionId('turnstatus');
  const { userId, token } = await api.login();
  const visibleCmid = mintClientMessageId();
  const resolvedCmid = mintClientMessageId();

  try {
    // 预置两条 user 行，供 durable 状态按 clientMessageId 归属。
    const put = await api.putSession(token, sid, {
      title: 'e2e-turn-status',
      model: cfg.model,
      messages: [
        { id: visibleCmid, role: 'user', text: 'e2e-status 可见:这条应出未计费状态卡' },
        { id: resolvedCmid, role: 'user', text: 'e2e-status 已被 late tape 推翻:不应出现状态卡' },
      ],
    });
    expect(put.ok, `putSession: ${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();

    const detail = await api.getSession(token, sid);
    const seqOf = (cmid: string): number => {
      const m = detail.messages.find((x: any) => x.id === cmid || x._clientMessageId === cmid);
      return Number(m?._seq ?? 0);
    };
    seedTurnStatuses(userId, sid, {
      visibleCmid,
      visibleSeq: seqOf(visibleCmid) || 1,
      resolvedCmid,
      resolvedSeq: seqOf(resolvedCmid) || 2,
    });

    await loginViaUi(page);
    await openSession(page, sid);

    // 可见:未计费错误卡文案 + 重试。
    await expect(page.getByText(TEXT.dispatchLostTitle).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TEXT.notCharged).first()).toBeVisible();
    const retryable =
      (await SEL.retryInlineBtn(page).count()) > 0 || (await SEL.retryBannerBtn(page).count()) > 0;
    expect(retryable, '未计费错误卡应可重试').toBeTruthy();

    // 直接状态读只返回 terminal + client_notified；manual_reconcile 不冒充丢失。
    await expect(
      page.getByText(TEXT.dispatchLostTitle),
      'late-tape manual_reconcile 不应渲染状态卡(仅可见那条 1 张)',
    ).toHaveCount(1);
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      test.skip(true, `direct-timeline 注入失败,跳过:${err.message}`);
      return;
    }
    throw err;
  } finally {
    await api.deleteSession(token, sid).catch(() => {});
    cleanupSeed(sid);
  }
});

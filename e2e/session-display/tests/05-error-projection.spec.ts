// 用例 5(§9 依赖,DB 注入):注入 terminal(not_accepted)+ active error projection →
//   断言错误卡显示"消息未开始处理 / 已确认未计费" + 重试;注入 revoked → 断言**不显示**。
// 未部署 §9 / 无注入通道 → skip-with-reason。回归目标:钱安全(未执行未计费文案只在
// durable not_accepted 证明下出现;late tape 撤销后已计费内容不冒充丢失)。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { SeedUnavailable, requireSection9, seedErrorProjection, cleanupSeed } from '../lib/seed';
import { loginViaUi, openSession, SEL, TEXT } from '../lib/ui';
import { mintClientMessageId } from '../lib/ws';

// 只取 { page, api }:§9/注入不可用时纯 env 门 skip、零登录(不消耗登录限流)。
test('error projection:未计费错误卡展示 + revoked 不显示', async ({ page, api }) => {
  const cfg = config();
  // §9 能力门:不可用即跳过(不制造假失败),skip 前不登录。
  try {
    requireSection9();
  } catch (err) {
    test.skip(true, `§9/注入通道不可用,跳过 error projection 用例:${(err as Error).message}`);
    return;
  }

  const sid = mintSessionId('errproj');
  const { userId, token } = await api.login();
  const visibleCmid = mintClientMessageId();
  const revokedCmid = mintClientMessageId();

  try {
    // 预置两条 user 行(可见 / 将被 revoke),供错误投影按 clientMessageId 归属。
    const put = await api.putSession(token, sid, {
      title: 'e2e-error-projection',
      model: cfg.model,
      messages: [
        { id: visibleCmid, role: 'user', text: 'e2e-errproj 可见:这条应出未计费错误卡' },
        { id: revokedCmid, role: 'user', text: 'e2e-errproj 撤销:这条的错误卡不应出现' },
      ],
    });
    expect(put.ok, `putSession: ${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();

    const detail = await api.getSession(token, sid);
    const seqOf = (cmid: string): number => {
      const m = detail.messages.find((x: any) => x.id === cmid || x._clientMessageId === cmid);
      return Number(m?._seq ?? 0);
    };
    seedErrorProjection(userId, sid, {
      visibleCmid,
      visibleSeq: seqOf(visibleCmid) || 1,
      revokedCmid,
      revokedSeq: seqOf(revokedCmid) || 2,
    });

    await loginViaUi(page);
    await openSession(page, sid);

    // 可见:未计费错误卡文案 + 重试。
    await expect(page.getByText(TEXT.dispatchLostTitle).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TEXT.notCharged).first()).toBeVisible();
    const retryable =
      (await SEL.retryInlineBtn(page).count()) > 0 || (await SEL.retryBannerBtn(page).count()) > 0;
    expect(retryable, '未计费错误卡应可重试').toBeTruthy();

    // revoked:active 投影只 1 条 → 未计费错误卡恰好 1 张(revoked 不显示)。
    await expect(
      page.getByText(TEXT.dispatchLostTitle),
      'revoked 投影不应渲染错误卡(仅可见那条 1 张)',
    ).toHaveCount(1);
  } catch (err) {
    if (err instanceof SeedUnavailable) {
      test.skip(true, `§9 注入失败,跳过:${err.message}`);
      return;
    }
    throw err;
  } finally {
    await api.deleteSession(token, sid).catch(() => {});
    cleanupSeed(sid);
  }
});

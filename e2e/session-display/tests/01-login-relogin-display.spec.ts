// 用例 1(@smoke):登录 → 建会话 → 发消息收回复 → 登出 → 重登 →
//   断言会话列表含该会话、打开后消息完整(user+assistant 行都在、顺序对)。
// 回归目标:重登后大会话白屏 / 丢 turn / 列表缺失。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import {
  loginViaUi,
  logoutViaUi,
  openSession,
  selectExactModel,
  sendMessage,
  waitForTurnSettled,
  waitForHistoryLoaded,
  SEL,
  rowSequence,
  userTexts,
  assistantTexts,
} from '../lib/ui';

/** 行内正文比较前统一空白(渲染换行/缩进差异不算内容漂移)。 */
function normalizeTexts(rows: string[]): string[] {
  return rows.map((row) => row.replace(/\s+/g, ' ').trim());
}

test('@smoke login → 会话 → 发送 → 重登后展示完整且顺序正确', async ({ page, api, token, track }) => {
  const cfg = config();
  const uniq = Date.now().toString(36);
  const sid = mintSessionId('login');
  const title = `e2e-login-${uniq}`;
  const marker = `e2e-marker-${uniq} 请只回复两个字:收到`;
  track(sid);

  const login = await api.login();
  expect(BigInt(login.credits), '登录响应必须已有可用额度，不依赖后续 /api/me').toBeGreaterThan(0n);

  // ── 预建会话(控制 id + 唯一标题,便于列表定位与清理)。turn 本身走真实 UI 发送。
  const put = await api.putSession(token, sid, { title, model: cfg.model });
  expect(put.ok, `putSession 失败: ${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();

  // ── 首次登录 + 打开会话 + 真实发送一轮 ──────────────────────────────────
  await loginViaUi(page);
  await openSession(page, sid);
  await selectExactModel(page, cfg.model);
  track(sid, { expectTurn: true });
  await sendMessage(page, marker);

  const outcome1 = await waitForTurnSettled(page);
  expect(outcome1, '首轮应正常出回复(非错误卡)').toBe('reply');

  await expect(SEL.userRows(page).filter({ hasText: `e2e-marker-${uniq}` })).toHaveCount(1);
  await expect(SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).first()).toBeVisible();
  const seq1 = await rowSequence(page);
  expect(seq1[0], '首条应为 user 行').toBe('user');
  expect(seq1.includes('assistant'), '应存在 assistant 行').toBeTruthy();
  // 重登前的完整快照:行全序 + 正文。重登后必须逐条一致(见下方对照)。
  const usersBefore = normalizeTexts(await userTexts(page));
  const assistantsBefore = normalizeTexts(await assistantTexts(page));
  expect(assistantsBefore.every((text) => text.length > 0), '重登前 assistant 正文不得为空').toBeTruthy();

  // API 佐证:会话已落库、含 user+assistant。
  const detail = await api.getSession(token, sid);
  expect(detail.messages.length, '服务端应至少有 user+assistant 两条').toBeGreaterThanOrEqual(2);

  // ── 登出 → 重登 ─────────────────────────────────────────────────────────
  await logoutViaUi(page);
  await loginViaUi(page);

  // 列表含该会话:API + UI 侧栏(唯一标题按钮)双重断言。
  const list = await api.listSessions(token);
  expect(list.some((s) => s.id === sid), '重登后 API 会话列表应含该会话').toBeTruthy();

  const sidebarBtn = page.getByRole('button', { name: title });
  await expect(sidebarBtn, '侧栏应出现该会话(按唯一标题)').toBeVisible({ timeout: 15_000 });

  // 从列表点击打开(走真实 list→open 路径),断言消息完整 + 顺序。
  await sidebarBtn.click();
  await waitForHistoryLoaded(page);
  await expect(SEL.userRows(page).filter({ hasText: `e2e-marker-${uniq}` })).toHaveCount(1);
  await expect(SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).first()).toBeVisible();
  // 全序 + 正文双重对照(对照 08 的 toEqual(['team','permission','assistant']) 写法)。
  // 只验"在场"是不够的:indexOf('user') < indexOf('assistant') 允许正文被替换成占位符、
  // 被截断、或多轮顺序错乱 —— 而 INC-20260717-HISTORY-STUCK 正是"重登后内容不对"。
  const seq2 = await rowSequence(page);
  expect(seq2, '重登后消息行全序必须与重登前逐条一致').toEqual(seq1);
  expect(normalizeTexts(await userTexts(page)), '重登后 user 正文必须逐条一致').toEqual(usersBefore);
  expect(normalizeTexts(await assistantTexts(page)), '重登后 assistant 正文必须逐条一致(不得占位/截断)')
    .toEqual(assistantsBefore);
});

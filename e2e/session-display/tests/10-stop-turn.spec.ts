// 用例 10:失控 turn 的唯一逃生口 —— 真浏览器受信点击「停止」。
//
// 为什么必须是活体用例(2026-07-26 门禁审计):
//   · INC-20260725-STOP-RETRY-LINEAGE 的回归只到 gateway/web-react unit 层,proofPending
//     写的就是"真浏览器受信点击 Stop 的活体用例待补"。
//   · SEL.stopBtn 早在 lib/ui.ts 定义,却**从未被任何 spec 引用** —— 半成品防线:
//     发送/停止是同一个按钮(Composer 按 busy 翻 aria-label),它坏掉的用户表现是
//     "点了没反应 + 继续计费",直接触发投诉与退款,而所有既有活体用例都只走"发→等回复"。
//
// 本用例锁四条**用户可见行为契约**(不锁任何实现细节):
//   ① 长 turn 执行中,composer 必须给出「停止」入口(没有 = 用户无法中断);
//   ② 受信点击后 3s 内进终态:「停止」消失、「发送」回归;
//   ③ 终态后不再有增量帧(助手行数/正文长度/流式光标 在观察窗内完全不动);
//   ④ 停止请求后不额外计费、不复活:该会话的 durable dispatch 恒 1 条且收敛到终态,
//      绑定它的 usage 行不超过 1 条且在观察窗内不再增长;刷新后不自动重启本轮。
// 另加"可重来":用户原文必须保留、composer 可再次发送(停止不等于把输入吞掉)。

import { test, expect } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { queryScalar } from '../lib/pg';
import { pollUntil, sleep } from '../lib/poll';
import {
  loginViaUi,
  openSession,
  selectExactModel,
  sendMessage,
  streamSnapshot,
  waitForHistoryLoaded,
  waitForTurnBusy,
  SEL,
} from '../lib/ui';

/** 终态判据窗口:boss 口径"点了要在 3 秒内有反应"。 */
const STOP_SETTLE_MS = 3_000;
/** 终态后的静默观察窗:证明"不再有增量帧" + "不再增长的计费"。 */
const QUIET_WINDOW_MS = 3_000;
const QUIET_SAMPLE_MS = 500;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 该会话的 durable dispatch 状态快照(条数 + 状态集合 + 绑定的 usage 行数)。 */
function dispatchEvidence(userId: string, sid: string): {
  dispatches: number;
  openDispatches: number;
  statuses: string;
  outcomes: string;
  tapes: number;
  tapeStatuses: string;
  tapeErrorCodes: string;
  usageRows: number;
  usageTerminalCodes: string;
} {
  const raw = queryScalar(`
    SELECT json_build_object(
      'dispatches',(SELECT count(*) FROM turn_dispatches d
                     WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}),
      'openDispatches',(SELECT count(*) FROM turn_dispatches d
                         WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}
                           AND d.status IN ('admitted','accepted','rejecting')),
      'statuses',(SELECT COALESCE(string_agg(DISTINCT d.status,','),'') FROM turn_dispatches d
                   WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}),
      'outcomes',(SELECT COALESCE(string_agg(DISTINCT d.outcome,','),'') FROM turn_dispatches d
                   WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}),
      'tapes',(SELECT count(*) FROM client_session_turn_tapes t
                 JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
                WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}
                  AND t.finalized_at IS NOT NULL),
      'tapeStatuses',(SELECT COALESCE(string_agg(DISTINCT t.status,','),'')
                        FROM client_session_turn_tapes t
                        JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
                       WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}
                         AND t.finalized_at IS NOT NULL),
      'tapeErrorCodes',(SELECT COALESCE(string_agg(DISTINCT
                           convert_from(COALESCE(r.visible_payload,r.payload),'UTF8')::jsonb->>'_errorCode',','),'')
                          FROM client_session_turn_tape_records r
                          JOIN client_session_turn_tapes t
                            ON t.session_id=r.session_id AND t.user_id=r.user_id AND t.tape_id=r.tape_id
                          JOIN turn_dispatches d ON d.dispatch_id=t.dispatch_id
                         WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}
                           AND convert_from(COALESCE(r.visible_payload,r.payload),'UTF8')::jsonb ? '_errorCode'),
      'usageRows',(SELECT count(*) FROM usage_records ur
                     JOIN turn_dispatches d ON d.dispatch_id=ur.dispatch_id
                    WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)}),
      'usageTerminalCodes',(SELECT COALESCE(string_agg(DISTINCT
                              ur.price_snapshot->>'codex_terminal_code',','),'')
                              FROM usage_records ur
                              JOIN turn_dispatches d ON d.dispatch_id=ur.dispatch_id
                             WHERE d.user_id=${userId} AND d.session_id=${sqlText(sid)})
    )::text
  `);
  const parsed = JSON.parse(raw) as {
    dispatches: number;
    openDispatches: number;
    statuses: string;
    outcomes: string;
    tapes: number;
    tapeStatuses: string;
    tapeErrorCodes: string;
    usageRows: number;
    usageTerminalCodes: string;
  };
  return parsed;
}

test('停止:3s 内进终态 + 不再有增量帧 + 不额外计费不复活', async ({ page, api, token, track }) => {
  const cfg = config();
  const uniq = Date.now().toString(36);
  const sid = mintSessionId('stop');
  const marker = `e2e-stop-${uniq}`;
  const userId = await api.currentUserId(token);
  track(sid);

  const put = await api.putSession(token, sid, { title: `e2e-stop-${uniq}`, model: cfg.model });
  expect(put.ok, `putSession 失败: ${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();

  await loginViaUi(page);
  await openSession(page, sid);
  await selectExactModel(page, cfg.model);

  // ── ① 长 turn:必须给出「停止」入口 ───────────────────────────────────────
  // 提示词刻意长到两个底座都不可能秒完(数到 2000),让停止窗口足够宽;
  // 断言的却不是"它有多慢",而是"执行中一定存在中断入口"。
  track(sid, { expectTurn: true });
  await sendMessage(page, `${marker} 请从 1 数到 2000，每行一个数字，不要省略、不要总结。`);
  await waitForTurnBusy(page);

  // 等到"确有产出或明确在生成中"再停:停在完全无输出的瞬间走的是另一条路径,
  // 而用户抱怨的场景是"已经在刷字了但停不下来"。60s 内既无正文又无生成指示 =
  // 本身就是静默 turn,让门红。
  await pollUntil(
    async () => {
      const snap = await streamSnapshot(page);
      if (snap.assistantChars > 0 || snap.carets > 0) return true;
      return (await SEL.typing(page).count()) > 0;
    },
    { timeoutMs: 60_000, intervalMs: 500, label: '长 turn 开始产出(正文/流式光标/生成中指示)' },
  );

  // ── ② 受信点击「停止」→ 3s 内终态 ────────────────────────────────────────
  await expect(
    SEL.stopBtn(page),
    '点击前「停止」必须仍在场(否则本轮已自行结束,提示词需要更长)',
  ).toBeVisible();
  const clickedAt = Date.now();
  await SEL.stopBtn(page).click();

  await expect(
    SEL.stopBtn(page),
    `点击「停止」后 ${STOP_SETTLE_MS}ms 内必须退出执行态(按钮不得继续停在「停止」)`,
  ).toHaveCount(0, { timeout: STOP_SETTLE_MS });
  await expect(
    SEL.sendBtn(page),
    '停止后 composer 必须回到「发送」形态(用户可以立刻重来)',
  ).toBeVisible({ timeout: STOP_SETTLE_MS });
  const settleMs = Date.now() - clickedAt;
  test.info().annotations.push({ type: 'stop-settle-ms', description: String(settleMs) });

  // ── ③ 终态后不再有增量帧 ────────────────────────────────────────────────
  // 这里的固定观察窗是**必要的**:要证明的是"某件事不再发生",没有可轮询的正向条件。
  const baseline = await streamSnapshot(page);
  expect(baseline.carets, '停止后不得残留流式光标(视觉上仍在打字 = 用户以为没停)').toBe(0);
  const samples = Math.ceil(QUIET_WINDOW_MS / QUIET_SAMPLE_MS);
  for (let i = 0; i < samples; i++) {
    await sleep(QUIET_SAMPLE_MS);
    const now = await streamSnapshot(page);
    expect(
      now,
      `停止后第 ${i + 1} 次取样出现增量(帧仍在写入 = 停止没有真正切断本轮)`,
    ).toEqual(baseline);
  }

  // ── ④ 计费面 + 不复活 ───────────────────────────────────────────────────
  // durable dispatch 必须收敛到终态(不留 open 行),否则 reconciler 侧会把它当悬挂轮次。
  const settled = await pollUntil(
    async () => {
      const evidence = dispatchEvidence(userId, sid);
      return evidence.dispatches > 0 && evidence.openDispatches === 0 ? evidence : null;
    },
    { timeoutMs: 60_000, intervalMs: 1_000, label: '停止后 durable dispatch 收敛到终态' },
  );
  expect(settled.dispatches, '一次发送 + 一次停止只应留一条 dispatch(多出来 = 被重试复活)').toBe(1);
  expect(
    settled.statuses.split(',').every((status) => status === 'terminal' || status === 'manual_reconcile'),
    `dispatch 未落终态: ${settled.statuses}`,
  ).toBeTruthy();
  expect(
    ['interrupted', 'completed'],
    `Stop 请求只能收敛为 interrupted，或由竞态中的自然 end_turn 先收敛为 completed: ${settled.outcomes}`,
  ).toContain(settled.outcomes);
  expect(settled.tapes, '一次被停止的 turn 必须恰好落一卷 immutable tape').toBe(1);
  if (settled.outcomes === 'interrupted') {
    expect(settled.tapeStatuses, '中断终态的 tape header 必须是 interrupted').toBe('interrupted');
    expect(
      settled.tapeErrorCodes.toUpperCase(),
      '中断终态的稳定错误码必须归一到 user_cancelled',
    ).toBe('USER_CANCELLED');
  } else {
    // Stop 点击和自然 end_turn 可以竞速；若自然完成先落权威终态，不能把完整答复改写成取消。
    // 用户契约仍由上面的 3s 退出执行态、静默窗，以及下面的不复活/不重复计费共同锁定。
    expect(settled.tapeStatuses, '自然完成竞态的 tape header 必须与 outcome 一致').toBe('completed');
    expect(
      settled.tapeErrorCodes.toUpperCase(),
      '自然完成竞态不得伪造 USER_CANCELLED 错误',
    ).not.toContain('USER_CANCELLED');
  }
  expect(
    settled.usageRows,
    '一次被停止的 turn 至多结算一笔(≥2 = 停止后仍在继续计费)',
  ).toBeLessThanOrEqual(1);
  if (cfg.model === 'gpt-5.6-luna' && settled.usageRows > 0) {
    if (settled.outcomes === 'interrupted') {
      expect(
        settled.usageTerminalCodes,
        'Codex 强制停止的 usage 审计必须归类为 USER_CANCELLED，不能记成模型失败',
      ).toBe('USER_CANCELLED');
    } else {
      expect(
        settled.usageTerminalCodes,
        '自然完成竞态的 usage 审计不得伪装成 USER_CANCELLED',
      ).not.toBe('USER_CANCELLED');
    }
  }

  // 静默窗内计费与 dispatch 都不得再长:这才是"点了停止就不再花钱"。
  for (let i = 0; i < samples; i++) {
    await sleep(QUIET_SAMPLE_MS);
    const now = dispatchEvidence(userId, sid);
    expect(now.usageRows, `停止后第 ${i + 1} 次取样计费行增长(仍在扣费)`).toBe(settled.usageRows);
    expect(now.dispatches, `停止后第 ${i + 1} 次取样 dispatch 增长(本轮被复活)`).toBe(settled.dispatches);
  }

  // ── 刷新后不自动重启本轮(Stop 围栏跨刷新持久) ──────────────────────────
  await openSession(page, sid);
  await waitForHistoryLoaded(page);
  await expect(
    SEL.stopBtn(page),
    '刷新后又回到执行态:被用户停止的轮次被自动恢复重跑(围栏失效)',
  ).toHaveCount(0, { timeout: 5_000 });
  const afterReload = dispatchEvidence(userId, sid);
  expect(afterReload.dispatches, '刷新触发了新的 dispatch(停止轮次被自动重发)').toBe(settled.dispatches);

  // ── 可重来:原文保留 + composer 可再次发送 ──────────────────────────────
  await expect(
    SEL.userRows(page).filter({ hasText: marker }),
    '停止不得吞掉用户原文(输入必须留在时间线里)',
  ).toHaveCount(1);
  const box = SEL.composer(page);
  await box.click();
  await box.fill(`${marker} 复用检查(不发送)`);
  await expect(SEL.sendBtn(page), '停止后 composer 必须可再次发送').toBeEnabled({ timeout: 5_000 });
  await box.fill('');
});

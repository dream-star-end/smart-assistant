// 用例 8:把生产事故的原始 IndexedDB 形态直接种进 canary 浏览器：
// [user, final, agent-group×2, permission] + _maxSeq=2。历史接口返回真实事故同款
// `?since=2` 空 partial，断言 loadStored/empty incremental 自愈、DOM 顺序正确、修复写回
// IndexedDB，第二次 reload 仍稳定。全程只碰 canary 自己的 e2e-* 会话。

import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { SEL, loginViaUi, waitForHistoryLoaded } from '../lib/ui';

type StoredSnapshot = {
  id: string;
  agentId: string;
  title: string;
  messages: Array<Record<string, unknown>>;
  createdAt: number;
  lastAt: number;
  updatedAt: number;
  _maxSeq: number;
  _historyRevision: number;
};

function dbNameForUser(userId: string): string {
  return `ocv5_sessions__${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}

async function putStored(page: Page, userId: string, snapshot: StoredSnapshot): Promise<void> {
  await page.evaluate(
    async ({ dbName, value }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('sessions')) {
            request.result.createObjectStore('sessions');
          }
        };
        request.onerror = () => reject(request.error ?? new Error('open IndexedDB failed'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put(value, value.id);
          tx.onerror = () => reject(tx.error ?? new Error('put IndexedDB failed'));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    },
    { dbName: dbNameForUser(userId), value: snapshot },
  );
}

async function getStored(page: Page, userId: string, sessionId: string): Promise<StoredSnapshot | null> {
  return page.evaluate(
    async ({ dbName, key }) =>
      new Promise<StoredSnapshot | null>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error ?? new Error('open IndexedDB failed'));
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('sessions', 'readonly').objectStore('sessions').get(key);
          get.onerror = () => reject(get.error ?? new Error('get IndexedDB failed'));
          get.onsuccess = () => {
            db.close();
            resolve((get.result as StoredSnapshot | undefined) ?? null);
          };
        };
      }),
    { dbName: dbNameForUser(userId), key: sessionId },
  );
}

async function visibleProcessOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="team-panel"], [data-testid="permission-card"], [data-testid="assistant-row"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const testId = node.getAttribute('data-testid');
        if (testId === 'team-panel') return 'team';
        if (testId === 'permission-card') return 'permission';
        return 'assistant';
      }),
    );
}

test('poisoned IDB + empty incremental：过程卡在最终答复前且修复可持久化', async ({
  page,
  api,
  token,
  track,
}) => {
  const cfg = config();
  const sid = mintSessionId('postfinal');
  const suffix = Date.now().toString(36);
  const title = `e2e-post-final-${suffix}`;
  const userId = await api.currentUserId(token);
  const userMessageId = `m-user-${suffix}`;
  const finalText = `最终答复-${suffix}`;
  const now = Date.now();
  track(sid);

  // 先登录再造目标会话，避免当前页面在 seed 前把目标 session shell 放进内存，pagehide
  // flush 时反向覆盖刚写入的 poison。
  await loginViaUi(page);

  const poisoned: StoredSnapshot = {
    id: sid,
    agentId: 'main',
    title,
    createdAt: now - 5000,
    lastAt: now,
    updatedAt: now,
    _maxSeq: 2,
    _historyRevision: 7,
    messages: [
      {
        id: userMessageId,
        role: 'user',
        text: `请排查-${suffix}`,
        ts: now - 4000,
        status: 'replied',
        _source: 'server',
        _seq: 1,
        _orderSeq: 1,
      },
      {
        id: `srv-final-${suffix}`,
        role: 'assistant',
        text: finalText,
        ts: now - 1000,
        _source: 'server',
        _seq: 2,
        _orderSeq: 2,
        _clientMessageId: userMessageId,
      },
      {
        id: `m-team-a-${suffix}`,
        role: 'agent-group',
        text: '排查前端恢复',
        ts: now - 3000,
        _delegate: true,
        _delegateAgentId: 'coding-assistant',
        _delegateGoal: '排查前端恢复',
        _completed: true,
        childBlocks: [{ kind: 'text', text: '前端检查完成' }],
      },
      {
        id: `m-team-b-${suffix}`,
        role: 'agent-group',
        text: '排查历史同步',
        ts: now - 2500,
        _delegate: true,
        _delegateAgentId: 'research-assistant',
        _delegateGoal: '排查历史同步',
        _completed: true,
        childBlocks: [{ kind: 'text', text: '同步检查完成' }],
      },
      {
        id: `m-permission-${suffix}`,
        role: 'permission',
        text: 'AskUserQuestion',
        ts: now - 2000,
        requestId: `req-${suffix}`,
        toolName: 'AskUserQuestion',
        inputJson: { questions: [{ question: '是否继续？', options: [{ label: '继续' }] }] },
        _resolved: true,
        _behavior: 'deny',
        _settledReason: 'disconnect',
      },
    ],
  };
  await putStored(page, userId, poisoned);

  const seenSessionGets: string[] = [];
  const serverUpdatedAt = now + 1000;
  await page.route(`**/api/sessions/${sid}*`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== `/api/sessions/${sid}`) {
      await route.continue();
      return;
    }
    seenSessionGets.push(url.toString());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: sid,
        agentId: 'main',
        title,
        messages: [],
        isPartial: true,
        maxSeq: 2,
        historyRevision: 7,
        archivedThroughSeq: 0,
        archivedCount: 0,
        updatedAt: serverUpdatedAt,
        modelId: cfg.model,
      }),
    });
  });

  // 目标 server row 在当前 app 已登录后才创建；下一次深链 boot 同时拿到 list row + IDB poison。
  const put = await api.putSession(token, sid, { title, model: cfg.model });
  expect(put.ok, `putSession 失败:${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();

  await page.goto(`${cfg.baseUrl}/s/${sid}`, { waitUntil: 'domcontentloaded' });
  await waitForHistoryLoaded(page);
  await expect(SEL.teamPanel(page)).toBeVisible();
  await expect(SEL.permissionCard(page)).toContainText('用户问答');
  await expect(SEL.assistantRows(page).filter({ hasText: finalText })).toHaveCount(1);
  expect(await visibleProcessOrder(page)).toEqual(['team', 'permission', 'assistant']);

  await expect
    .poll(
      () =>
        seenSessionGets.some((raw) => {
          const url = new URL(raw);
          return url.searchParams.get('since') === '2' && url.searchParams.get('since_history_revision') === '7';
        }),
      { timeout: 15_000, message: '历史恢复必须实际发出 ?since=2 的空 incremental 请求' },
    )
    .toBe(true);

  const expectedIds = [
    userMessageId,
    `m-team-a-${suffix}`,
    `m-team-b-${suffix}`,
    `m-permission-${suffix}`,
    `srv-final-${suffix}`,
  ];
  await expect
    .poll(async () => (await getStored(page, userId, sid))?.messages.map((message) => message.id), {
      timeout: 15_000,
      message: '修复后的顺序应立即写回 IndexedDB',
    })
    .toEqual(expectedIds);
  const repairedStored = await getStored(page, userId, sid);
  expect(repairedStored?.messages.slice(1, 4).map((message) => message._turnOwnerId)).toEqual([
    userMessageId,
    userMessageId,
    userMessageId,
  ]);

  // App 会把已消费的深链规范化为根路由；第二次 boot 必须重新深链同一目标会话，
  // 才能证明已迁移快照稳定，而不是误刷新到最近打开的其它会话。
  await page.goto(`${cfg.baseUrl}/s/${sid}`, { waitUntil: 'domcontentloaded' });
  await waitForHistoryLoaded(page);
  await expect(SEL.teamPanel(page)).toBeVisible();
  await expect(SEL.permissionCard(page)).toBeVisible();
  await expect(SEL.assistantRows(page).filter({ hasText: finalText })).toHaveCount(1);
  expect(await visibleProcessOrder(page)).toEqual(['team', 'permission', 'assistant']);
  const secondBootStored = await getStored(page, userId, sid);
  expect(secondBootStored?.messages.map((message) => message.id)).toEqual(expectedIds);
  expect(secondBootStored?.messages.slice(1, 4).map((message) => message._turnOwnerId)).toEqual([
    userMessageId,
    userMessageId,
    userMessageId,
  ]);
});

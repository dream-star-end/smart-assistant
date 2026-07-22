// Playwright fixtures:每条用例拿到 api 客户端 + 新鲜 API token(setup/校验/清理用),
// 并注册"用后即删"的 e2e- 会话清理(绝不留脏数据到 canary/预发账号)。

import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { Api } from './lib/api';

export interface TestFixtures {
  token: string;
  /** 注册需要清理的会话 id(测试结束自动 DELETE)。 */
  track: (sessionId: string) => void;
  page: Page;
}

export interface WorkerFixtures {
  api: Api;
  sharedContext: BrowserContext;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  api: [async ({}, use) => {
    await use(new Api());
  }, { scope: 'worker' }],
  sharedContext: [async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  }, { scope: 'worker' }],
  page: async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    try {
      await use(page);
    } finally {
      // 断线回归会切整个 context 离线；失败中断也必须恢复，不能污染下一条用例。
      await sharedContext.setOffline(false).catch(() => {});
      await page.close().catch(() => {});
    }
  },
  token: async ({ api }, use) => {
    const { token } = await api.login();
    await use(token);
  },
  track: async ({ api, token }, use) => {
    const ids: string[] = [];
    await use((id: string) => {
      if (!ids.includes(id)) ids.push(id);
    });
    // teardown:逐个删,失败不阻塞(会话可能已被前序步骤删除)。
    for (const id of ids) {
      await api.deleteSession(token, id).catch(() => {});
    }
  },
});

export { expect } from '@playwright/test';

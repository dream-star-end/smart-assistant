// 浏览器 UI 助手 + 选择器常权威(来源:e2e/session-display/SELECTORS.md,调研 agent 交付)。
// 断言优先"用户可见行为"(testid/role/文案),此处收口所有定位,spec 不散落魔法字符串。
//
// 深链:/s/<sessionId>(useAppRoute.parseSessionPath,routing 默认开)。

import { type Locator, type Page, expect } from '@playwright/test';
import { config } from './env';

export const SEL = {
  // 登录(营销页 → AuthGate)
  loginOpenBtn: (p: Page): Locator => p.getByRole('button', { name: '登录' }).first(),
  emailInput: (p: Page): Locator => p.getByPlaceholder('邮箱'),
  passwordInput: (p: Page): Locator => p.getByLabel('密码'),
  // 工作区就绪判据(视图态切换,非 URL):composer 或"新建会话"出现。
  // composer 占位符随 agent 变化(如"和「全能助手」对话…"/"给 OpenClaude 发消息…"),
  // 用 role+正则匹配对话/发消息,排除"搜索会话"框(含"会话"而非"对话")。
  composer: (p: Page): Locator => p.getByRole('textbox', { name: /对话|发消息/ }).first(),
  newSessionBtn: (p: Page): Locator => p.getByRole('button', { name: '新建会话' }).first(),
  sendBtn: (p: Page): Locator => p.getByRole('button', { name: '发送' }),
  stopBtn: (p: Page): Locator => p.getByRole('button', { name: '停止' }),
  // 消息行:优先本批新增 data-testid;回退到既有稳定 class 锚点(同一元素同时命中
  // testid 与 class → union 去重为一个,绝不祖先/后代双计)。这样套件对"含 testid 的本
  // 分支构建"与"尚未部署 testid 的现网构建"都能跑。
  userRows: (p: Page): Locator =>
    p.locator('[data-testid="user-row"], .flex.flex-col.items-end:has(.bg-bubble)'),
  assistantRows: (p: Page): Locator =>
    p.locator('[data-testid="assistant-row"], .group.flex.gap-4:has(.prose)'),
  messageText: (p: Page): Locator => p.locator('[data-testid="message-text"], .bg-bubble'),
  // 已有稳定锚点
  typing: (p: Page): Locator => p.locator('[aria-label="生成中"]'),
  historySkeleton: (p: Page): Locator => p.locator('[aria-label="正在加载会话历史"]'),
  turnProcessCard: (p: Page): Locator => p.getByTestId('turn-process-card'),
  teamPanel: (p: Page): Locator => p.getByTestId('team-panel'),
  permissionCard: (p: Page): Locator => p.getByTestId('permission-card'),
  // 侧栏会话项
  selectedSession: (p: Page): Locator => p.locator('[aria-current="true"]'),
  // 错误卡
  errorBanner: (p: Page): Locator => p.getByRole('alert'),
  retryExactBtn: (p: Page): Locator => p.getByRole('button', { name: '重试', exact: true }),
  retryActionBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /^(?:重试|重新尝试|重试发送)$/ }),
  // 历史分页(本地/云端两种文案)
  loadMoreLocal: (p: Page): Locator => p.getByRole('button', { name: /加载更多历史/ }),
  loadMoreCloud: (p: Page): Locator => p.getByRole('button', { name: /从云端加载更早的历史/ }),
};

/** 用户可见的错误文案(§5/错误卡契约)。 */
export const TEXT = {
  dispatchLostTitle: '消息未开始处理',
  notCharged: '已确认未计费',
  serviceRestart: '服务重启，本轮已中断',
  sendFailedBanner: '发送失败',
};

/** UI 登录:填表 → 提交(form onSubmit)→ 断言工作区元素出现(非 URL)。 */
export async function loginViaUi(page: Page): Promise<void> {
  const cfg = config();
  await page.goto(`${cfg.baseUrl}/`, { waitUntil: 'domcontentloaded' });

  // 共享 context 的新页面若带真实 HttpOnly refresh cookie，会先静默续登。只在确有
  // cookie 时等待 boot 收敛到工作区或明确登录面，避免与合法的慢 refresh 竞态。
  const hasRefreshCookie = (await page.context().cookies())
    .some((cookie) => cookie.name === 'oc_rt');
  if (hasRefreshCookie) {
    await expect.poll(async () => {
      if (await SEL.composer(page).isVisible().catch(() => false)) return 'workspace';
      if (
        await SEL.emailInput(page).isVisible().catch(() => false) ||
        await SEL.loginOpenBtn(page).isVisible().catch(() => false)
      ) return 'auth';
      return 'pending';
    }, { timeout: 70_000 }).not.toBe('pending');
    if (await SEL.composer(page).isVisible().catch(() => false)) return;
  }

  // 营销页 → 打开 AuthGate(若邮箱框未直接出现)。
  if (!(await SEL.emailInput(page).isVisible().catch(() => false))) {
    await SEL.loginOpenBtn(page).click().catch(() => {});
  }
  await expect(SEL.emailInput(page)).toBeVisible({ timeout: 15_000 });
  await SEL.emailInput(page).fill(cfg.email);
  await SEL.passwordInput(page).fill(cfg.password);
  // turnstile bypass:AuthGate 自动发 BYPASS_TOKEN='bypass',无需操作 widget。
  await SEL.passwordInput(page).press('Enter');

  // 成功判据 = 工作区元素出现(composer 或 新建会话),非 URL 跳转。
  await expect(SEL.composer(page).or(SEL.newSessionBtn(page)).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * 登出。auth = HttpOnly refresh cookie(reload 会静默续登),故必须:点真实"退出登录"
 * 按钮(吊销 refresh)+ clearCookies(兜底丢 cookie),否则 reload 仍处登录态。
 */
export async function logoutViaUi(page: Page): Promise<void> {
  const logout = page.getByRole('button', { name: '退出登录' });
  if (await logout.count()) {
    await logout.first().click().catch(() => {});
    const confirm = page.getByRole('button', { name: /^(确定|确认|退出登录|退出)$/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  }
  // 兜底:丢 HttpOnly refresh cookie + 本地态,保证真正登出(否则 refresh cookie 自动续登)。
  await page.context().clearCookies();
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${config().baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await expect(SEL.emailInput(page).or(SEL.loginOpenBtn(page)).first()).toBeVisible({ timeout: 15_000 });
}

/** 深链打开一个已知会话并等历史加载完成。 */
export async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${config().baseUrl}/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await waitForHistoryLoaded(page);
}

/** 历史加载完成判据:骨架屏消失 ∧ (出现任一消息行 或 明确空态 composer 就绪)。 */
export async function waitForHistoryLoaded(page: Page): Promise<void> {
  await expect(SEL.historySkeleton(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(SEL.composer(page)).toBeVisible({ timeout: 20_000 });
}

/** 在 composer 输入并点发送。 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const box = SEL.composer(page);
  await box.click();
  await box.fill(text);
  await expect(SEL.sendBtn(page)).toBeEnabled({ timeout: 5_000 });
  await SEL.sendBtn(page).click();
}

/**
 * 等一轮 assistant 回复到终态:typing("生成中")消失 ∧ 至少一条 assistant 行有正文,
 * 或出现终态错误卡。返回 'reply' | 'error'。轮询实现,不死 sleep。
 */
export async function waitForTurnSettled(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<'reply' | 'error'> {
  const timeout = opts.timeoutMs ?? config().turnTimeoutMs;
  const deadline = Date.now() + timeout;
  for (;;) {
    // 终态错误卡(内联 or 横幅)
    const hasError =
      (await page.getByText(TEXT.dispatchLostTitle).count()) > 0 ||
      (await page.getByText(TEXT.serviceRestart).count()) > 0 ||
      (await SEL.retryActionBtn(page).count()) > 0;
    if (hasError) return 'error';

    const typingGone = (await SEL.typing(page).count()) === 0;
    const assistantWithText =
      (await SEL.assistantRows(page).locator('.prose').filter({ hasText: /\S/ }).count()) > 0;
    if (typingGone && assistantWithText) return 'reply';

    if (Date.now() >= deadline) {
      throw new Error(`[ui] waitForTurnSettled 超时 ${timeout}ms:既无 assistant 正文也无错误卡(疑似永久静默)`);
    }
    await page.waitForTimeout(500);
  }
}

/** 读取当前会话所有 user 行文本(顺序)。 */
export async function userTexts(page: Page): Promise<string[]> {
  const n = await SEL.userRows(page).count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(((await SEL.userRows(page).nth(i).innerText()) || '').trim());
  }
  return out;
}

/** 按 DOM 顺序返回消息行类型序列('user' | 'assistant'),用于断言顺序正确。 */
export async function rowSequence(page: Page): Promise<Array<'user' | 'assistant'>> {
  const rows = page.locator(
    '[data-testid="user-row"], [data-testid="assistant-row"], .flex.flex-col.items-end:has(.bg-bubble), .group.flex.gap-4:has(.prose)',
  );
  const n = await rows.count();
  const seq: Array<'user' | 'assistant'> = [];
  for (let i = 0; i < n; i++) {
    const node = rows.nth(i);
    const tid = await node.getAttribute('data-testid');
    if (tid === 'user-row' || tid === 'assistant-row') {
      seq.push(tid === 'user-row' ? 'user' : 'assistant');
      continue;
    }
    // 无 testid:按内容锚点分类(用户气泡 .bg-bubble vs 助手正文 .prose)。
    const isUser = (await node.locator('.bg-bubble').count()) > 0;
    seq.push(isUser ? 'user' : 'assistant');
  }
  return seq;
}

/** 读取当前会话所有 assistant 行正文(顺序)。 */
export async function assistantTexts(page: Page): Promise<string[]> {
  const rows = SEL.assistantRows(page).locator('.prose');
  const n = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(((await rows.nth(i).innerText()) || '').trim());
  }
  return out;
}

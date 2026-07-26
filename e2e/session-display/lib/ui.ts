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
  // 发送/停止是**同一个按钮**(Composer 按 busy 翻 aria-label)。必须 exact:非 exact 的
  // getByRole name 是子串匹配,「停止」会同时命中「停止录音」「停止朗读」,「发送」会命中
  // 「重试发送」——两者都会让 busy 判据静默失真。
  sendBtn: (p: Page): Locator => p.getByRole('button', { name: '发送', exact: true }),
  stopBtn: (p: Page): Locator => p.getByRole('button', { name: '停止', exact: true }),
  /** 助手消息动作条的「重新生成」(仅最后一条助手消息、且非流式时出现)。 */
  regenerateBtn: (p: Page): Locator => p.getByRole('button', { name: '重新生成', exact: true }),
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
  teamPanel: (p: Page): Locator => p.getByTestId('team-panel'),
  permissionCard: (p: Page): Locator => p.getByTestId('permission-card'),
  // 侧栏会话项
  selectedSession: (p: Page): Locator => p.locator('[aria-current="true"]'),
  // 错误卡
  errorBanner: (p: Page): Locator => p.getByRole('alert'),
  retryExactBtn: (p: Page): Locator => p.getByRole('button', { name: '重试', exact: true }),
  retryActionBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /^(?:重试|重新尝试|重试发送)$/ }),
  // 历史分页(真实控件,MessageRenderer 的 history-page-loader)。
  //
  // 2026-07-26 审计:此处原本是 `加载更多历史` / `从云端加载更早的历史` 两个 role-name
  // 正则,而这两句文案在 packages/web-react 的**生产组件里一次都没渲染过**
  // (`loadOlderHistoryLabel` 只有 pure.ts 定义 + 单测引用,无组件调用点)。于是 06 的
  // UI 逐页断言恒 count()==0:while 循环从不进,负例 toHaveCount(0) 恒真 —— 双重假绿。
  // 真实控件是带 data-testid="history-page-loader" 的容器 + 其内单个按钮,文案四态见 TEXT。
  // (check-v5-e2e-selectors 只校验 testid/aria-label 字面量,role-name 文案不在其覆盖内,
  //  所以这类漂移只能靠"选择器一律指向 testid"来防,见 followup。)
  historyPageLoader: (p: Page): Locator => p.getByTestId('history-page-loader'),
  historyOlderBtn: (p: Page): Locator => p.getByTestId('history-page-loader').getByRole('button'),
};

/** 用户可见的错误文案(§5/错误卡契约)。 */
export const TEXT = {
  dispatchLostTitle: '消息未开始处理',
  notCharged: '已确认未计费',
  serviceRestart: '服务重启，本轮已中断',
  sendFailedBanner: '发送失败',
  /** 用户点停止后本轮的终态文案(render.ts ERROR_LABELS.stopped)。 */
  turnStopped: '已停止本轮生成',
  /** history-page-loader 按钮四态文案(MessageRenderer,单一权威在组件里)。 */
  historyOlder: '查看更早历史记录',
  historyEnd: '已到最早记录',
  historyLoading: '加载中…',
  historyLoadFailed: '加载失败，点击重试',
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

/** 通过真实顶栏选择器固定本轮模型；exact model id 是后端目录 ID，不依赖展示名。 */
export async function selectExactModel(page: Page, modelId: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(modelId)) {
    throw new Error(`[ui] 非法 model id: ${modelId}`);
  }
  const trigger = page.getByRole('button', { name: '选择对话模型' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const item = page.locator(`[data-model-id="${modelId}"]`);
  await expect(item, `模型菜单缺少 exact id ${modelId}`).toHaveCount(1);
  await expect(item).toBeVisible();
  const label = ((await item.locator('span').first().innerText()) || '').trim();
  if (!label) throw new Error(`[ui] 模型 ${modelId} 缺少可见标签`);
  await item.click();
  await expect(trigger).toContainText(label);
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

/** 当前页面上的终态错误指示计数(内联错误卡 + 重试按钮)。 */
async function errorIndicatorCount(page: Page): Promise<number> {
  const [dispatchLost, restarted, retry] = await Promise.all([
    page.getByText(TEXT.dispatchLostTitle).count(),
    page.getByText(TEXT.serviceRestart).count(),
    SEL.retryActionBtn(page).count(),
  ]);
  return dispatchLost + restarted + retry;
}

/**
 * 等一轮 assistant 回复到终态:typing("生成中")消失 ∧ 至少一条 assistant 行有正文,
 * 或**本轮新出现**终态错误卡。返回 'reply' | 'error'。轮询实现,不死 sleep。
 *
 * 为什么要基线(2026-07-26 审计):fixtures 的 sharedContext 是 worker scope,9 条用例
 * 共用一个 BrowserContext。原实现循环第一件事就是"页面上存在任意重试按钮 → 判 error",
 * 于是上一条用例遗留的错误卡会让本轮在 turn 还没开始时立刻返回 'error' —— 在接受
 * error 的用例里就是隐蔽假绿。现在只认"相对进入时基线新增"的错误指示。
 */
export async function waitForTurnSettled(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<'reply' | 'error'> {
  const timeout = opts.timeoutMs ?? config().turnTimeoutMs;
  const deadline = Date.now() + timeout;
  const errorBaseline = await errorIndicatorCount(page);
  for (;;) {
    // 终态错误卡(内联 or 横幅):必须比进入时更多,才算本轮产生的错误。
    if ((await errorIndicatorCount(page)) > errorBaseline) return 'error';

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

/**
 * 等本轮进入"执行中"(composer 的同一个按钮翻成「停止」)。这是**用户可见的唯一**
 * turn-in-flight 判据,也是「停止」这条逃生口存在的前提:按钮不出现就等于用户无法中断。
 * 轮询实现;超时抛(不 soft-fail —— 发不出去的 turn 必须让门变红)。
 */
export async function waitForTurnBusy(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 60_000;
  await expect(
    SEL.stopBtn(page),
    '发送后 composer 未翻出「停止」按钮:用户没有任何中断入口(失控 turn 无逃生口)',
  ).toBeVisible({ timeout });
}

/**
 * 本轮流式产出的可观测快照:助手行数 + 全部助手正文长度 + 流式光标数。
 * "点了停止之后不再有增量帧"的判据 = 两次快照完全相等(轮询取样,不死 sleep)。
 */
export interface StreamSnapshot {
  assistantRows: number;
  assistantChars: number;
  carets: number;
}
export async function streamSnapshot(page: Page): Promise<StreamSnapshot> {
  const texts = await assistantTexts(page);
  return {
    assistantRows: texts.length,
    assistantChars: texts.reduce((sum, text) => sum + text.length, 0),
    carets: await page.locator('.caret-blink').count(),
  };
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

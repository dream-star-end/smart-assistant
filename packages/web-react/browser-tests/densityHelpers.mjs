/**
 * Shared Playwright helpers extracted from run.mjs so browser-tests/run.mjs
 * stays strictly within the file-size ratchet while keeping every assertion intact.
 */

/**
 * 等元素及其祖先上的进场 CSS 动画（如 oc-dialog-in 210ms / oc-pop-in 140ms 的 scale 过渡）
 * 收尾后再量 boundingBox()，避免在首帧 scale(0.965/0.97) 时读到瞬时缩小值误报。
 */
export async function waitForAnimationsSettled(locator) {
  await locator.evaluate(async (node) => {
    const pending = [];
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      if (typeof el.getAnimations !== "function") continue;
      for (const anim of el.getAnimations()) {
        const timing = anim.effect?.getComputedTiming?.();
        if (timing && timing.iterations !== Number.POSITIVE_INFINITY) {
          pending.push(anim.finished.catch(() => {}));
        }
      }
    }
    if (pending.length > 0) await Promise.all(pending);
  });
}

/**
 * T41 Codex 密度 token 明暗主题断言（Composer / ToolCard / Sidebar / 账号菜单）。
 */
export async function assertCodexDensityTheme(page, theme) {
  await page.evaluate((next) => {
    document.documentElement.classList.toggle("dark", next === "dark");
  }, theme);

  // OCV5-822: Composer 外壳收敛为共享工艺类 oc-composer-dock（内含 1px 实体边框与 :focus-within 暖光晕）。
  const composerShell = page.locator("#root [data-testid='composer-shell']").first();
  const composerClass = (await composerShell.getAttribute("class")) ?? "";
  if (!composerClass.includes("oc-composer-dock")) {
    throw new Error(`Composer 缺少 oc-composer-dock 工艺类(${theme}): ${composerClass}`);
  }
  if (/(?:^|\s)border-border(?:\s|$)/.test(composerClass) || composerClass.includes("--shadow-float")) {
    throw new Error(`Composer 仍用分隔线 border-border 或浮层阴影(${theme}): ${composerClass}`);
  }
  const composerInput = composerShell.getByRole("textbox");
  await composerInput.blur();
  const unfocusedBorder = await composerShell.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.borderTopWidth, style: s.borderTopStyle, color: s.borderTopColor, shadow: s.boxShadow };
  });
  if (
    unfocusedBorder.width !== "1px" ||
    unfocusedBorder.style !== "solid" ||
    !unfocusedBorder.color ||
    /rgba\(0, 0, 0, 0\)|transparent/.test(unfocusedBorder.color)
  ) {
    throw new Error(`Composer 非聚焦计算边框缺失(${theme}): ${JSON.stringify(unfocusedBorder)}`);
  }
  await composerInput.focus();
  const focusedBorder = await composerShell.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.borderTopColor, shadow: s.boxShadow };
  });
  if (focusedBorder.color === unfocusedBorder.color && focusedBorder.shadow === unfocusedBorder.shadow) {
    throw new Error(
      `Composer 聚焦态未触发 :focus-within 边框/光晕(${theme}): ${JSON.stringify({ unfocusedBorder, focusedBorder })}`,
    );
  }
  await composerInput.blur();

  const tool = await page.locator("#tool-card-polish-root").evaluate((root) => {
    const header = root.querySelector("button");
    if (!(header instanceof HTMLElement)) return { error: "找不到工具卡头部" };
    const card = header.closest("div.overflow-hidden.rounded-md");
    const body = card?.querySelector(".border-t");
    return {
      headerClass: header.className,
      cardClass: card?.className ?? "",
      bodyClass: body?.className ?? "",
    };
  });
  if (tool.error) throw new Error(`${tool.error}(${theme})`);
  if (!tool.cardClass.includes("rounded-md")) {
    throw new Error(`工具卡圆角丢失(${theme}): ${tool.cardClass}`);
  }
  if (!tool.headerClass.includes("px-3") || !tool.headerClass.includes("py-2")) {
    throw new Error(`工具卡头部 padding 丢失(${theme}): ${tool.headerClass}`);
  }

  const sidebar = page.locator("#codex-density-root");
  const active = sidebar.getByRole("button", { name: "密度验收活跃会话" });
  await active.waitFor({ state: "visible", timeout: 3000 });
  const activeState = await active.evaluate((btn) => {
    const row = btn.closest("div");
    const duration = row?.querySelector("[data-session-duration]");
    return {
      // SIDEBAR-R1：选中态 = 浮起卡片（bg-sidebar-active + shadow-sidebar-active），不再是左侧 accent 竖条。
      isCard:
        row?.getAttribute("data-active") === "true" &&
        row.classList.contains("bg-sidebar-active") &&
        row.classList.contains("shadow-sidebar-active"),
      cardBg: row ? getComputedStyle(row).backgroundColor : "",
      durationText: duration?.textContent ?? "",
      durationTitle: duration?.getAttribute("title") ?? "",
    };
  });
  if (!activeState.isCard) throw new Error(`活跃会话缺少选中卡片(${theme}): ${JSON.stringify(activeState)}`);
  // 真实 CSS 必须把选中面画出来（token 漏定义时会回落透明，卡片隐形）。
  if (!activeState.cardBg || /rgba\(0, 0, 0, 0\)|transparent/.test(activeState.cardBg)) {
    throw new Error(`活跃会话选中面是透明的(${theme}): ${activeState.cardBg}`);
  }
  // 用时改用中文单位（侧栏审计 SR-01：中文界面不混英文缩写 25m/3h/2d），8 分钟 → 「8分」。
  if (activeState.durationText !== "8分" || !activeState.durationTitle.includes("→")) {
    throw new Error(`会话累计用时未按 createdAt → lastAt 展示(${theme}): ${JSON.stringify(activeState)}`);
  }
  if ((await sidebar.getByText("浏览器契约：摘要不应显示", { exact: true }).count()) !== 0) {
    throw new Error(`会话行仍显示最新消息摘要(${theme})`);
  }
  const idleCard = await sidebar
    .getByRole("button", { name: "密度验收空闲会话" })
    .evaluate((btn) => btn.closest("div")?.getAttribute("data-active") === "true");
  if (idleCard) throw new Error(`空闲会话不应是选中卡片(${theme})`);

  // SIDEBAR-R1：描边 + 实底画在外层卡片 [data-sidebar-new] 上，按钮本身透明铺满。
  const createClass = await sidebar
    .getByRole("button", { name: "新建会话" })
    .evaluate((btn) => btn.closest("[data-sidebar-new]")?.getAttribute("class") ?? "");
  if (!createClass.includes("text-section") || !createClass.includes("border-border") || !createClass.includes("bg-surface")) {
    throw new Error(`新建会话未保持 secondary(${theme}): ${createClass}`);
  }
  // SIDEBAR-R1 / UI-1：管理中心与市场位于一级主导航；组织/管理后台/退出不在主导航；案例与主题收进账号菜单。
  if ((await sidebar.getByTestId("manage-nav").count()) !== 1) {
    throw new Error(`侧栏一级主导航缺少「管理中心」(${theme})`);
  }
  if ((await sidebar.getByTestId("marketplace-nav").count()) !== 1) {
    throw new Error(`侧栏一级主导航缺少「市场」(${theme})`);
  }
  if ((await sidebar.getByRole("button", { name: "打开案例展厅", exact: true }).count()) !== 0) {
    throw new Error(`底栏仍残留旧「打开案例展厅」按钮(${theme})`);
  }
  if ((await sidebar.getByRole("button", { name: /切换主题/ }).count()) !== 0) {
    throw new Error(`底栏仍残留旧「切换主题」按钮(${theme})`);
  }
  await sidebar.getByRole("button", { name: "账号菜单" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 5000 });
  await waitForAnimationsSettled(menu);
  if ((await menu.getByTestId("account-menu-theme-control").count()) !== 1) {
    throw new Error(`账号菜单缺少内联主题切换控件(${theme})`);
  }
  for (const label of ["设置", "帮助与案例", "组织", "管理后台", "视频任务"]) {
    if ((await menu.getByRole("menuitem", { name: new RegExp(label) }).count()) !== 1) {
      throw new Error(`账号菜单缺少「${label}」(${theme})`);
    }
  }
  if ((await menu.getByRole("menuitem", { name: /管理中心/ }).count()) !== 0) {
    throw new Error(`管理中心不应重复出现在账号菜单(${theme})`);
  }
  const adminHref = await menu.getByRole("menuitem", { name: /管理后台/ }).getAttribute("href");
  if (adminHref !== "/admin.html") throw new Error(`管理后台入口丢失或 href 错误(${theme}): ${adminHref}`);
  const galleryOpens = await page.evaluate(() => window.__densityGalleryOpens);
  await menu.getByRole("menuitem", { name: "帮助与案例" }).click();
  await menu.waitFor({ state: "hidden", timeout: 3000 });
  if ((await page.evaluate(() => window.__densityGalleryOpens)) !== galleryOpens + 1) {
    throw new Error(`账号菜单「帮助与案例」入口没有精确触发一次打开(${theme})`);
  }
}

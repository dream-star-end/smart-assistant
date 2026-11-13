// Shared by the commercial journey and selfhost contract gate. No login side effects.
import { createRequire } from "node:module";
import { resolveBrowserExecutable } from "./resolve-browser.mjs";
const { chromium } = createRequire(import.meta.url)("playwright-core");
export function launchJourneyBrowser() {
  return chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
}

export async function selectJourneyModel(page, id, { requireCollapsed = false, timeout = 20_000 } = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid model id");
  const trigger = page.getByRole("button", { name: "选择对话模型" });
  await trigger.click();
  await page.getByRole("menu").waitFor({ state: "visible", timeout });
  const item = page.locator(`[data-model-id="${id}"]`);
  const closed = page.locator('[data-collapsed-group="closed"]');
  if (requireCollapsed) {
    await closed.waitFor({ state: "visible", timeout });
    if (await item.isVisible()) throw new Error(`${id} must be hidden in the default collapsed group`);
  }
  if (!(await item.isVisible()) && await closed.count()) {
    await closed.click();
    await page.locator('[data-collapsed-group="open"]').waitFor({ state: "visible", timeout });
  }
  await item.waitFor({ state: "visible", timeout });
  if (await item.getAttribute("aria-disabled") === "true" || await item.getAttribute("data-locked") !== null) {
    throw new Error(`${id} is not selectable`);
  }
  const label = (await item.locator(".truncate").textContent())?.trim();
  if (!label) throw new Error(`${id} has no visible label`);
  await item.click();
  await page.waitForFunction((label) => document.querySelector('[aria-label="选择对话模型"]')?.textContent?.includes(label), label, { timeout, polling: 50 }).catch(async () => {
    const actual = await trigger.textContent();
    throw new Error(`Model trigger did not settle: id=${id}, expected=${label}, actual=${actual}`);
  });
  return label;
}

// One explicit J4 send may ask for one model-cost confirmation. This is UI
// automation, not delivery proof: J5 still requires the final attachment probe.
export async function waitJourneyUserRow(page, { marker, modelLabel, timeout = 20_000 }) {
  const normalized = (text) => text.replace(/\s+/g, " ").trim();
  if (!marker || !modelLabel || !Number.isFinite(timeout) || timeout <= 0 || timeout > 20_000) {
    throw new Error("Invalid journey send boundary");
  }
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("J4 user-row did not arrive before the send deadline");
    return left;
  };
  let confirmed = false;
  for (;;) {
    remaining();
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    if (count) {
      if (confirmed || count !== 1) throw new Error("Unexpected or repeated journey dialog");
      const dialog = page.getByRole("dialog", { name: "切换模型？", exact: true });
      if (await dialog.count() !== 1) throw new Error("Unrelated journey dialog");
      const paragraphs = await dialog.getByTestId("model-switch-cost-summary").locator("p").allTextContents();
      const targets = paragraphs.flatMap((text) => {
        const p = normalized(text);
        const risk = /确认后将使用\s+(.+?)\s*。$/.exec(p);
        const estimate = /^目标模型：\s*(.+?)\s*·\s*当前上下文约\s/.exec(p);
        return risk || estimate ? [normalized((risk || estimate)[1])] : [];
      });
      if (targets.length !== 1 || targets[0] !== normalized(modelLabel)) {
        throw new Error("Journey confirmation target model mismatch");
      }
      const confirm = dialog.getByRole("button", { name: "确认切换", exact: true });
      if (await confirm.count() !== 1 || !await confirm.isEnabled()) {
        throw new Error("Journey model confirmation unavailable");
      }
      confirmed = true;
      await confirm.click({ timeout: remaining() });
      await dialog.waitFor({ state: "hidden", timeout: remaining() });
      continue;
    }
    const rows = page.getByTestId("user-row").filter({ hasText: marker });
    if (await rows.count() === 1 && await rows.isVisible()) { remaining(); return { confirmed }; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
  }
}

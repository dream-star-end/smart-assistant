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
  const label = (await item.textContent())?.trim();
  if (!label) throw new Error(`${id} has no visible label`);
  await item.click();
  await page.waitForFunction((label) => document.querySelector('[aria-label="选择对话模型"]')?.textContent?.includes(label), label, { timeout, polling: 50 }).catch(async () => {
    const actual = await trigger.textContent();
    throw new Error(`Model trigger did not settle: id=${id}, expected=${label}, actual=${actual}`);
  });
}

// 真浏览器可执行文件解析 —— browser-tests(CI 组件冒烟)与 v5-e2e-journey-canary
// (部署旅程门)共用的单一权威。解析顺序:
//   1. OC_E2E_BROWSER 环境变量(显式指定,换机/降级的唯一出口);
//   2. 系统 Chrome/Chromium(GitHub Actions ubuntu runner 预装 google-chrome);
//   3. ms-playwright 缓存里 revision 最高的 chromium(本机开发/部署机形态)。
// 找不到 = 抛错(调用方按环境错误退出,fail-loud;绝不静默跳过测试——
// "浏览器缺失→跳过"就是 fail-open,正是本门要消灭的洞)。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYSTEM_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

function newestPlaywrightChromium() {
  const cacheDir = join(homedir(), ".cache", "ms-playwright");
  let entries;
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return null;
  }
  // 只认完整 chromium(chromium-<rev>),不用 headless_shell(--headless=new 行为差异)。
  const revs = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ rev: Number(m[1]), dir: m[0] }))
    .sort((a, b) => b.rev - a.rev);
  for (const { dir } of revs) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(cacheDir, dir, sub);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function resolveBrowserExecutable() {
  const explicit = process.env.OC_E2E_BROWSER;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`OC_E2E_BROWSER 指向不存在的路径: ${explicit}`);
    }
    return explicit;
  }
  for (const p of SYSTEM_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  const cached = newestPlaywrightChromium();
  if (cached) return cached;
  throw new Error(
    "找不到可用的 Chrome/Chromium。安装系统 Chrome,或设置 OC_E2E_BROWSER=/path/to/chrome。" +
      "(CI: ubuntu runner 预装 google-chrome;本机: ms-playwright 缓存或系统包)",
  );
}

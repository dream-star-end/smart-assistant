#!/usr/bin/env tsx
// 活体 e2e 选择器存在性门(静态,秒级,进 CI)。
//
// 为什么存在(2026-07-26 审计实锤):
//   02-large-session-open.spec.ts 断言 `getByTestId('turn-process-card')` 的数量为 0,
//   而 `turn-process-card` 这个 testid 在整个 packages/ 下零命中 —— 它只存在于 e2e 自己
//   的 lib/ui.ts。于是这条"旧过程投影不得替代真实 logical record"的防线**永远成立**,
//   而 README/SELECTORS.md 还把它写成"必须保留的稳定 testid",维护者以为防线在。
//
// 这类假绿是系统性的:所有 toHaveCount(0) 负例断言都依赖"选择器确实指向真实存在的
// 元素";选择器一漂,断言静默恒真,live 门照过。live 套件只在部署门跑一次、还要真环境,
// 靠它自己发现不了。所以把"e2e 用到的 testid / aria-label 必须在 web-react 源码里真实
// 存在"提成一道静态门:漂移在 CI 就红,不等到线上。
//
// 判据:凡 e2e 里出现的 data-testid / aria-label 字面量,packages/web-react/src 的
// **非测试源码**里必须真的写了它。找不到 → 红(要么补产品侧 testid,要么删掉这条
// 冒充防线的断言)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const E2E_DIR = join(ROOT, "e2e/session-display");
const SRC_DIR = join(ROOT, "packages/web-react/src");

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const productionSources = walk(
  SRC_DIR,
  (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/__tests__/.test(p),
);
const productionBlob = productionSources.map((p) => readFileSync(p, "utf8")).join("\n");

const e2eFiles = [
  join(E2E_DIR, "lib/ui.ts"),
  ...walk(join(E2E_DIR, "tests"), (p) => p.endsWith(".spec.ts")),
];

type Finding = { kind: string; value: string; where: string };
const missing: Finding[] = [];
const checked: Finding[] = [];

for (const file of e2eFiles) {
  const text = readFileSync(file, "utf8");
  const where = file.slice(ROOT.length + 1);
  const testIds = new Set<string>([
    ...[...text.matchAll(/getByTestId\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/data-testid=\\?["']([^"'\\]+)\\?["']/g)].map((m) => m[1]),
  ]);
  const ariaLabels = new Set<string>(
    [...text.matchAll(/aria-label=\\?["']([^"'\\]+)\\?["']/g)].map((m) => m[1]),
  );
  for (const value of testIds) {
    const finding = { kind: "data-testid", value, where };
    checked.push(finding);
    if (!productionBlob.includes(`data-testid="${value}"`) && !productionBlob.includes(`"${value}"`)) {
      missing.push(finding);
    }
  }
  for (const value of ariaLabels) {
    const finding = { kind: "aria-label", value, where };
    checked.push(finding);
    if (!productionBlob.includes(`"${value}"`) && !productionBlob.includes(`'${value}'`)) {
      missing.push(finding);
    }
  }
}

if (checked.length === 0) {
  throw new Error("[e2e-selectors] 一个选择器都没提取到 —— 提取逻辑失效,拒绝空绿");
}
if (missing.length > 0) {
  const lines = missing.map((m) => `  · ${m.kind}="${m.value}" (${m.where})`).join("\n");
  throw new Error(
    "[e2e-selectors] 以下选择器在 packages/web-react/src 里不存在,依赖它们的断言(尤其"
    + `toHaveCount(0) 负例)是恒真的假绿:\n${lines}\n`
    + "  修法二选一:在产品组件上补这个 testid/aria-label,或删掉这条冒充防线的断言。",
  );
}

process.stdout.write(
  `[e2e-selectors] PASS: ${checked.length} 个 e2e 选择器在 web-react 源码中真实存在\n`,
);

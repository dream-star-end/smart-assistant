#!/usr/bin/env node
// 生成 src/components/iui/iconNodes.generated.ts:Intelligent UI 图标表(icons.ts)里用到的 lucide 图标形状。
// 用法(packages/web-react 下):node scripts/gen-iui-icons.mjs
// 为什么不直接 import 图标组件,见 icons.ts 文件头。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsTs = readFileSync(resolve(root, "src/components/iui/icons.ts"), "utf8");
const names = [...new Set([...iconsTs.matchAll(/^\s+"?[a-z0-9-]+"?: "([a-z0-9-]+)",$/gm)].map((m) => m[1]))].sort();
if (names.length < 40) throw new Error(`only parsed ${names.length} icon names from icons.ts`);

const require = createRequire(resolve(root, "package.json"));
const lucideDir = dirname(require.resolve("lucide-react/package.json"));
const version = JSON.parse(readFileSync(resolve(lucideDir, "package.json"), "utf8")).version;

const out = [
  `// 由 scripts/gen-iui-icons.mjs 生成,不要手改。来源 lucide-react ${version}(ISC 许可,见 node_modules/lucide-react/LICENSE)。`,
  "",
  'import type { IconNode } from "lucide-react";',
  "",
  "export const ICON_NODES = {",
];
for (const name of names) {
  const mod = await import(pathToFileURL(resolve(lucideDir, "dist/esm/icons", `${name}.mjs`)).href);
  if (!Array.isArray(mod.__iconNode)) throw new Error(`lucide-react has no icon "${name}"`);
  out.push(`  ${JSON.stringify(name)}: ${JSON.stringify(mod.__iconNode)},`);
}
out.push("} satisfies Record<string, IconNode>;", "");
const target = resolve(root, "src/components/iui/iconNodes.generated.ts");
writeFileSync(target, out.join("\n"));
console.log(`wrote ${names.length} icons → ${target}`);

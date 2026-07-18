// browser-tests 覆盖面强制门(2026-07-18 门禁审计批D)。静态检查,先于浏览器工作执行
// (run.mjs 开头调用;单独跑:node browser-tests/check-coverage.mjs)。
//
// 不变量:
//   ① src/**/*.tsx(排除 *.test.tsx)中命中高危模式(type="file" / htmlFor /
//      DropdownMenu——jsdom 假阴性类交互的机械判据)的文件,必须在 coverage-manifest.json
//      的 covered / waived / waivedPrefixes 之一;命中却未登记 = 红(新高危文件必须显式决定)。
//   ② covered 引用的文件必须存在(改名/删除必须同步 manifest,防清单腐化);
//   ③ covered 引用的用例 ID 必须真实存在于 run.mjs(防"登记了但用例被删"的假覆盖);
//   ④ waived 理由不许为空串。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SRC = join(PKG_ROOT, "src");
const RISK_RE = /type="file"|htmlFor|DropdownMenu/;

const manifest = JSON.parse(readFileSync(join(HERE, "coverage-manifest.json"), "utf8"));
const covered = manifest.covered ?? {};
const waived = manifest.waived ?? {};
const waivedPrefixes = Object.keys(manifest.waivedPrefixes ?? {});

const errors = [];

// ① 扫描高危文件。
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) yield p;
  }
}
for (const abs of walk(SRC)) {
  const rel = `src/${relative(SRC, abs).replaceAll("\\", "/")}`;
  if (!RISK_RE.test(readFileSync(abs, "utf8"))) continue;
  if (rel in covered || rel in waived) continue;
  if (waivedPrefixes.some((pre) => rel.startsWith(pre))) continue;
  errors.push(
    `未登记的高危交互文件: ${rel}\n` +
      `  该文件含 file-input/label 激活/DropdownMenu(jsdom 假阴性类)。二选一:\n` +
      `  · 在 browser-tests 加真浏览器用例并登记 coverage-manifest.json covered;\n` +
      `  · 或在 waived 写明豁免理由(豁免=债,扩面时偿还)。`,
  );
}

// ② covered 文件存在性(防改名/删除后清单腐化)。
for (const rel of Object.keys(covered)) {
  if (!existsSync(join(PKG_ROOT, rel))) {
    errors.push(`covered 引用了不存在的文件: ${rel}(改名/删除必须同步 manifest)`);
  }
  if (!Array.isArray(covered[rel]) || covered[rel].length === 0) {
    errors.push(`covered['${rel}'] 必须列至少一个用例 ID`);
  }
}

// ③ 用例 ID 真实存在于 run.mjs。
const runSource = readFileSync(join(HERE, "run.mjs"), "utf8");
for (const [rel, ids] of Object.entries(covered)) {
  for (const id of ids ?? []) {
    if (!new RegExp(`"${id} `).test(runSource)) {
      errors.push(`covered['${rel}'] 引用的用例 ${id} 在 run.mjs 里不存在(假覆盖)`);
    }
  }
}

// ④ waived 理由非空。
for (const [rel, reason] of Object.entries(waived)) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    errors.push(`waived['${rel}'] 理由为空——豁免必须书面`);
  }
}

if (errors.length > 0) {
  console.error("browser-tests 覆盖面 manifest 门失败:\n");
  for (const e of errors) console.error(`✗ ${e}\n`);
  process.exit(1);
}
console.log("browser-tests coverage manifest: OK");

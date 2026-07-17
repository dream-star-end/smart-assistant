/**
 * 路由所有权契约测试(2026-07-17 goal "not found" 事故根治)。
 *
 * commercial 路由生效需要"两处同步":routes 数组注册 handler + `prefixes`
 * 所有权清单让 commercialHandler 认领路径。漏登 prefixes → handler 永不可达,
 * 请求 fall through 到 gateway 404/401。这一类事故已发生两次:
 *   - 2026-07-11 连接器目录 not found(prefixes 漏 /api/connectors)
 *   - 2026-07-17 goal PUT not found(prefixes 漏 /api/session-goals,
 *     GET 面被前端当"无目标"吞掉,上线数小时才由写路径暴露)
 * 本测试静态扫描 router.ts:routes 数组里每个 path/pathPrefix 字面量都必须被
 * prefixes 清单覆盖(path === p || path.startsWith(p)),漏登记直接 CI 红,
 * 消灭"第三次"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const routerPath = join(here, "..", "router.ts");

function extractArrayBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `router.ts 缺少 ${marker}`);
  // 从 marker 后的 `= [` 起配平计数闭合 `]`(避开 `Route[]` 类型标注的方括号)。
  const assignIdx = source.indexOf("= [", start);
  assert.ok(assignIdx >= 0 && assignIdx < start + marker.length + 4, `${marker} 后未见 = [`);
  let depth = 0;
  for (let i = source.indexOf("[", assignIdx); i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`router.ts ${marker} 数组未闭合`);
}

test("routes 数组的每个 path/pathPrefix 都被 prefixes 所有权清单认领", async () => {
  const source = await readFile(routerPath, "utf8");

  const prefixesBlock = extractArrayBlock(source, "const prefixes = [");
  const prefixes = [...prefixesBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(prefixes.length > 10, "prefixes 清单解析失败(数量异常)");

  const routesBlock = extractArrayBlock(source, "const routes: Route[] = [");
  const routePaths = [
    ...routesBlock.matchAll(/\bpath(?:Prefix)?:\s*'([^']+)'/g),
  ].map((m) => m[1]);
  assert.ok(routePaths.length > 20, "routes 数组解析失败(数量异常)");

  const orphans = routePaths.filter(
    (route) => !prefixes.some((p) => route === p || route.startsWith(p)),
  );
  assert.deepEqual(
    orphans,
    [],
    `以下路由未被 prefixes 所有权清单认领,commercialHandler 不会接手,` +
      `浏览器会拿到 gateway 404/401:${orphans.join(", ")};` +
      `修法=在 router.ts 的 prefixes 数组补登对应前缀(见清单头部铁律注释)`,
  );
});

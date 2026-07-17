/**
 * 路由所有权契约测试(2026-07-17 goal "not found" 事故根治)。
 *
 * commercial 路由生效需要"两处同步":buildCommercialRoutes() 注册 handler +
 * `COMMERCIAL_ROUTE_PREFIXES` 所有权清单让 commercialHandler 认领路径。漏登 prefixes →
 * handler 永不可达,请求 fall through 到 gateway 404/401。这一类事故已发生两次:
 *   - 2026-07-11 连接器目录 not found(prefixes 漏 /api/connectors)
 *   - 2026-07-17 goal PUT not found(prefixes 漏 /api/session-goals,
 *     GET 面被前端当"无目标"吞掉,上线数小时才由写路径暴露)
 *
 * ── 主门 = 运行时断言(批D D1)────────────────────────────────────────────────
 * 直接 import router 模块的真实 routes/prefixes 值,断言 `routes ⊆ prefixes`。
 * 相较旧正则扫源码:`pathPrefix: SELFHEAL_REPAIRS_PREFIX`(常量间接引用)等对正则是盲区
 * ——运行时拿到的是解引用后的真实字符串,盲区消失。pre-route adapter(/api/anthropic/、
 * file proxy 等不经 routes 数组的直分发路径)由 COMMERCIAL_PRE_ROUTE_PATHS 显式登记并核对。
 *
 * ── 辅门 = 原静态正则(保留)──────────────────────────────────────────────────
 * 作为第二重防线兜运行时不可达的极端场景(如 router 导入被未来副作用破坏)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildCommercialRoutes,
  COMMERCIAL_ROUTE_PREFIXES,
  COMMERCIAL_PRE_ROUTE_PATHS,
} from "../router.js";

const here = dirname(fileURLToPath(import.meta.url));
const routerPath = join(here, "..", "router.ts");

/** prefixes 覆盖判定(与 commercialHandler 的 isOurs 逐字一致)。 */
function coveredByPrefixes(path: string): boolean {
  return COMMERCIAL_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p));
}

// ── 主门:运行时 routes ⊆ prefixes ──────────────────────────────────────────

test("[运行时] buildCommercialRoutes 的每条 path/pathPrefix 都被 COMMERCIAL_ROUTE_PREFIXES 认领", () => {
  // deps 只在各 handler 闭包内被捕获,构造 Route[] 时不读取其字段 → 桩 deps 即可。
  const routes = buildCommercialRoutes(
    {} as unknown as Parameters<typeof buildCommercialRoutes>[0],
  );
  assert.ok(routes.length > 20, "routes 数量异常,buildCommercialRoutes 可能构造失败");
  assert.ok(
    COMMERCIAL_ROUTE_PREFIXES.length > 10,
    "prefixes 清单数量异常",
  );

  const routePaths = routes
    .map((r) => r.path ?? r.pathPrefix)
    .filter((p): p is string => typeof p === "string");
  // 每条注册路由都必须有 path 或 pathPrefix(不存在两者皆空的 Route)。
  assert.equal(
    routePaths.length,
    routes.length,
    "存在既无 path 也无 pathPrefix 的 Route(注册表结构损坏)",
  );

  const orphans = routePaths.filter((route) => !coveredByPrefixes(route));
  assert.deepEqual(
    orphans,
    [],
    `以下路由未被 COMMERCIAL_ROUTE_PREFIXES 认领,commercialHandler 不会接手,` +
      `浏览器会拿到 gateway 404/401:${orphans.join(", ")};` +
      `修法=在 router.ts 的 COMMERCIAL_ROUTE_PREFIXES 补登对应前缀`,
  );
});

test("[运行时] pre-route adapter 登记面与 prefixes 自洽", () => {
  assert.ok(
    COMMERCIAL_PRE_ROUTE_PATHS.length > 0,
    "pre-route 登记面为空,枚举核对失效",
  );
  // requiresPrefix=true 的 pre-route(如 /api/anthropic/v1/messages)必须被 prefixes 覆盖
  // ——维护期闸门 + isOurs 兜底都靠 prefixes 命中。
  const uncoveredRequired = COMMERCIAL_PRE_ROUTE_PATHS.filter(
    (r) => r.requiresPrefix && !coveredByPrefixes(r.path),
  ).map((r) => r.path);
  assert.deepEqual(
    uncoveredRequired,
    [],
    `以下 pre-route 声明 requiresPrefix 但未被 COMMERCIAL_ROUTE_PREFIXES 覆盖:` +
      `${uncoveredRequired.join(", ")}`,
  );
  // 注:requiresPrefix=false 的 file proxy 路径(/api/file、/api/media/)故意在 isOurs
  // 兜底前直接 return,不要求登记进 prefixes;不对其做"未覆盖"负向断言 —— 因为字符串前缀
  // 匹配存在偶然重叠(如 '/api/media/'.startsWith('/api/me') === true),覆盖与否不构成
  // 语义不变量,登记本身即达成"新增直分发路径须显式声明"的目的。
});

// ── 辅门:原静态正则(保留)──────────────────────────────────────────────────

function extractArrayBlock(source: string, marker: string, openToken: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `router.ts 缺少 ${marker}`);
  // 从 marker 后的 openToken(如 `= [` / `return [`)起配平计数闭合 `]`
  // (避开 `Route[]` / `string[]` 类型标注里的方括号)。
  const openIdx = source.indexOf(openToken, start);
  assert.ok(openIdx >= 0, `${marker} 后未见 ${openToken}`);
  let depth = 0;
  for (let i = source.indexOf("[", openIdx); i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`router.ts ${marker} 数组未闭合`);
}

test("[静态辅门] 源码正则扫 routes/prefixes 亦满足 routes ⊆ prefixes", async () => {
  const source = await readFile(routerPath, "utf8");

  const prefixesBlock = extractArrayBlock(
    source,
    "export const COMMERCIAL_ROUTE_PREFIXES: readonly string[] = [",
    "= [",
  );
  const prefixes = [...prefixesBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(prefixes.length > 10, "prefixes 清单解析失败(数量异常)");

  const routesBlock = extractArrayBlock(
    source,
    "export function buildCommercialRoutes",
    "return [",
  );
  const routePaths = [
    ...routesBlock.matchAll(/\bpath(?:Prefix)?:\s*'([^']+)'/g),
  ].map((m) => m[1]);
  assert.ok(routePaths.length > 20, "routes 数组解析失败(数量异常)");

  // 注:静态扫抓不到 `pathPrefix: SELFHEAL_REPAIRS_PREFIX` 这类常量间接引用(那正是
  // 运行时主门存在的理由);此辅门只在字面量子集上兜底。
  const orphans = routePaths.filter(
    (route) => !prefixes.some((p) => route === p || route.startsWith(p)),
  );
  assert.deepEqual(orphans, [], `静态扫发现未认领字面量路由:${orphans.join(", ")}`);
});

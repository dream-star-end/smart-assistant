/**
 * admin route inventory — 提取器 + baseline 写入器(单一权威)。
 *
 * 谁用它:
 *   - `packages/commercial/src/__tests__/admin-route-inventory.test.ts`
 *     **只读**导入 `extractAdminRoutes` / `readBaseline`,比对后断言。
 *   - `npm run baseline:admin-routes` 重钉 baseline(唯一的写入入口)。
 *
 * 为什么把写入从测试里搬出来(2026-07-26):
 *   原实现在测试内部留了 `UPDATE_BASELINE=1` 逃生门 —— 一个 env 就能让测试
 *   **改写自己的期望值然后通过**,快照门形同虚设(误设该 env 的 CI job / 本地
 *   习惯性带环境变量都会静默吞掉真实的路由变更);而且"会写文件的测试"在只读
 *   工作区里会引入一类与被测对象无关的失败。现在职责分开:
 *     测试 = 纯只读比对,没有任何能让它自己变绿的开关;
 *     重钉 = 显式跑 npm script,改动出现在 git diff 里,必须被 review。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 被扫描的路由表源码。 */
export const ROUTER_TS = path.resolve(__dirname, "../src/http/router.ts");
/** baseline 快照文件(与测试同目录,便于一起 review)。 */
export const BASELINE_JSON = path.resolve(
  __dirname,
  "../src/__tests__/router-admin-baseline.json",
);

export interface AdminRoute {
  method: string;
  pathKind: "path" | "pathPrefix";
  pathValue: string;
  handler: string;
}

/**
 * 从 handler 表达式解析出"这条路由实际执行谁"的权威函数名。
 *
 * 两种形态都必须入清单,否则新增 admin 路由改内联形式即可绕过快照门(盲区):
 *  1) 裸标识符:      `handleX`                              → "handleX"
 *  2) 内联箭头:      `(req, res) => handleX(req, res, deps)` → "handleX"
 *     含条件派发:    `(req,res) => c ? handleA(...) : handleB(...)` → "handleA|handleB"
 *
 * 内联箭头体是纯表达式(三元/调用,不含语句块 `{}`),故目标函数名 = 所有被调用为
 * `identifier(req, ...)` 的标识符(按源码顺序去重;多目标用 '|' 连接)。
 */
export function normalizeHandler(expr: string): string {
  const trimmed = expr.trim();
  // 裸标识符:原样(与历史 baseline 兼容)。
  if (/^\w+$/.test(trimmed)) return trimmed;
  // 内联箭头:抽出所有 `handleX(req` 形态的被调目标函数名。
  const targets: string[] = [];
  for (const c of trimmed.matchAll(/(\w+)\s*\(\s*req\b/g)) targets.push(c[1]!);
  const uniq = [...new Set(targets)];
  if (uniq.length === 0) {
    // 箭头体里没有 `handleX(req,...)` 目标 —— 抛错让维护者显式处理,绝不静默塞空
    // 字符串(那会重新制造盲区,正是本次要根治的一类问题)。
    throw new Error(`admin route 内联 handler 无法解析目标函数: ${expr}`);
  }
  return uniq.join("|");
}

export function extractAdminRoutes(src: string): AdminRoute[] {
  // 跨行匹配 { method: 'X', (path|pathPrefix): '/api/admin/...', handler: <expr> }
  // 注意:
  // - handler <expr> 可为裸标识符,也可为内联箭头(marketplace admin 全族 + 未来新增)。
  //   内联箭头体不含 '}'(纯表达式),故用 [^}] 非贪婪收尾到路由对象的闭合花括号,
  //   再交给 normalizeHandler 抽出目标函数名 —— 消除"内联形式逃逸 baseline"盲区。
  // - 属性顺序 method → path|pathPrefix → handler 在 router.ts 内一致,handler 恒为末字段。
  // - \s* 匹配跨行空白
  const re =
    /\{\s*method:\s*'([A-Z]+)'\s*,\s*(path|pathPrefix):\s*'(\/api\/admin[^']*)'\s*,\s*handler:\s*([^}]*?)\s*,?\s*\}/g;

  const out: AdminRoute[] = [];
  for (const m of src.matchAll(re)) {
    out.push({
      method: m[1]!,
      pathKind: m[2]! as "path" | "pathPrefix",
      pathValue: m[3]!,
      handler: normalizeHandler(m[4]!),
    });
  }
  return out;
}

/** 扫当前 router.ts。 */
export function currentAdminRoutes(): AdminRoute[] {
  return extractAdminRoutes(fs.readFileSync(ROUTER_TS, "utf8"));
}

/** 读 baseline;不存在返回 null(由调用方决定怎么报)。 */
export function readBaseline(): AdminRoute[] | null {
  if (!fs.existsSync(BASELINE_JSON)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_JSON, "utf8")) as AdminRoute[];
}

/** 序列化格式的单一权威(写入与"是否需要更新"的判断都走它)。 */
export function serializeBaseline(routes: AdminRoute[]): string {
  return `${JSON.stringify(routes, null, 2)}\n`;
}

/** 重钉 baseline。返回写入的条数。仅供 npm run baseline:admin-routes 调用。 */
export function writeBaseline(): number {
  const routes = currentAdminRoutes();
  fs.writeFileSync(BASELINE_JSON, serializeBaseline(routes), "utf8");
  return routes.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const n = writeBaseline();
  // eslint-disable-next-line no-console
  console.log(`[admin-route-inventory] wrote ${n} admin routes to ${BASELINE_JSON}`);
  // eslint-disable-next-line no-console
  console.log("baseline 变更必须进 git diff 并被 review —— 它是 admin 路由集合的唯一快照。");
}

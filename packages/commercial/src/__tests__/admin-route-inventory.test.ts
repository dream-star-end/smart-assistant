/**
 * S3 PoC — admin route inventory snapshot test
 *
 * 静态扫描 packages/commercial/src/http/router.ts 源码,正则抽出所有
 * `/api/admin/*` route 字面量,序列化成 inventory 数组,与 baseline JSON
 * deep-equal 对比。
 *
 * 拆分前后 admin routes 字节相等是 S3 hard gate #1(plan §4.1)。
 *
 * 设计选择:
 * - 静态扫源码而不是运行时反射,因为 routes 是 createCommercialHandler
 *   闭包内的局部 const,不可外部访问;改 router.ts 暴露 routes 会动 PoC
 *   不动 router 结构的承诺(plan §1.2)
 * - 正则匹配 method/path|pathPrefix/handler 三段式,数组顺序保留
 *   (admin route prefix 优先级敏感,见 §0.3 R2/R3/R4 注释)
 *
 * 更新 baseline:
 *   UPDATE_BASELINE=1 npx tsx --test packages/commercial/src/__tests__/admin-route-inventory.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_TS = path.resolve(__dirname, "../http/router.ts");
const BASELINE_JSON = path.resolve(__dirname, "router-admin-baseline.json");

interface AdminRoute {
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
function normalizeHandler(expr: string): string {
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

function extractAdminRoutes(src: string): AdminRoute[] {
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

describe("admin-route-inventory (S3 PoC hard gate #1)", () => {
  test("router.ts /api/admin/* routes match baseline byte-equal", () => {
    const src = fs.readFileSync(ROUTER_TS, "utf8");
    const current = extractAdminRoutes(src);

    // sanity:不应为空,否则正则坏了或 router.ts 被清空
    assert.ok(
      current.length >= 50,
      `extractAdminRoutes 抓到 ${current.length} 条 admin routes,< 50 怀疑正则失效;router.ts 路径=${ROUTER_TS}`,
    );

    const updateMode = process.env.UPDATE_BASELINE === "1";

    if (updateMode) {
      const json = JSON.stringify(current, null, 2) + "\n";
      fs.writeFileSync(BASELINE_JSON, json, "utf8");
      console.log(
        `[UPDATE_BASELINE] wrote ${current.length} admin routes to ${BASELINE_JSON}`,
      );
      return;
    }

    if (!fs.existsSync(BASELINE_JSON)) {
      assert.fail(
        `baseline 不存在: ${BASELINE_JSON}\n` +
          `首次运行用: UPDATE_BASELINE=1 npx tsx --test ${path.relative(process.cwd(), __filename)}`,
      );
    }

    const baseline = JSON.parse(fs.readFileSync(BASELINE_JSON, "utf8")) as AdminRoute[];

    // method + pathKind + pathValue + handler + 数组顺序 byte-equal
    assert.deepStrictEqual(
      current,
      baseline,
      "admin routes inventory 与 baseline 不一致 — S3 拆分破坏了 router.ts 的 admin route 集合或顺序。" +
        "如果是有意修改,跑 UPDATE_BASELINE=1 重新钉基线;否则查 router.ts diff",
    );
  });

  test("extractAdminRoutes 正则覆盖 (smoke)", () => {
    const src = `
      { method: 'GET', path: '/api/admin/users', handler: handleAdminListUsers },
      {
        method: 'POST',
        pathPrefix: '/api/admin/users/',
        handler: handleAdminAdjustCredits,
      },
      { method: 'DELETE', pathPrefix: '/api/admin/accounts/', handler: handleAdminDeleteAccount },
    `;
    const got = extractAdminRoutes(src);
    assert.equal(got.length, 3);
    assert.deepEqual(got[0], {
      method: "GET",
      pathKind: "path",
      pathValue: "/api/admin/users",
      handler: "handleAdminListUsers",
    });
    assert.deepEqual(got[1], {
      method: "POST",
      pathKind: "pathPrefix",
      pathValue: "/api/admin/users/",
      handler: "handleAdminAdjustCredits",
    });
    assert.deepEqual(got[2], {
      method: "DELETE",
      pathKind: "pathPrefix",
      pathValue: "/api/admin/accounts/",
      handler: "handleAdminDeleteAccount",
    });
  });

  test("extractAdminRoutes 覆盖内联箭头 handler (根治盲区 smoke)", () => {
    // 单目标内联箭头:目标函数名进清单(旧正则会整条漏抓)。
    const single = extractAdminRoutes(
      `{
        method: 'GET',
        path: '/api/admin/marketplace/pending',
        handler: (req, res) => handleAdminMarketplacePending(req, res, deps),
      },`,
    );
    assert.equal(single.length, 1);
    assert.deepEqual(single[0], {
      method: "GET",
      pathKind: "path",
      pathValue: "/api/admin/marketplace/pending",
      handler: "handleAdminMarketplacePending",
    });

    // 条件派发内联箭头:多目标按源码顺序去重并 '|' 连接。
    const dispatch = extractAdminRoutes(
      `{
        method: 'POST',
        pathPrefix: '/api/admin/marketplace/',
        handler: (req, res) =>
          (req.url ?? '').includes('/featured')
            ? handleAdminMarketplaceFeatured(req, res, deps)
            : (req.url ?? '').includes('/revoke')
              ? handleAdminMarketplaceRevoke(req, res, deps)
              : handleAdminMarketplaceReview(req, res, deps),
      },`,
    );
    assert.equal(dispatch.length, 1);
    assert.deepEqual(dispatch[0], {
      method: "POST",
      pathKind: "pathPrefix",
      pathValue: "/api/admin/marketplace/",
      handler:
        "handleAdminMarketplaceFeatured|handleAdminMarketplaceRevoke|handleAdminMarketplaceReview",
    });
  });
});

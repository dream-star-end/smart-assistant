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

function extractAdminRoutes(src: string): AdminRoute[] {
  // 跨行匹配 { method: 'X', (path|pathPrefix): '/api/admin/...', handler: identifier }
  // 注意:
  // - admin handler 都是 identifier,不会是 inline 箭头函数(已 grep 验证)
  // - 属性顺序 method → path|pathPrefix → handler 在 router.ts 内一致
  // - \s* 匹配跨行空白
  const re =
    /\{\s*method:\s*'([A-Z]+)'\s*,\s*(path|pathPrefix):\s*'(\/api\/admin[^']*)'\s*,\s*handler:\s*(\w+)\s*,?\s*\}/g;

  const out: AdminRoute[] = [];
  for (const m of src.matchAll(re)) {
    out.push({
      method: m[1]!,
      pathKind: m[2]! as "path" | "pathPrefix",
      pathValue: m[3]!,
      handler: m[4]!,
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
});

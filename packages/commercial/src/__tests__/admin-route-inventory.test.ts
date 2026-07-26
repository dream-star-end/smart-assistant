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
 * **本文件只读**(2026-07-26 收紧):提取器与 baseline 写入器都搬去
 * `packages/commercial/scripts/admin-route-inventory.ts`。此前这里留过一个
 * 环境变量逃生门 —— 设上它,测试就会改写自己的期望值然后通过,快照门等于没有;
 * 而且"会写文件的测试"在只读工作区还会引入一类与被测对象无关的失败。
 * 下面第二条用例把"只读"本身钉成硬断言(故意不写出那个变量名,见其注释)。
 *
 * 更新 baseline(唯一入口,改动会进 git diff 被 review):
 *   npm run baseline:admin-routes
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  BASELINE_JSON,
  ROUTER_TS,
  extractAdminRoutes,
  currentAdminRoutes,
  readBaseline,
} from "../../scripts/admin-route-inventory.js";

describe("admin-route-inventory (S3 PoC hard gate #1)", () => {
  test("router.ts /api/admin/* routes match baseline byte-equal", () => {
    const current = currentAdminRoutes();

    // sanity:不应为空,否则正则坏了或 router.ts 被清空
    assert.ok(
      current.length >= 50,
      `extractAdminRoutes 抓到 ${current.length} 条 admin routes,< 50 怀疑正则失效;router.ts 路径=${ROUTER_TS}`,
    );

    const baseline = readBaseline();
    assert.ok(
      baseline !== null,
      `baseline 不存在: ${BASELINE_JSON}\n首次生成用: npm run baseline:admin-routes`,
    );

    // method + pathKind + pathValue + handler + 数组顺序 byte-equal
    assert.deepStrictEqual(
      current,
      baseline,
      "admin routes inventory 与 baseline 不一致 — router.ts 的 admin route 集合或顺序被改动。" +
        "如果是有意修改,跑 `npm run baseline:admin-routes` 重钉基线(改动会进 git diff 供 review);否则查 router.ts diff",
    );
  });

  test("本文件保持只读:无 env 分支、无文件写入(元不变量)", () => {
    // 快照门的价值全在"测试自己改不动期望值"。历史上这里有过一个 env 逃生门,
    // 一设就让测试重写 baseline 后通过 —— 门等于没有。这条锁住"门没被再次掏空"。
    //
    // needle 故意用拼接构造:直接写字面量的话,这条断言的源码自己就会命中自己。
    const forbidden = [
      ["UPDATE", "_BASELINE"].join(""),
      ["process", ".env"].join(""),
      ["write", "FileSync"].join(""),
      ["append", "FileSync"].join(""),
    ];
    const self = fs.readFileSync(new URL(import.meta.url), "utf8");
    const hits = forbidden.filter((needle) => self.includes(needle));
    assert.deepEqual(
      hits,
      [],
      `快照测试必须只读:不得出现 ${hits.join(" / ")};重钉基线走 npm run baseline:admin-routes`,
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

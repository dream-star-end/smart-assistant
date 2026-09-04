import { describe, expect, test } from "vitest";
import {
  collectFirstScreenClosure,
  describeFirstScreenBudget,
  firstScreenBudgetReport,
  isFirstScreenEntryChunk,
  type FirstScreenChunkLike,
} from "./firstScreenBudget";

/** gzipSize 替身:直接按 code 长度计,让预算断言可以心算。 */
const fakeGzip = (code: string) => code.length;

function chunk(fileName: string, code: string, extra: Partial<FirstScreenChunkLike> = {}): FirstScreenChunkLike {
  return { type: "chunk", fileName, code, ...extra };
}

describe("isFirstScreenEntryChunk", () => {
  test("用户端 index.html 入口命中;admin 入口与懒块不命中", () => {
    expect(
      isFirstScreenEntryChunk(
        chunk("assets/main-z48.js", "", { isEntry: true, facadeModuleId: "/x/packages/web-react/index.html" }),
      ),
    ).toBe(true);
    expect(
      isFirstScreenEntryChunk(
        chunk("assets/admin-abc.js", "", { isEntry: true, facadeModuleId: "/x/packages/web-react/admin.html" }),
      ),
    ).toBe(false);
    expect(
      isFirstScreenEntryChunk(
        chunk("assets/MarketplaceCenter-1.js", "", { facadeModuleId: "/x/src/components/MarketplaceCenter.tsx" }),
      ),
    ).toBe(false);
    // 非入口 chunk 即便路径巧合也不是首屏入口。
    expect(
      isFirstScreenEntryChunk(
        chunk("assets/main-1.js", "", { facadeModuleId: "/x/index.html" }),
      ),
    ).toBe(false);
  });
});

describe("collectFirstScreenClosure", () => {
  test("沿静态 imports 递归收集;动态 import 的 chunk 不进闭包", () => {
    const closure = collectFirstScreenClosure([
      chunk("assets/main-1.js", "e", {
        isEntry: true,
        facadeModuleId: "/x/index.html",
        imports: ["./react-vendor-1.js", "./shared-1.js"],
      }),
      chunk("assets/react-vendor-1.js", "r", { imports: [] }),
      chunk("assets/shared-1.js", "s", { imports: ["./react-vendor-1.js", "./deep-1.js"] }),
      chunk("assets/deep-1.js", "d"),
      // 只被动态 import 引用(不在任何静态 imports 列表里)→ 不属于首屏闭包。
      chunk("assets/TaskboardView-1.js", "t"),
    ]);
    expect(closure.map((c) => c.fileName).sort()).toEqual([
      "assets/deep-1.js",
      "assets/main-1.js",
      "assets/react-vendor-1.js",
      "assets/shared-1.js",
    ]);
  });

  test("环状 import 边不死循环", () => {
    const closure = collectFirstScreenClosure([
      chunk("assets/main-1.js", "e", {
        isEntry: true,
        facadeModuleId: "/x/index.html",
        imports: ["./a-1.js"],
      }),
      chunk("assets/a-1.js", "a", { imports: ["./b-1.js"] }),
      chunk("assets/b-1.js", "b", { imports: ["./a-1.js"] }),
    ]);
    expect(closure).toHaveLength(3);
  });

  test("没有用户端入口(异常产物)返回空集而不是抛错", () => {
    expect(collectFirstScreenClosure([chunk("assets/admin-1.js", "", { isEntry: true })])).toEqual([]);
  });
});

describe("firstScreenBudgetReport", () => {
  const chunks: FirstScreenChunkLike[] = [
    chunk("assets/main-1.js", "e".repeat(512), {
      isEntry: true,
      facadeModuleId: "/x/index.html",
      imports: ["./big-1.js", "./small-1.js"],
    }),
    chunk("assets/big-1.js", "b".repeat(2048)),
    chunk("assets/small-1.js", "s".repeat(1024)),
  ];

  test("总量 = 入口 + 静态闭包的 gzip 求和;超预算时 overBudget", () => {
    const report = firstScreenBudgetReport(chunks, 4 * 1024, fakeGzip);
    // 512 + 2048 + 1024 = 3584
    expect(report.totalGzipBytes).toBe(3584);
    expect(report.closureChunkCount).toBe(3);
    expect(report.overBudget).toBe(false);
    expect(firstScreenBudgetReport(chunks, 2048, fakeGzip).overBudget).toBe(true);
  });

  test("top 降序;报错文案含闭包数、总量、预算与 top chunk 尺寸", () => {
    const report = firstScreenBudgetReport(chunks, 1024, fakeGzip);
    expect(report.top.map((t) => t.fileName)).toEqual([
      "assets/big-1.js",
      "assets/small-1.js",
      "assets/main-1.js",
    ]);
    const text = describeFirstScreenBudget(report);
    expect(text).toContain("3 个 chunk");
    expect(text).toContain("3.5KB");
    expect(text).toContain("1.0KB"); // 预算
    expect(text).toContain("assets/big-1.js");
    expect(text).toContain("2.0KB"); // big-1.js 尺寸
  });

  test("top 最多 8 条", () => {
    const many: FirstScreenChunkLike[] = [
      chunk("assets/main-1.js", "e", {
        isEntry: true,
        facadeModuleId: "/x/index.html",
        imports: Array.from({ length: 12 }, (_, i) => `./dep-${i}.js`),
      }),
      ...Array.from({ length: 12 }, (_, i) => chunk(`assets/dep-${i}.js`, "x")),
    ];
    const report = firstScreenBudgetReport(many, 1, fakeGzip);
    expect(report.top).toHaveLength(8);
    expect(report.closureChunkCount).toBe(13);
  });
});

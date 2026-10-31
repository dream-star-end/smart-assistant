import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("导航壳不吃 HTTP 缓存(OCV5-699)", () => {
  const src = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

  it("导航请求带 cache no-store，并丢掉 v2 缓存名", () => {
    expect(src).toContain("congjian-sw-v3");
    expect(src).not.toContain("congjian-sw-v2");
    expect(src).toContain("cache: 'no-store'");
    expect(src).toContain("离线：暂时无法加载页面。");
  });
});

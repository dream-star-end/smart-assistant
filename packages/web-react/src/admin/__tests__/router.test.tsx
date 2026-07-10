import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildAdminHash, parseAdminHash, useAdminRoute } from "../router";

describe("parseAdminHash", () => {
  test("空 / 缺失 hash → 回落 dashboard", () => {
    expect(parseAdminHash("")).toEqual({ tab: "dashboard", params: {} });
    expect(parseAdminHash("#")).toEqual({ tab: "dashboard", params: {} });
    expect(parseAdminHash("#foo=bar")).toEqual({ tab: "dashboard", params: {} });
  });

  test("合法 tab（无参数）", () => {
    expect(parseAdminHash("#tab=users")).toEqual({ tab: "users", params: {} });
  });

  test("含大写的 tab（accountGroups / modelGrants）不被回落", () => {
    expect(parseAdminHash("#tab=accountGroups").tab).toBe("accountGroups");
    expect(parseAdminHash("#tab=modelGrants").tab).toBe("modelGrants");
  });

  test("非白名单 tab → 回落 dashboard", () => {
    expect(parseAdminHash("#tab=nope").tab).toBe("dashboard");
  });

  test("解析并 URL 解码查询参数", () => {
    const r = parseAdminHash("#tab=containers&user_email=a%40b.com&host_uuid=h1");
    expect(r.tab).toBe("containers");
    expect(r.params).toEqual({ user_email: "a@b.com", host_uuid: "h1" });
  });
});

describe("buildAdminHash", () => {
  test("无参数", () => {
    expect(buildAdminHash("dashboard")).toBe("#tab=dashboard");
  });
  test("跳过空 / undefined 参数", () => {
    expect(
      buildAdminHash("users", { q: "hi", empty: "", n: 2, u: undefined, z: null }),
    ).toBe("#tab=users&q=hi&n=2");
  });
});

describe("useAdminRoute", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(cleanup);

  test("初始反映当前 hash（回落 dashboard）", () => {
    const { result } = renderHook(() => useAdminRoute());
    expect(result.current.tab).toBe("dashboard");
  });

  test("navigate 写 hash 后路由更新（含参数）", () => {
    const { result } = renderHook(() => useAdminRoute());
    act(() => {
      result.current.navigate("containers", { user_email: "x@y.com" });
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(result.current.tab).toBe("containers");
    expect(result.current.params.user_email).toBe("x@y.com");
  });

  test("外部 hash 变化经 hashchange 同步", () => {
    const { result } = renderHook(() => useAdminRoute());
    act(() => {
      window.location.hash = "#tab=orders";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(result.current.tab).toBe("orders");
  });
});

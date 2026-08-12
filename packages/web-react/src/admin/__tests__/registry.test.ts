import { describe, expect, test } from "vitest";
import {
  ADMIN_GROUP_ORDER,
  adminGroups,
  adminPages,
  adminTabKeys,
  getAdminPage,
} from "../registry";

// 分组 → 期望 key 列表（权威源 = React registry 的运营信息架构）。
const EXPECTED: Record<string, string[]> = {
  经营驾驶舱: ["dashboard", "users"],
  账号与调度: ["accounts", "accountGroups", "egressProxies"],
  运行资源: ["containers", "hosts"],
  财务与商业: ["ledger", "orders", "pricing", "plans", "org", "modelGrants"],
  用户声音与体验: ["feedback", "autoDreamFindings", "productFriction"],
  用户触达: ["inbox"],
  内容运营: ["marketplace"],
  系统配置: ["literature", "settings"],
  运行与事故: ["health", "alerts", "selfheal"],
  审计与安全: ["audit"],
};

describe("registry 完整性", () => {
  test("恰好 24 个页面，key 无重复", () => {
    expect(adminPages).toHaveLength(24);
    const keys = adminPages.map((p) => p.key);
    expect(new Set(keys).size).toBe(24);
    expect(adminTabKeys.size).toBe(24);
  });

  test("每个 key 都存在且分组正确", () => {
    for (const [group, keys] of Object.entries(EXPECTED)) {
      for (const key of keys) {
        const page = adminPages.find((p) => p.key === key);
        expect(page, `缺页面 ${key}`).toBeDefined();
        expect(page?.group).toBe(group);
      }
    }
  });

  test("分组顺序覆盖全部页面且顺序稳定", () => {
    expect(ADMIN_GROUP_ORDER).toEqual(Object.keys(EXPECTED));
    expect(adminGroups.map((g) => g.group)).toEqual(ADMIN_GROUP_ORDER);
    const flat = adminGroups.flatMap((g) => g.pages.map((p) => p.key));
    expect(flat).toHaveLength(24);
    expect(new Set(flat).size).toBe(24);
  });

  test("每页有标题/描述/图标/懒组件", () => {
    for (const p of adminPages) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.desc.length).toBeGreaterThan(0);
      expect(p.icon).toBeTruthy();
      expect(p.Component).toBeTruthy();
    }
  });

  test("getAdminPage：命中返回本页，非法 key 回落 dashboard", () => {
    expect(getAdminPage("users").key).toBe("users");
    expect(getAdminPage("accountGroups").key).toBe("accountGroups");
    expect(getAdminPage("productFriction").key).toBe("productFriction");
    expect(getAdminPage("nope").key).toBe("dashboard");
    expect(getAdminPage("").key).toBe("dashboard");
  });
});

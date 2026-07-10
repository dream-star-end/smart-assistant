import { describe, expect, test } from "vitest";
import {
  ADMIN_GROUP_ORDER,
  adminGroups,
  adminPages,
  adminTabKeys,
  getAdminPage,
} from "../registry";

// 分组 → 期望 key 列表（权威源 = 旧 vanilla ADMIN_TAB_META）。
const EXPECTED: Record<string, string[]> = {
  经营驾驶舱: ["dashboard", "users"],
  账号与调度: ["accounts", "accountGroups", "egressProxies"],
  运行资源: ["containers", "hosts"],
  财务与商业: ["ledger", "orders", "pricing", "plans", "org", "modelGrants"],
  用户触达: ["feedback", "inbox", "marketplace"],
  系统运营: ["literature", "settings", "audit", "health", "alerts"],
};

describe("registry 完整性", () => {
  test("恰好 21 个页面，key 无重复", () => {
    expect(adminPages).toHaveLength(21);
    const keys = adminPages.map((p) => p.key);
    expect(new Set(keys).size).toBe(21);
    expect(adminTabKeys.size).toBe(21);
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
    expect(flat).toHaveLength(21);
    expect(new Set(flat).size).toBe(21);
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
    expect(getAdminPage("nope").key).toBe("dashboard");
    expect(getAdminPage("").key).toBe("dashboard");
  });
});

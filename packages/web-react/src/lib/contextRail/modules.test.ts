import { describe, expect, test } from "vitest";
import { CONTEXT_RAIL_MODULE_IDS, CONTEXT_RAIL_MODULES } from "./modules";

describe("context rail 模块注册表", () => {
  test("权威清单只有已接线模块，且与导出数组顺序一致", () => {
    expect(CONTEXT_RAIL_MODULE_IDS).toEqual(["bound-repo", "pinned-tasks"]);
    expect(CONTEXT_RAIL_MODULES.map((m) => m.id)).toEqual([...CONTEXT_RAIL_MODULE_IDS]);
  });

  test("禁止把 AgentGate / PermissionCard 登记进右栏", () => {
    expect(CONTEXT_RAIL_MODULE_IDS).not.toContain("agent-gate");
    expect(CONTEXT_RAIL_MODULE_IDS).not.toContain("permission-card");
  });
});

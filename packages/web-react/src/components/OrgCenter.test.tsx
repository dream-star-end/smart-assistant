import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ApiError } from "../lib/api";
import { OrgCenter, orgErrText, orgRoleLabel } from "./OrgCenter";

afterEach(cleanup);

test("组织中心关闭按钮仅在粗指针扩大到 44px", () => {
  render(<OrgCenter open auth={null} user={null} onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "关闭" })).toHaveClass("[@media(hover:none)]:size-11");
  expect(screen.getByRole("dialog")).toHaveClass("oc-center-dialog", "h-[min(85vh,46rem)]", "h-[min(85dvh,46rem)]");
  expect(screen.getByRole("dialog")).not.toHaveClass("top-1/2");
});

describe("orgRoleLabel", () => {
  test("三档角色中文", () => {
    expect(orgRoleLabel("owner")).toBe("拥有者");
    expect(orgRoleLabel("admin")).toBe("管理员");
    expect(orgRoleLabel("member")).toBe("成员");
  });
});

describe("orgErrText（错误 → 展示文案，后端原文优先）", () => {
  test("ApiError 用后端 message（如 501 NOT_IMPLEMENTED）", () => {
    const e = new ApiError({ status: 501, message: "尚未实现", code: "NOT_IMPLEMENTED" });
    expect(orgErrText(e, "兜底")).toBe("尚未实现");
  });

  test("ApiError 无 message 时回退 fallback", () => {
    const e = new ApiError({ status: 404, message: "" });
    expect(orgErrText(e, "组织不存在")).toBe("组织不存在");
  });

  test("普通 Error 用其 message", () => {
    expect(orgErrText(new Error("网络中断"), "兜底")).toBe("网络中断");
  });

  test("非 Error 值 → fallback", () => {
    expect(orgErrText("boom", "兜底")).toBe("兜底");
    expect(orgErrText(null, "兜底")).toBe("兜底");
    expect(orgErrText(undefined, "兜底")).toBe("兜底");
  });
});

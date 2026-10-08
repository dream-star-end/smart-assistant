import { describe, expect, test } from "vitest";
import { projectChipsBoardId } from "./projectChips";

describe("projectChipsBoardId", () => {
  const on = { demo: false, taskboardEnabled: true, chipsFlag: true };
  test("flag on + chat in a project with a board → that board", () => {
    expect(projectChipsBoardId({ ...on, project: { boardProjectId: "b-1" } })).toBe("b-1");
  });
  test("no chips when the flag is off, in demo, without the taskboard, or without a project/board", () => {
    const p = { boardProjectId: "b-1" };
    expect(projectChipsBoardId({ ...on, chipsFlag: false, project: p })).toBeNull();
    expect(projectChipsBoardId({ ...on, demo: true, project: p })).toBeNull();
    expect(projectChipsBoardId({ ...on, taskboardEnabled: false, project: p })).toBeNull();
    expect(projectChipsBoardId({ ...on, project: undefined })).toBeNull();
    expect(projectChipsBoardId({ ...on, project: { boardProjectId: null } })).toBeNull();
    expect(projectChipsBoardId({ ...on, project: { boardProjectId: "  " } })).toBeNull();
  });
});

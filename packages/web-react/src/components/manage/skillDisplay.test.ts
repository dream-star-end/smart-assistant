import { describe, expect, test } from "vitest";
import { skillDisplayTitle } from "./skillDisplay";

describe("skillDisplayTitle", () => {
  test("无 description 时回退 name 作标题、无 caption", () => {
    expect(skillDisplayTitle({ name: "写作助手" })).toEqual({ title: "写作助手" });
    expect(skillDisplayTitle({ name: "写作助手", description: "" })).toEqual({ title: "写作助手" });
    expect(skillDisplayTitle({ name: "写作助手", description: "  \n第二行" })).toEqual({
      title: "写作助手",
    });
  });

  test("有 description 时第一行作标题、name 作 caption", () => {
    expect(skillDisplayTitle({ name: "write-helper", description: "写作助手" })).toEqual({
      title: "写作助手",
      caption: "write-helper",
    });
    expect(
      skillDisplayTitle({ name: "write-helper", description: "写作助手\n第二行说明" }),
    ).toEqual({ title: "写作助手", caption: "write-helper" });
    expect(
      skillDisplayTitle({ name: "write-helper", description: "写作助手\r\n第二行说明" }),
    ).toEqual({ title: "写作助手", caption: "write-helper" });
  });
});

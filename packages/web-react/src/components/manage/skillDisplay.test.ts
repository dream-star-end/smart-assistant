import { describe, expect, test } from "vitest";
import { isSecretSkill, skillDisplayTitle, skillHeading } from "./skillDisplay";

describe("isSecretSkill", () => {
  test("改造前写死的三个 slug 都按规则命中", () => {
    for (const name of [
      "v5-selfhost-cursor-account-pool",
      "v5-selfhost-cursor-key-rotation",
      "v5-selfhost-moonshot-k3-key-sync",
    ]) {
      expect(isSecretSkill({ name })).toBe(true);
    }
  });

  test("按名称分段与标签判定，普通技能不误判", () => {
    expect(isSecretSkill({ name: "github-token-refresh" })).toBe(true);
    expect(isSecretSkill({ name: "vault_secret_sync" })).toBe(true);
    expect(isSecretSkill({ name: "zsxq-publish", tags: ["发布", "密钥"] })).toBe(true);
    expect(isSecretSkill({ name: "zsxq-publish", tags: ["发布"] })).toBe(false);
    // 「keyboard」「monkey」这类只是含子串、不是独立分段的名字不能误判。
    expect(isSecretSkill({ name: "keyboard-shortcuts" })).toBe(false);
    expect(isSecretSkill({ name: "monkey-test" })).toBe(false);
    expect(isSecretSkill({ name: "longform-infographic" })).toBe(false);
  });
});

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

describe("skillHeading", () => {
  test("取正文第一个一级标题,去掉首尾空白与收尾 #", () => {
    expect(skillHeading("# 顾问模式：参考核验与设计检查\n\n## 何时使用")).toBe("顾问模式：参考核验与设计检查");
    expect(skillHeading("引言\n\n#  部署清单  ##\n# 第二个")).toBe("部署清单");
  });
  test("没有一级标题(只有二级 / 空正文)返回 null", () => {
    expect(skillHeading("## 只有二级标题\n正文")).toBeNull();
    expect(skillHeading("")).toBeNull();
    expect(skillHeading(undefined)).toBeNull();
    expect(skillHeading("#没有空格不算标题")).toBeNull();
  });
  test("收尾 # 要隔空格才去掉;围栏代码块里的 # 注释不算标题(Codex r1)", () => {
    expect(skillHeading("# C#")).toBe("C#");
    expect(skillHeading("# 发布 #")).toBe("发布");
    expect(skillHeading("```bash\n# Install dependencies\nnpm i\n```\n# 真正的标题")).toBe("真正的标题");
    expect(skillHeading("~~~\n# 注释\n~~~")).toBeNull();
  });
  test("围栏按 CommonMark 收栏(同字符、不短于开栏、无尾随内容);空标题返回 null(Codex r2)", () => {
    expect(skillHeading("~~~~\n~~~\n# 假的\n~~~~\n# 真的")).toBe("真的");
    expect(skillHeading("~~~\n~~~oops\n# 假的\n~~~\n# 真的")).toBe("真的");
    expect(skillHeading("\t~~~\n# 真的")).toBe("真的");
    expect(skillHeading("``` a`b\n# 真的")).toBe("真的");
    expect(skillHeading("# ###")).toBeNull();
    expect(skillHeading("#")).toBeNull();
  });
});

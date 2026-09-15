import { describe, expect, test } from "vitest";
import { isSecretSkill, skillDisplayTitle } from "./skillDisplay";

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

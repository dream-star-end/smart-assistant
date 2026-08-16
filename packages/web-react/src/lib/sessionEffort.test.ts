import { beforeEach, describe, expect, test } from "vitest";
import {
  clearSessionEffort,
  effortSessionKey,
  readSessionEffort,
  writeSessionEffort,
} from "./sessionEffort";

// 思考档位会话级持久化的纯逻辑单测(三态语义:undefined=未选择继承偏好 / null=显式
// 跟随模型默认 / 档位=显式选择;会话隔离 + 删除清键)。jsdom 提供 localStorage。
describe("sessionEffort 会话级持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("键名:per-session 键带会话 id 前缀", () => {
    expect(effortSessionKey("s1")).toBe("oc_v5_effort:s1");
  });

  test("缺键 = undefined(未选择,发送时继承全局偏好);sessionId 为空同样 undefined", () => {
    expect(readSessionEffort("s1")).toBeUndefined();
    expect(readSessionEffort(undefined)).toBeUndefined();
  });

  test("显式档位:写入并读回;null 落盘为 \"-\"(显式跟随模型默认,区别于缺键)", () => {
    writeSessionEffort("s1", "high");
    expect(readSessionEffort("s1")).toBe("high");
    expect(localStorage.getItem(effortSessionKey("s1"))).toBe("high");

    writeSessionEffort("s1", null);
    expect(localStorage.getItem(effortSessionKey("s1"))).toBe("-");
    expect(readSessionEffort("s1")).toBeNull();
  });

  test("会话隔离:A 的选择不影响 B", () => {
    writeSessionEffort("A", "max");
    expect(readSessionEffort("B")).toBeUndefined();
    writeSessionEffort("B", null);
    expect(readSessionEffort("A")).toBe("max");
    expect(readSessionEffort("B")).toBeNull();
  });

  test("非法落盘值保守回退 undefined;sessionId 为空不写键", () => {
    localStorage.setItem(effortSessionKey("s1"), "ultra");
    expect(readSessionEffort("s1")).toBeUndefined();
    writeSessionEffort(undefined, "high");
    expect(localStorage.getItem(effortSessionKey("undefined"))).toBeNull();
  });

  test("删除会话清键,不留孤儿", () => {
    writeSessionEffort("s1", "low");
    clearSessionEffort("s1");
    expect(readSessionEffort("s1")).toBeUndefined();
  });
});

import { describe, expect, test } from "vitest";
import { parsePartialJson } from "./partialJson";

describe("parsePartialJson 容错流式解析 (P5)", () => {
  test("完整 JSON 对象 → 原样解析", () => {
    expect(parsePartialJson('{"file_path":"/a.ts","limit":80,"ok":true}')).toEqual({
      file_path: "/a.ts",
      limit: 80,
      ok: true,
    });
  });

  test("空 / 非字符串 → {}", () => {
    expect(parsePartialJson("")).toEqual({});
    // @ts-expect-error 故意传非字符串验证防御
    expect(parsePartialJson(null)).toEqual({});
  });

  test("顶层非对象（数组 / 标量）→ {}", () => {
    expect(parsePartialJson("[1,2,3]")).toEqual({});
    expect(parsePartialJson('"hello"')).toEqual({});
  });

  test("Edit 边流场景：file_path/old_string 完整，new_string 正在键入（部分尾串保留）", () => {
    const buf = '{"file_path":"/a.ts","old_string":"foo","new_string":"ba';
    expect(parsePartialJson(buf)).toEqual({
      file_path: "/a.ts",
      old_string: "foo",
      new_string: "ba",
    });
  });

  test("半截 key 立即停止（不臆造）", () => {
    expect(parsePartialJson('{"file_path":"/a.ts","old_str')).toEqual({ file_path: "/a.ts" });
  });

  test("字符串内转义被正确解码", () => {
    expect(parsePartialJson('{"s":"line1\\nline2\\t\\"q\\""}')).toEqual({ s: 'line1\nline2\t"q"' });
  });

  test("末尾孤立反斜杠从部分尾串丢弃", () => {
    expect(parsePartialJson('{"s":"abc\\')).toEqual({ s: "abc" });
  });

  test("嵌套对象：配平则取出，未配平则跳过该字段", () => {
    expect(parsePartialJson('{"a":1,"obj":{"x":2}}')).toEqual({ a: 1, obj: { x: 2 } });
    // obj 未配平 → 跳过 obj，但 a 已取出
    expect(parsePartialJson('{"a":1,"obj":{"x":2')).toEqual({ a: 1 });
  });

  test("数组值：配平取出", () => {
    expect(parsePartialJson('{"ids":["a","b"]}')).toEqual({ ids: ["a", "b"] });
  });

  test("数字 / bool / null 仅在终结后取出；半截原始值丢弃", () => {
    expect(parsePartialJson('{"n":42,"b":false,"z":null}')).toEqual({ n: 42, b: false, z: null });
    // 末尾半截数字 → 丢弃
    expect(parsePartialJson('{"done":true,"n":12')).toEqual({ done: true });
  });
});

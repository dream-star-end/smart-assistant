import { afterEach, describe, expect, it } from "vitest";
import {
  dismissSuggestion,
  readDismissedSuggestions,
  suggestProjectForChat,
  titleGrams,
} from "./unfiledSuggest";

const P = [
  { id: "paper", archivedAt: null },
  { id: "infra", archivedAt: null },
  { id: "old", archivedAt: 1 },
];
const S = [
  { id: "a", title: "锂金属电池综述的引言部分", projectId: "paper" },
  { id: "b", title: "锂金属电池综述的图表整理", projectId: "paper" },
  { id: "c", title: "部署脚本超时排查", projectId: "infra" },
  { id: "d", title: "锂金属电池综述的引言部分再改一版", projectId: "old" },
];

afterEach(() => localStorage.clear());

describe("unfiled chat suggestion", () => {
  it("splits CJK into bigrams and keeps ASCII words", () => {
    expect(titleGrams("V5 部署")).toEqual(["v5", "部署"]);
    expect(titleGrams("锂金属")).toEqual(["锂金", "金属"]);
  });

  it("suggests the project of a near-identical chat title", () => {
    const r = suggestProjectForChat({ id: "x", title: "锂金属电池综述的引言部分", projectId: null }, S, P);
    expect(r?.projectId).toBe("paper");
  });

  it("no suggestion when unsure, for chats already in a project, or toward archived projects", () => {
    expect(suggestProjectForChat({ id: "x", title: "今天天气怎么样", projectId: null }, S, P)).toBeNull();
    expect(suggestProjectForChat({ id: "x", title: "锂金属电池综述的引言部分", projectId: "infra" }, S, P)).toBeNull();
    const onlyArchived = suggestProjectForChat(
      { id: "x", title: "锂金属电池综述的引言部分再改一版", projectId: null },
      S.filter((s) => s.projectId === "old"),
      P,
    );
    expect(onlyArchived).toBeNull();
  });

  it("no suggestion when two projects are about equally likely", () => {
    const tie = [
      { id: "a", title: "周报整理", projectId: "paper" },
      { id: "c", title: "周报整理", projectId: "infra" },
    ];
    expect(suggestProjectForChat({ id: "x", title: "周报整理", projectId: null }, tie, P)).toBeNull();
  });

  it("dismissals are remembered per account", () => {
    dismissSuggestion("u1", "s1");
    expect(readDismissedSuggestions("u1").has("s1")).toBe(true);
    expect(readDismissedSuggestions("u2").has("s1")).toBe(false);
  });
});

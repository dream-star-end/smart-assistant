import { beforeEach, describe, expect, test } from "vitest";
import {
  TEAM_MODE_GLOBAL_KEY,
  clearTeamModeForSession,
  readTeamModeForSession,
  teamModeSessionKey,
  writeTeamMode,
} from "./teamMode";

// 团队模式会话级持久化的纯逻辑单测(读写 + 新会话默认继承 + 会话隔离)。
// jsdom 提供 localStorage;每例前清空,互不污染。
describe("teamMode 会话级持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("键名:per-session 键在全局键后缀会话 id", () => {
    expect(teamModeSessionKey("s1")).toBe(`${TEAM_MODE_GLOBAL_KEY}:s1`);
  });

  test("全空:任何会话都读到 false", () => {
    expect(readTeamModeForSession(undefined)).toBe(false);
    expect(readTeamModeForSession("s1")).toBe(false);
  });

  test("开关切换同时写 per-session 键 + 全局默认键", () => {
    writeTeamMode("s1", true);
    expect(localStorage.getItem(teamModeSessionKey("s1"))).toBe("1");
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBe("1");
    expect(readTeamModeForSession("s1")).toBe(true);
  });

  test("关掉的会话落地显式 \"0\":不回退全局默认(A 关掉不被别处开关翻动)", () => {
    // A 关掉 → per-session[A]="0",全局默认被清。
    writeTeamMode("A", false);
    expect(localStorage.getItem(teamModeSessionKey("A"))).toBe("0");
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBeNull();
    // 别处会话 B 打开 → 全局默认变 "1"。
    writeTeamMode("B", true);
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBe("1");
    // A 仍读到 false(靠自己的显式 "0",不回退到已翻成 "1" 的全局默认)。
    expect(readTeamModeForSession("A")).toBe(false);
    // B 读到 true。
    expect(readTeamModeForSession("B")).toBe(true);
  });

  test("新会话继承全局偏好默认值(上次开着 → 新会话默认开着)", () => {
    // 用户在某会话开过 → 全局默认为 "1"。
    writeTeamMode("prev", true);
    // 从未设过自己键的新会话:回退全局默认 → true。
    expect(readTeamModeForSession("brandNew")).toBe(true);
    // 空会话态(无 sessionId)同样读全局默认。
    expect(readTeamModeForSession(undefined)).toBe(true);
  });

  test("会话一旦有自己的键,后续全局默认变化不再影响它", () => {
    writeTeamMode("pinned", true); // per-session[pinned]="1"
    writeTeamMode("other", false); // 全局默认被清(other 关掉)
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBeNull();
    // pinned 靠自己的键,仍 true。
    expect(readTeamModeForSession("pinned")).toBe(true);
  });

  test("会话之间相互隔离", () => {
    writeTeamMode("s1", true);
    writeTeamMode("s2", false);
    expect(readTeamModeForSession("s1")).toBe(true);
    expect(readTeamModeForSession("s2")).toBe(false);
  });

  test("sessionId 为空:只写全局默认,不产生 per-session 键", () => {
    writeTeamMode(undefined, true);
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBe("1");
    // 不应出现任何 `${GLOBAL}:` 前缀的会话键。
    const sessionKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith(`${TEAM_MODE_GLOBAL_KEY}:`),
    );
    expect(sessionKeys).toEqual([]);
  });

  test("clearTeamModeForSession 删除 per-session 键,不动全局默认", () => {
    writeTeamMode("gone", true);
    expect(localStorage.getItem(teamModeSessionKey("gone"))).toBe("1");
    clearTeamModeForSession("gone");
    expect(localStorage.getItem(teamModeSessionKey("gone"))).toBeNull();
    // 全局默认(偏好)保留 —— 只清会话自己的记忆。
    expect(localStorage.getItem(TEAM_MODE_GLOBAL_KEY)).toBe("1");
    // 清后该会话回退全局默认。
    expect(readTeamModeForSession("gone")).toBe(true);
  });
});

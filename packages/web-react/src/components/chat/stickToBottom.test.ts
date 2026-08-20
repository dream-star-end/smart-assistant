import { describe, expect, test } from "vitest";
import { createStickToBottomController, isNearBottom } from "./stickToBottom";

function scroller(partial: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  return { ...partial };
}

describe("stickToBottom", () => {
  test("距底 <80px 视为贴底", () => {
    expect(isNearBottom(scroller({ scrollHeight: 1000, scrollTop: 900, clientHeight: 80 }))).toBe(true);
    expect(isNearBottom(scroller({ scrollHeight: 1000, scrollTop: 800, clientHeight: 80 }))).toBe(false);
  });

  test("内容高度晚长的 scroll 事件不解除跟随", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 800, scrollTop: 720, clientHeight: 80 });
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(800);
    stick.onScroll(el);
    el.scrollHeight = 1100;
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
  });

  test("用户上滚后解除跟随，回到底部后恢复", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 200, clientHeight: 80 });
    stick.markUserIntent();
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
    el.scrollTop = 920;
    stick.markUserIntent();
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
  });
});

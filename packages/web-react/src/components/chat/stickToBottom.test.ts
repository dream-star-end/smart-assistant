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

  test("移动端首次上滑优先于尚未消费的程序化贴底事件", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    const bottom = el.scrollTop;

    // Mobile browsers may coalesce the programmatic scroll event with the
    // first tiny touch scroll. Even inside the 80px resume threshold, moving
    // away from the bottom is explicit user intent and must stop following.
    stick.markUserIntent();
    el.scrollTop = bottom - 8;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
  });
});

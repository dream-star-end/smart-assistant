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
    expect(el.scrollTop).toBe(720);
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

    stick.markUserIntent();
    el.scrollTop = bottom - 8;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
  });

  test("流式增高后用户离底，controller 写入不能把视口抢回", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1220);

    el.scrollTop = 1212;
    stick.onScroll(el);
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(8);
    expect(stick.following.current).toBe(false);
  });

  test("手势锁立刻禁止 restick，流式贴底不能抢先写回底部", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.canRestick.current).toBe(true);

    stick.markUserIntent();
    expect(stick.following.current).toBe(true);
    expect(stick.canRestick.current).toBe(false);

    const pinnedTop = el.scrollTop;
    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(pinnedTop);
    expect(el.scrollTop).not.toBe(el.scrollHeight);

    el.scrollTop = pinnedTop - 8;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);

    stick.releaseUserIntent();
    expect(stick.following.current).toBe(false);
    expect(stick.canRestick.current).toBe(false);
  });

  test("分段 1px 上滑累计后解锁仍禁止 restick", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    const bottom = el.scrollTop;

    const startGap = el.scrollHeight - bottom - el.clientHeight;
    for (let step = 1; step <= 8; step += 1) {
      stick.markUserIntent();
      el.scrollTop = bottom - step;
      stick.onScroll(el);
    }
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(startGap + 8);
    expect(stick.following.current).toBe(false);

    stick.releaseUserIntent();
    expect(stick.canRestick.current).toBe(false);

    const pinnedTop = el.scrollTop;
    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(pinnedTop);
  });

  test("轻触未离底，松手后恢复可贴底", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.markUserIntent();
    expect(stick.canRestick.current).toBe(false);
    stick.releaseUserIntent();
    expect(stick.following.current).toBe(true);
    expect(stick.canRestick.current).toBe(true);
  });

  test("惯性滚动在 userIntent 被消费后仍按离底解除跟随", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    const bottom = el.scrollTop;

    const startGap = el.scrollHeight - bottom - el.clientHeight;
    stick.markUserIntent();
    el.scrollTop = bottom - 1;
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
    expect(stick.gesture.current).toBe(false);

    for (let step = 2; step <= 9; step += 1) {
      el.scrollTop = bottom - step;
      stick.onScroll(el);
    }
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(startGap + 9);
    expect(stick.following.current).toBe(false);

    stick.releaseUserIntent();
    expect(stick.canRestick.current).toBe(false);

    const pinnedTop = el.scrollTop;
    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(pinnedTop);
  });

  test("无 mark 的滚动条离底解除跟随", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.onScroll(el);
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(0);
    expect(stick.following.current).toBe(true);

    el.scrollTop = 870;
    stick.onScroll(el);
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(50);
    expect(stick.following.current).toBe(false);
  });

  test("scrollHeight 收缩 clamp 不当成用户上滑、不误 re-follow", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    el.scrollHeight = 200;
    el.scrollTop = 120;
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    stick.following.current = false;
    el.scrollHeight = 150;
    el.scrollTop = 70;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
    expect(isNearBottom(el)).toBe(true);
  });

  test("写入竞态:用户上滑后、scroll 事件到达前 pin 检出偏离", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    const bottom = el.scrollTop;

    el.scrollTop = bottom - 8;
    stick.scrollToBottom(el);
    expect(stick.following.current).toBe(false);
    expect(el.scrollTop).toBe(bottom - 8);
  });

  test("两次写入合并成一个 scroll 事件", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 800, scrollTop: 720, clientHeight: 80 });
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(720);
    el.scrollHeight = 1100;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1020);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
    el.scrollHeight = 1400;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1320);
  });

  test("programmatic 贴底不清 following", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);
  });
});

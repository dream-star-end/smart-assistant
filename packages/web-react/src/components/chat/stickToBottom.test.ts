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
    expect(stick.following.current).toBe(false);
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

  test("按住滚动条连续拖动时 scroll 事件不解锁，视口校正不能抢写", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 2000, scrollTop: 1920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    stick.beginDirectManipulation();
    el.scrollTop = 1500;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
    expect(stick.directManipulation.current).toBe(true);

    stick.correctTo(el, 1580);
    expect(el.scrollTop).toBe(1500);
    el.scrollTop = 900;
    stick.onScroll(el);
    stick.correctTo(el, 980);
    expect(el.scrollTop).toBe(900);
    expect(stick.canRestick.current).toBe(false);

    stick.endDirectManipulation();
    stick.correctTo(el, 940);
    expect(el.scrollTop).toBe(940);
  });

  test("触摸按下但尚未产生 scroll 时，贴底与校正都不得夺走手势", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.beginDirectManipulation();
    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    stick.correctTo(el, 1220);
    expect(el.scrollTop).toBe(920);
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

  test("流式增高中用户上滑 1px 即 leave，后续 RO/流式写入被放弃", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1220);
    stick.onScroll(el);

    stick.markUserIntent();
    el.scrollTop = 1219;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(1);

    const pinnedTop = el.scrollTop;
    el.scrollHeight = 1600;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(pinnedTop);
    expect(stick.following.current).toBe(false);
    expect(stick.canRestick.current).toBe(false);
  });

  test("无 mark 的 1px clamp 不误 unfollow", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 1000, scrollTop: 920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    el.scrollTop = 919;
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    el.scrollHeight = 1300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1220);
    expect(stick.following.current).toBe(true);
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

  test("滚轮篱笆跨多个 scroll 事件不释放，期间贴底与校正都不写 scrollTop", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    stick.beginWheelFence();
    el.scrollTop = 3800;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
    expect(stick.wheelFence.current).toBe(true);

    // 上方行从 200px 估高变真实高度 → RO/画窗要求 +60 校正；篱笆期间不得写。
    stick.correctTo(el, 3860);
    expect(el.scrollTop).toBe(3800);
    el.scrollTop = 3600;
    stick.onScroll(el);
    stick.correctTo(el, 3660);
    expect(el.scrollTop).toBe(3600);
    expect(stick.wheelFence.current).toBe(true);
    expect(stick.canRestick.current).toBe(false);

    el.scrollHeight = 4400;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(3600);
  });

  test("滚轮篱笆释放后不补写被丢弃的校正，之后的校正立刻生效", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    stick.beginWheelFence();
    el.scrollTop = 3000;
    stick.onScroll(el);
    stick.correctTo(el, 3060);
    el.scrollTop = 2800;
    stick.onScroll(el);
    stick.correctTo(el, 2840);
    expect(el.scrollTop).toBe(2800);

    stick.endWheelFence();
    expect(stick.wheelFence.current).toBe(false);
    expect(el.scrollTop).toBe(2800);
    expect(stick.following.current).toBe(false);

    stick.correctTo(el, 2820);
    expect(el.scrollTop).toBe(2820);
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
  });

  test("篱笆期间用户滚回底部即 re-follow，释放后贴底恢复", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    stick.beginWheelFence();
    el.scrollTop = 3000;
    stick.onScroll(el);
    stick.correctTo(el, 3080);
    el.scrollTop = 3920;
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    el.scrollHeight = 4300;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(3920);
    stick.endWheelFence();
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(4220);
  });

  test("直接操作与滚轮篱笆叠加时，任一篱笆在场都不写", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    stick.beginDirectManipulation();
    stick.beginWheelFence();
    el.scrollTop = 3000;
    stick.onScroll(el);
    stick.correctTo(el, 3050);
    stick.endWheelFence();
    stick.correctTo(el, 3050);
    expect(el.scrollTop).toBe(3000);
    stick.endDirectManipulation();
    stick.correctTo(el, 3050);
    expect(el.scrollTop).toBe(3050);
  });

  test("上滑与 clientHeight 增大合并进同一 scroll 事件：clamp 巧合不能吞掉 leave", () => {
    // 用户上滑几像素的同时底部 HUD/横幅收起，clientHeight 变大，浏览器把 scrollTop
    // 夹到新 max。旧逻辑把这个 clamp 当成 scrollHeight 收缩、直接 return，following
    // 仍为 true，篱笆一释放流式 pin 就把视口写回底部。
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 2000, scrollTop: 1920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);
    expect(stick.following.current).toBe(true);

    stick.markUserIntent();
    el.clientHeight = 200; // 底部 120px 占位收起
    el.scrollTop = 1800; // = 新 maxScrollTop，看起来像 clamp
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);

    el.scrollHeight = 2400;
    stick.scrollToBottom(el);
    expect(el.scrollTop).toBe(1800);
  });

  test("无 mark 时 clientHeight 增大造成的 clamp 也不算 leave，但不因此 re-follow", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 2000, scrollTop: 1920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    el.clientHeight = 200;
    el.scrollTop = 1800;
    stick.onScroll(el);
    // viewportGrew 路径不走 clamp 短路；current(1800) < expected(clamped 1800)? 否 → 保持 following
    expect(stick.following.current).toBe(true);

    stick.following.current = false;
    el.clientHeight = 300;
    el.scrollTop = 1700;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);
  });

  test("有 mark 时 correctTo 不写：校正不能抢走用户刚发起的滚动", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3920, clientHeight: 80 });
    stick.scrollToBottom(el);
    stick.onScroll(el);

    // 首个 wheel tick：mark 已置，篱笆尚未挂上，RO 校正此刻到达
    stick.markUserIntent();
    stick.correctTo(el, 3960);
    expect(el.scrollTop).toBe(3920);

    el.scrollTop = 3900;
    stick.onScroll(el);
    expect(stick.following.current).toBe(false);

    stick.releaseUserIntent();
    stick.correctTo(el, 3940);
    expect(el.scrollTop).toBe(3940);
  });

  test("reset 清掉滚轮篱笆", () => {
    const stick = createStickToBottomController();
    const el = scroller({ scrollHeight: 4000, scrollTop: 3000, clientHeight: 80 });
    stick.beginWheelFence();
    stick.reset();
    expect(stick.wheelFence.current).toBe(false);
    expect(stick.canRestick.current).toBe(true);
    stick.correctTo(el, 3100);
    expect(el.scrollTop).toBe(3100);
  });
});

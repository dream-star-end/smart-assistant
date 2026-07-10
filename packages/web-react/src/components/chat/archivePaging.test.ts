import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  correctedScrollTop,
  loadedArchivedCount,
  planLoadMore,
} from "./archivePaging";

function row(seq?: number): Pick<ChatMessage, "_seq"> {
  return seq === undefined ? {} : { _seq: seq };
}

describe("loadedArchivedCount", () => {
  test("无水位(0/负)→ 恒 0(无归档会话)", () => {
    expect(loadedArchivedCount([row(1), row(2)], 0)).toBe(0);
    expect(loadedArchivedCount([row(1)], -5)).toBe(0);
  });

  test("只数 _seq ≤ 水位的行;尾巴(> 水位)与本地无 _seq 行不计", () => {
    const msgs = [row(3), row(4), row(10), row(11), row()]; // 水位=5:seq 3,4 是已拉归档
    expect(loadedArchivedCount(msgs, 5)).toBe(2);
  });

  test("边界 _seq === 水位 计入(≤)", () => {
    expect(loadedArchivedCount([row(5), row(6)], 5)).toBe(1);
  });

  test("全是尾巴(无归档拉回)→ 0", () => {
    expect(loadedArchivedCount([row(100), row(101), row()], 5)).toBe(0);
  });
});

describe("correctedScrollTop", () => {
  test("把前插前后的高度差全部计入 → 视口锚定原位置", () => {
    // 插入前高度 1000、scrollTop 0;插入 600px 旧内容后高度 1600 → scrollTop 应顶回 600。
    expect(correctedScrollTop(1000, 1600, 0)).toBe(600);
  });
  test("保留原有偏移量", () => {
    expect(correctedScrollTop(1000, 1600, 120)).toBe(720);
  });
  test("高度未变 → scrollTop 不动", () => {
    expect(correctedScrollTop(1000, 1000, 300)).toBe(300);
  });
});

describe("planLoadMore 按钮三态 + 切片起点", () => {
  test("本地未翻尽 + 无归档 → local,count=本地未挂,slice 藏最老", () => {
    // total 250,visible 100 → 150 未挂;无归档。
    const p = planLoadMore({ total: 250, visible: 100, archivedLoaded: 0, archivedCount: 0 });
    expect(p.button).toEqual({ mode: "local", count: 150 });
    expect(p.sliceStart).toBe(150);
  });

  test("本地未翻尽 + 有归档未拉 → local,count 含归档未拉(§4 计数含归档数)", () => {
    // 150 本地未挂 + 500 归档未拉 = 650。
    const p = planLoadMore({ total: 250, visible: 100, archivedLoaded: 0, archivedCount: 500 });
    expect(p.button).toEqual({ mode: "local", count: 650 });
    expect(p.sliceStart).toBe(150);
  });

  test("本地翻尽 + 有归档未拉 → cloud,remaining=归档未拉,slice=0(全挂)", () => {
    // visible ≥ total → 本地翻尽;归档 500 条一条未拉。
    const p = planLoadMore({ total: 250, visible: 300, archivedLoaded: 0, archivedCount: 500 });
    expect(p.button).toEqual({ mode: "cloud", remaining: 500 });
    expect(p.sliceStart).toBe(0);
  });

  test("本地翻尽 + 无归档 → null(无更早历史)", () => {
    const p = planLoadMore({ total: 250, visible: 300, archivedLoaded: 0, archivedCount: 0 });
    expect(p.button).toBeNull();
    expect(p.sliceStart).toBe(0);
  });

  test("拉一页归档后不变态:total 与 archivedLoaded 同增 → 仍 cloud、slice 仍 0(刚拉回的行不被再藏)", () => {
    // 拉回 100 条:total 250→350,archivedLoaded 0→100,visible 不变 300。
    const p = planLoadMore({ total: 350, visible: 300, archivedLoaded: 100, archivedCount: 500 });
    expect(p.sliceStart).toBe(0); // 差 (350-100)=250 ≤ visible 300 → 全挂,含刚拉回的 100
    expect(p.button).toEqual({ mode: "cloud", remaining: 400 }); // 500-100 已拉
  });

  test("归档全部拉尽 → null", () => {
    const p = planLoadMore({ total: 750, visible: 800, archivedLoaded: 500, archivedCount: 500 });
    expect(p.button).toBeNull();
    expect(p.sliceStart).toBe(0);
  });
});

import { describe, expect, test } from "vitest";
import { LEGAL_DOCS, TERMS_VERSION, filedIcp } from "./legal";

/** 把一篇法务文档的全部用户可见文本摊平(标题 / 引言 / 各节标题与段落)。 */
function allTexts(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const [kind, doc] of Object.entries(LEGAL_DOCS)) {
    out.push({ where: `${kind}.title`, text: doc.title });
    out.push({ where: `${kind}.intro`, text: doc.intro });
    doc.sections.forEach((s, i) => {
      out.push({ where: `${kind}.sections[${i}].h`, text: s.h });
      s.ps.forEach((p, j) => out.push({ where: `${kind}.sections[${i}].ps[${j}]`, text: p }));
    });
  }
  return out;
}

describe("法务正文标点(L-04)", () => {
  // 半角逗号 / 分号 / 冒号 / 括号 / 直引号一旦紧贴中文,就是排版事故;数字、英文、网址内部的半角标点不在此列。
  const HALF_WIDTH_NEXT_TO_CJK = /[\u4e00-\u9fa5][,;:()"]|[,;:()"][\u4e00-\u9fa5]/;

  test("全文没有夹在中文之间的半角标点", () => {
    const offenders = allTexts().filter(({ text }) => HALF_WIDTH_NEXT_TO_CJK.test(text));
    expect(offenders.map((o) => `${o.where}: ${o.text.match(HALF_WIDTH_NEXT_TO_CJK)?.[0]}`)).toEqual([]);
  });

  test("引号使用中文弯引号,不出现直引号", () => {
    const withStraightQuotes = allTexts().filter(({ text }) => text.includes('"'));
    expect(withStraightQuotes.map((o) => o.where)).toEqual([]);
    expect(LEGAL_DOCS.terms.intro).toContain("“本服务”");
    expect(LEGAL_DOCS.privacy.intro).toContain("“本平台”");
  });

  test("两篇文档的 updated 就是 TERMS_VERSION(展示层只标一次生效日期)", () => {
    expect(LEGAL_DOCS.terms.updated).toBe(TERMS_VERSION);
    expect(LEGAL_DOCS.privacy.updated).toBe(TERMS_VERSION);
  });
});

describe("filedIcp(备案号是否就位)", () => {
  test("占位文案 / 空值返回 null", () => {
    expect(filedIcp("备案信息更新中")).toBeNull();
    expect(filedIcp("")).toBeNull();
    expect(filedIcp("   ")).toBeNull();
    expect(filedIcp(undefined)).toBeNull();
    expect(filedIcp(null)).toBeNull();
  });

  test("真实备案号原样返回(去掉首尾空白)", () => {
    expect(filedIcp("赣ICP备2026123456号-1")).toBe("赣ICP备2026123456号-1");
    expect(filedIcp("  赣公网安备 36010002000123号 ")).toBe("赣公网安备 36010002000123号");
  });
});

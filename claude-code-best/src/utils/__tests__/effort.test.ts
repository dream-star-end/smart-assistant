import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

// Mock heavy dependencies to avoid import chain issues
mock.module("src/utils/thinking.js", () => ({
  isUltrathinkEnabled: () => false,
}));
mock.module("src/utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
}));
mock.module("src/utils/auth.js", () => ({
  isProSubscriber: () => false,
  isMaxSubscriber: () => false,
  isTeamSubscriber: () => false,
}));
mock.module("src/services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}));
mock.module("src/utils/model/modelSupportOverrides.js", () => ({
  get3PModelCapabilityOverride: () => undefined,
}));

const {
  isEffortLevel,
  parseEffortValue,
  isValidNumericEffort,
  convertEffortValueToLevel,
  getEffortLevelDescription,
  resolvePickerEffortPersistence,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
  EFFORT_LEVELS,
} = await import("src/utils/effort.js");

// ─── EFFORT_LEVELS constant ────────────────────────────────────────────

describe("EFFORT_LEVELS", () => {
  test("contains the five canonical levels", () => {
    // 'xhigh' added in commit 4bcf507 (Opus 4.7 + xhigh effort 等级)
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

// ─── isEffortLevel ─────────────────────────────────────────────────────

describe("isEffortLevel", () => {
  test("returns true for 'low'", () => {
    expect(isEffortLevel("low")).toBe(true);
  });

  test("returns true for 'medium'", () => {
    expect(isEffortLevel("medium")).toBe(true);
  });

  test("returns true for 'high'", () => {
    expect(isEffortLevel("high")).toBe(true);
  });

  test("returns true for 'max'", () => {
    expect(isEffortLevel("max")).toBe(true);
  });

  test("returns false for 'invalid'", () => {
    expect(isEffortLevel("invalid")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isEffortLevel("")).toBe(false);
  });
});

// ─── parseEffortValue ──────────────────────────────────────────────────

describe("parseEffortValue", () => {
  test("returns undefined for undefined", () => {
    expect(parseEffortValue(undefined)).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(parseEffortValue(null)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseEffortValue("")).toBeUndefined();
  });

  test("returns number for integer input", () => {
    expect(parseEffortValue(42)).toBe(42);
  });

  test("returns string for valid effort level string", () => {
    expect(parseEffortValue("low")).toBe("low");
    expect(parseEffortValue("medium")).toBe("medium");
    expect(parseEffortValue("high")).toBe("high");
    expect(parseEffortValue("max")).toBe("max");
  });

  test("parses numeric string to number", () => {
    expect(parseEffortValue("42")).toBe(42);
  });

  test("returns undefined for invalid string", () => {
    expect(parseEffortValue("invalid")).toBeUndefined();
  });

  test("non-integer number falls through to string parsing (parseInt truncates)", () => {
    // 3.14 fails isValidNumericEffort, then String(3.14) -> "3.14" -> parseInt = 3
    expect(parseEffortValue(3.14)).toBe(3);
  });

  test("handles case-insensitive effort level strings", () => {
    expect(parseEffortValue("LOW")).toBe("low");
    expect(parseEffortValue("HIGH")).toBe("high");
  });
});

// ─── isValidNumericEffort ──────────────────────────────────────────────

describe("isValidNumericEffort", () => {
  test("returns true for integer", () => {
    expect(isValidNumericEffort(50)).toBe(true);
  });

  test("returns true for zero", () => {
    expect(isValidNumericEffort(0)).toBe(true);
  });

  test("returns true for negative integer", () => {
    expect(isValidNumericEffort(-1)).toBe(true);
  });

  test("returns false for float", () => {
    expect(isValidNumericEffort(3.14)).toBe(false);
  });

  test("returns false for NaN", () => {
    expect(isValidNumericEffort(NaN)).toBe(false);
  });

  test("returns false for Infinity", () => {
    expect(isValidNumericEffort(Infinity)).toBe(false);
  });
});

// ─── convertEffortValueToLevel ─────────────────────────────────────────

describe("convertEffortValueToLevel", () => {
  test("returns valid effort level string as-is", () => {
    expect(convertEffortValueToLevel("low")).toBe("low");
    expect(convertEffortValueToLevel("medium")).toBe("medium");
    expect(convertEffortValueToLevel("high")).toBe("high");
    expect(convertEffortValueToLevel("max")).toBe("max");
  });

  test("returns 'high' for unknown string", () => {
    expect(convertEffortValueToLevel("unknown" as any)).toBe("high");
  });

  test("non-ant numeric value returns 'high'", () => {
    const saved = process.env.USER_TYPE;
    delete process.env.USER_TYPE;

    expect(convertEffortValueToLevel(50)).toBe("high");
    expect(convertEffortValueToLevel(100)).toBe("high");

    process.env.USER_TYPE = saved;
  });

  describe("ant numeric mapping", () => {
    let savedUserType: string | undefined;

    beforeEach(() => {
      savedUserType = process.env.USER_TYPE;
      process.env.USER_TYPE = "ant";
    });

    afterEach(() => {
      if (savedUserType === undefined) {
        delete process.env.USER_TYPE;
      } else {
        process.env.USER_TYPE = savedUserType;
      }
    });

    test("value <= 50 maps to 'low'", () => {
      expect(convertEffortValueToLevel(50)).toBe("low");
      expect(convertEffortValueToLevel(0)).toBe("low");
      expect(convertEffortValueToLevel(-10)).toBe("low");
    });

    test("value 51-85 maps to 'medium'", () => {
      expect(convertEffortValueToLevel(51)).toBe("medium");
      expect(convertEffortValueToLevel(85)).toBe("medium");
    });

    test("value 86-100 maps to 'high'", () => {
      expect(convertEffortValueToLevel(86)).toBe("high");
      expect(convertEffortValueToLevel(100)).toBe("high");
    });

    test("value 101-150 maps to 'xhigh'", () => {
      // commit 4bcf507: 101-150 → xhigh (Opus 4.7), >150 → max
      expect(convertEffortValueToLevel(101)).toBe("xhigh");
      expect(convertEffortValueToLevel(150)).toBe("xhigh");
    });

    test("value > 150 maps to 'max'", () => {
      expect(convertEffortValueToLevel(151)).toBe("max");
      expect(convertEffortValueToLevel(200)).toBe("max");
    });
  });
});

// ─── getEffortLevelDescription ─────────────────────────────────────────

describe("getEffortLevelDescription", () => {
  test("returns description for 'low'", () => {
    const desc = getEffortLevelDescription("low");
    expect(desc).toContain("Quick");
  });

  test("returns description for 'medium'", () => {
    const desc = getEffortLevelDescription("medium");
    expect(desc).toContain("Balanced");
  });

  test("returns description for 'high'", () => {
    const desc = getEffortLevelDescription("high");
    expect(desc).toContain("Comprehensive");
  });

  test("returns description for 'max'", () => {
    const desc = getEffortLevelDescription("max");
    expect(desc).toContain("Maximum");
  });
});

// ─── resolvePickerEffortPersistence ────────────────────────────────────

describe("resolvePickerEffortPersistence", () => {
  test("returns undefined when picked matches model default and no prior persistence", () => {
    const result = resolvePickerEffortPersistence("high", "high", undefined, false);
    expect(result).toBeUndefined();
  });

  test("returns picked when it differs from model default", () => {
    const result = resolvePickerEffortPersistence("low", "high", undefined, false);
    expect(result).toBe("low");
  });

  test("returns picked when priorPersisted is set (even if same as default)", () => {
    const result = resolvePickerEffortPersistence("high", "high", "high", false);
    expect(result).toBe("high");
  });

  test("returns picked when toggledInPicker is true (even if same as default)", () => {
    const result = resolvePickerEffortPersistence("high", "high", undefined, true);
    expect(result).toBe("high");
  });

  test("returns undefined picked value when no explicit and matches default", () => {
    const result = resolvePickerEffortPersistence(undefined, "high" as any, undefined, false);
    expect(result).toBeUndefined();
  });
});

// ─── DeepSeek V4 max effort support (2026-05-11) ───────────────────────
// commercial v3 接入 deepseek-v4 后,前端"思考深度"菜单要能让用户选 max。
// modelSupportsMaxEffort 必须放行 deepseek-v4-flash/pro,否则 resolveAppliedEffort
// 会把 max 降级成 high,proxy 出向 body 实际只有 effort='high'。

describe("modelSupportsMaxEffort - DeepSeek V4", () => {
  test("returns true for deepseek-v4-flash (exact)", () => {
    expect(modelSupportsMaxEffort("deepseek-v4-flash")).toBe(true);
  });

  test("returns true for deepseek-v4-pro (exact)", () => {
    expect(modelSupportsMaxEffort("deepseek-v4-pro")).toBe(true);
  });

  test("returns true case-insensitive", () => {
    expect(modelSupportsMaxEffort("DeepSeek-V4-Pro")).toBe(true);
  });

  test("returns false for future variants (not whitelisted)", () => {
    // 防止未来 deepseek 出 v4-pro-extra / v5-* 自动被放行 max
    expect(modelSupportsMaxEffort("deepseek-v4-pro-extra")).toBe(false);
    expect(modelSupportsMaxEffort("deepseek-v4-flash-128k")).toBe(false);
    expect(modelSupportsMaxEffort("deepseek-v5-pro")).toBe(false);
    expect(modelSupportsMaxEffort("deepseek-chat")).toBe(false);
    expect(modelSupportsMaxEffort("deepseek-reasoner")).toBe(false);
  });
});

describe("resolveAppliedEffort - DeepSeek V4", () => {
  // 关键回归:确保 max 不被静默降级成 high
  test("'max' on deepseek-v4-pro does not downgrade", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("deepseek-v4-pro", "max")).toBe("max");
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });

  test("'max' on deepseek-v4-flash does not downgrade", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("deepseek-v4-flash", "max")).toBe("max");
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });

  // xhigh 仍降级 — 我们刻意不动 modelSupportsXhighEffort
  // (deepseek 前端菜单不暴露 xhigh,即便误传也走 high 兜底,跟 deepseek
  // 上游 docs xhigh→max 映射不冲突,Opus 4.7 仍然是唯一 xhigh 模型)
  test("'xhigh' on deepseek-v4-pro still downgrades to 'high'", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("deepseek-v4-pro", "xhigh")).toBe("high");
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });

  test("'high' on deepseek-v4-pro stays 'high'", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("deepseek-v4-pro", "high")).toBe("high");
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });
});

describe("MiniMax-M3 effort support", () => {
  test("does not advertise or send effort parameters", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(modelSupportsEffort("MiniMax-M3")).toBe(false);
    expect(modelSupportsMaxEffort("MiniMax-M3")).toBe(false);
    expect(resolveAppliedEffort("MiniMax-M3", "max")).toBeUndefined();
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });
});

// glm-5.1/glm-5.2(火山 Ark)虽在"firstParty 能力全关"静态模型集(isCapabilityZeroStaticModel),
// 但**例外支持 output_config.effort**:火山端点接受 effort 思考深度(boss 2026-06-17 上线高/最高两档)。
// 行为与 deepseek-v4 对称(high/max 两档,默认 max,xhigh 降级 high)。master proxy 按 protocol
// allowedOutputConfigEfforts=['high','max'] 兜底清洗,CCB 层只负责按用户选择生成 effort 值。
// **对比 MiniMax-M3**(同 capabilityZero 但火山外、不在 isArkGlmModel):仍不发 effort(见上方测试)。
describe("glm-5.1 / glm-5.2 (Ark) effort support", () => {
  test("支持 effort 且放行 max(大小写不敏感)", () => {
    for (const m of ["glm-5.1", "GLM-5.1", "glm-5.2", "GLM-5.2"]) {
      expect(modelSupportsEffort(m)).toBe(true);
      expect(modelSupportsMaxEffort(m)).toBe(true);
    }
  });
  test("resolveAppliedEffort:max 保留 / high 保留 / xhigh 降级 high / 缺省默认 max", () => {
    const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    for (const m of ["glm-5.1", "glm-5.2"]) {
      expect(resolveAppliedEffort(m, "max")).toBe("max");
      expect(resolveAppliedEffort(m, "high")).toBe("high");
      // 火山无 xhigh 档:xhigh 降级 high(modelSupportsXhighEffort(glm)=false)
      expect(resolveAppliedEffort(m, "xhigh")).toBe("high");
      // 无显式输入:落 getDefaultEffortForModel(glm)=max
      expect(resolveAppliedEffort(m, undefined)).toBe("max");
    }
    if (saved !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  });
});

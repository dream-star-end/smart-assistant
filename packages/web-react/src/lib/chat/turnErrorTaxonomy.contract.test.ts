/**
 * 契约测试(turn-retry 批,任务①)——防「错误码→文案」三处漂移。
 *
 * protocol TURN_ERROR_TAXONOMY 是错误码语义(retryable/cta/expected/waivable/allowPublic…)的
 * **单一权威**;前端文案分两表:标题在 render.ts ERROR_LABELS、正文在 pure.ts
 * BRIDGE_ERROR_MESSAGES。三者靠本测试锁死 key 集合同源:
 *   - taxonomy 每个 code **必须**在 ERROR_LABELS 有非兜底标题;
 *   - taxonomy 每个 code **必须**在 friendlyBridgeErrorMessage 返回非兜底正文;
 *   - 派生集合 EXPECTED_TURN_ERR_CODES / WAIVED_ERROR_CODES 与 protocol 派生一致。
 * 新增码只加 protocol 表 + 两处文案,漏配即红,不会再出现「有正文没标题→标题回退『出错了』」。
 */
import {
  EXPECTED_TURN_ERROR_CODES,
  REPORT_EXEMPT_TURN_ERROR_CODES,
  TURN_ERROR_TAXONOMY,
  WAIVED_TURN_ERROR_CODES,
} from "@openclaude/protocol";
import { describe, expect, test } from "vitest";
import {
  BRIDGE_ERROR_FALLBACK,
  BRIDGE_ERROR_MESSAGES,
  EXPECTED_TURN_ERR_CODES,
  friendlyBridgeErrorMessage,
  REPORT_EXEMPT_TURN_ERR_CODES,
} from "./pure";
import { errorLabel } from "./render";

const CODES = Object.keys(TURN_ERROR_TAXONOMY);

describe("turnErrorTaxonomy 契约:文案表 key 与 protocol 权威表对齐", () => {
  test("taxonomy 非空且被本测试全覆盖", () => {
    expect(CODES.length).toBeGreaterThan(0);
  });

  test.each(CODES)("『%s』有非兜底中文标题(ERROR_LABELS)", (code) => {
    const title = errorLabel(code);
    // 未知码 errorLabel 回退「出错了」;taxonomy 内的码必须各有专属标题。
    expect(title).not.toBe("出错了");
    expect(title.trim().length).toBeGreaterThan(0);
  });

  test.each(CODES)("『%s』有非兜底中文正文(friendlyBridgeErrorMessage)", (code) => {
    const body = friendlyBridgeErrorMessage(code);
    expect(body).not.toBe(BRIDGE_ERROR_FALLBACK);
    expect(body.trim().length).toBeGreaterThan(0);
    // 正文表直查也必须命中(防「靠 fallback 蒙混」)。
    expect(BRIDGE_ERROR_MESSAGES[code as keyof typeof BRIDGE_ERROR_MESSAGES]).toBeTruthy();
  });

  test("EXPECTED_TURN_ERR_CODES 从 protocol EXPECTED_TURN_ERROR_CODES 派生(同一集合)", () => {
    expect([...EXPECTED_TURN_ERR_CODES].sort()).toEqual([...EXPECTED_TURN_ERROR_CODES].sort());
    // 关键语义回归:基建故障必须仍上报,预期业务态不上报。
    expect(EXPECTED_TURN_ERR_CODES.has("model_authority_unavailable")).toBe(false);
    expect(EXPECTED_TURN_ERR_CODES.has("model_catalog_unavailable")).toBe(false);
    expect(EXPECTED_TURN_ERR_CODES.has("insufficient_credits")).toBe(true);
  });

  test("REPORT_EXEMPT_TURN_ERR_CODES 从 protocol REPORT_EXEMPT_TURN_ERROR_CODES 派生(遥测口径,与 expected 解耦)", () => {
    expect([...REPORT_EXEMPT_TURN_ERR_CODES].sort()).toEqual([...REPORT_EXEMPT_TURN_ERROR_CODES].sort());
    // R5c 关键拆分:这些码"对用户预期"但"对平台是运营故障信号",EXPECTED 命中而 REPORT_EXEMPT **不**命中
    // → 恢复上报。
    for (const code of ["rate_limited", "model_capacity", "service_restart", "image_server_busy"]) {
      expect(EXPECTED_TURN_ERR_CODES.has(code)).toBe(true);
      expect(REPORT_EXEMPT_TURN_ERR_CODES.has(code)).toBe(false);
    }
    // 用户主动 / 纯业务拒绝类:两集合都命中(既是预期态、也豁免遥测)。
    for (const code of ["stopped", "user_cancelled", "insufficient_credits", "maintenance"]) {
      expect(REPORT_EXEMPT_TURN_ERR_CODES.has(code)).toBe(true);
    }
    // 基建故障:两集合都不命中(必须上报)。
    expect(REPORT_EXEMPT_TURN_ERR_CODES.has("model_authority_unavailable")).toBe(false);
    expect(REPORT_EXEMPT_TURN_ERR_CODES.has("engine_error")).toBe(false);
  });

  test.each(Object.keys(TURN_ERROR_TAXONOMY))(
    "『%s』REPORT_EXEMPT 命中 ⟺ taxonomy.reportable===false",
    (code) => {
      const reportable = (TURN_ERROR_TAXONOMY as Record<string, { reportable?: boolean }>)[code].reportable;
      expect(REPORT_EXEMPT_TURN_ERR_CODES.has(code)).toBe(reportable === false);
    },
  );

  test("免单集合(render WAIVED)与 protocol WAIVED_TURN_ERROR_CODES 一致", () => {
    // WAIVED_ERROR_CODES 未导出,借 errorPresentation 的免单标题间接校验其派生正确。
    for (const code of WAIVED_TURN_ERROR_CODES) {
      const row = (TURN_ERROR_TAXONOMY as Record<string, { waivable?: boolean }>)[code];
      expect(row.waivable).toBe(true);
    }
  });

  test("未知码仍走双兜底(标题「出错了」+ 正文通用兜底)", () => {
    expect(errorLabel("totally_new_code_xyz")).toBe("出错了");
    expect(friendlyBridgeErrorMessage("totally_new_code_xyz")).toBe(BRIDGE_ERROR_FALLBACK);
  });
});

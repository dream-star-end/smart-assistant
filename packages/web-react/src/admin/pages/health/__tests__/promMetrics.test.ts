import { describe, expect, test } from "vitest";
import {
  deriveHealthView,
  groupByLabel,
  histogramByLabel,
  parsePromLine,
  parsePromText,
  positiveEntriesDesc,
  statusColorToken,
  sumSeries,
} from "../promMetrics";

describe("parsePromLine", () => {
  test("解析带 label 的行（多 label + 数值）", () => {
    const r = parsePromLine('gateway_http_requests_total{status="200",method="GET"} 42');
    expect(r).toEqual({
      name: "gateway_http_requests_total",
      labels: { status: "200", method: "GET" },
      value: 42,
    });
  });

  test("无 label 行", () => {
    expect(parsePromLine("agent_containers_running 7")).toEqual({
      name: "agent_containers_running",
      labels: {},
      value: 7,
    });
  });

  test("末尾 timestamp 只取首个数字", () => {
    expect(parsePromLine("foo_total 12 1720000000000")?.value).toBe(12);
  });

  test("label value 反转义（\\\" 与 \\n）", () => {
    const r = parsePromLine('x{msg="a\\"b\\nc"} 1');
    expect(r?.labels.msg).toBe('a"b\nc');
  });

  test("注释 / 空行 / 非数字值 → null", () => {
    expect(parsePromLine("# HELP foo bar")).toBeNull();
    expect(parsePromLine("")).toBeNull();
    expect(parsePromLine("foo NaNval")).toBeNull();
  });
});

describe("parsePromText", () => {
  test("按 metric name 分桶", () => {
    const text = [
      "# comment",
      'gateway_http_requests_total{status="200"} 10',
      'gateway_http_requests_total{status="500"} 2',
      "agent_containers_running 3",
    ].join("\n");
    const m = parsePromText(text);
    expect(m.get("gateway_http_requests_total")).toHaveLength(2);
    expect(m.get("agent_containers_running")).toHaveLength(1);
  });
});

describe("groupByLabel", () => {
  test("按 label 求和聚合", () => {
    const m = parsePromText(
      [
        'billing_debit_total{result="success"} 5',
        'billing_debit_total{result="success"} 3',
        'billing_debit_total{result="error"} 1',
      ].join("\n"),
    );
    expect(groupByLabel(m.get("billing_debit_total"), "result")).toEqual({ success: 8, error: 1 });
  });

  test("undefined series → 空对象", () => {
    expect(groupByLabel(undefined, "x")).toEqual({});
  });
});

describe("sumSeries", () => {
  test("求和，undefined → 0", () => {
    const m = parsePromText('a{s="1"} 4\na{s="2"} 6');
    expect(sumSeries(m.get("a"))).toBe(10);
    expect(sumSeries(undefined)).toBe(0);
  });
});

describe("histogramByLabel", () => {
  test("avg = sum / count，按 label 聚合", () => {
    const m = parsePromText(
      [
        'anthropic_proxy_ttft_seconds_sum{model="opus"} 4',
        'anthropic_proxy_ttft_seconds_count{model="opus"} 2',
        'anthropic_proxy_ttft_seconds_sum{model="haiku"} 3',
        'anthropic_proxy_ttft_seconds_count{model="haiku"} 6',
      ].join("\n"),
    );
    const rows = histogramByLabel(m, "anthropic_proxy_ttft_seconds", "model");
    const opus = rows.find((r) => r.key === "opus");
    const haiku = rows.find((r) => r.key === "haiku");
    expect(opus).toMatchObject({ count: 2, sum: 4, avg: 2 });
    expect(haiku).toMatchObject({ count: 6, sum: 3, avg: 0.5 });
  });

  test("count=0 → avg=0（不除零）", () => {
    const m = parsePromText(
      ['h_sum{k="a"} 5', 'h_count{k="a"} 0'].join("\n"),
    );
    expect(histogramByLabel(m, "h", "k")[0]).toMatchObject({ count: 0, avg: 0 });
  });
});

describe("statusColorToken", () => {
  test("状态码 → 语义色 token", () => {
    expect(statusColorToken("200")).toBe("success");
    expect(statusColorToken("301")).toBe("info");
    expect(statusColorToken("404")).toBe("warning");
    expect(statusColorToken("500")).toBe("danger");
    expect(statusColorToken("unknown")).toBe("muted");
  });
});

describe("positiveEntriesDesc", () => {
  test("过滤 0 值并按值降序", () => {
    expect(positiveEntriesDesc({ a: 1, b: 0, c: 5 })).toEqual([
      ["c", 5],
      ["a", 1],
    ]);
  });
});

describe("deriveHealthView", () => {
  test("整段派生视图模型（total / ok / 5xx / TTFT ms）", () => {
    const text = [
      'gateway_http_requests_total{status="200"} 100',
      'gateway_http_requests_total{status="204"} 4',
      'gateway_http_requests_total{status="500"} 6',
      'agent_containers_running 9',
      'anthropic_proxy_reject_total{reason="quota"} 2',
      'account_pool_health{account_id="57",status="active"} 95',
      'account_pool_health{account_id="12",status="cooldown"} 40',
      'anthropic_proxy_ttft_seconds_sum{model="opus"} 2',
      'anthropic_proxy_ttft_seconds_count{model="opus"} 4',
    ].join("\n");
    const v = deriveHealthView(text);
    expect(v.reqTotal).toBe(110);
    expect(v.okStatusSum).toBe(104); // 200 + 204
    expect(v.errStatusSum).toBe(6); // 5xx
    expect(v.containersRunning).toBe(9);
    // account rows 按 health 升序
    expect(v.acctRows.map((r) => r.account_id)).toEqual(["12", "57"]);
    // TTFT: avg 0.5s → 500ms
    expect(v.ttftMsByModel.opus).toBe(500);
  });
});

#!/usr/bin/env node
// 冒烟门误报率统计(2026-10-08 冒烟健壮性)。只读日志,不连任何服务。
// 统计两类发布门:个人版 user-contract(C1–C3,TAP)与商业 e2e journey(J1–J5)。
// 每次失败按错误签名归类,区分「真失败」与「UI 收尾超时」这类误报候选,改进前后可直接对比。
//
// 用法:
//   node scripts/v5-smoke-flake-report.mjs [日志文件…]        # 缺省:个人版 train / cutover / deploy 日志
//   journalctl -u 'openclaude-v5-deploy-*' -o cat | node scripts/v5-smoke-flake-report.mjs -   # 商业 detached 发布日志
//   --json 输出机器可读结果
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const CLASSES = [
  // 环境/基础设施:浏览器、登录页、凭据、总预算。
  ["env", /找不到可用的 Chrome|Cold landing HTTP|Cold login not rendered|Four-minute total deadline|无法读取 canary 密码|J1-J4 在总防挂预算内未完成/],
  // 后端/产品真失败:轮次报错、未完成、失败卡、内容不对。门拦下它们是对的。
  ["real", /Exact turn returned an error|Exact turn did not complete|backend evidence lost|failure card|发送失败签名|错误\/空轮\/截断|未包含附件秘密探针|附件区未清空|must be hidden|identity\/model mismatch|engine mismatch|modelId mismatch/],
  // 后端已完成而 UI 没在窗口内收尾:误报候选(新版本会先复核后端再给一次有界宽限)。
  ["ui_settle", /Completed turn UI did not settle|回复在 \d+s 内未完成/],
  // 中途 UI 步骤等待超时(定位器 / 输入框 / 按钮)。
  ["ui_step_timeout", /Timeout \d+ms exceeded|超时窗内未变为可用|No outbound chat frame/],
];

export function classify(msg) {
  for (const [name, re] of CLASSES) if (re.test(msg)) return name;
  return "other";
}

// 返回 [{suite, check, ok, error?, cls?}] 与 slow-settle 告警数。
export function parseLog(text) {
  const results = [];
  let slow = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^# warn slow_ui_settle /.test(l)) slow++;
    let m = /^(ok|not ok) \d+ - (C\d) /.exec(l);
    if (m) {
      const ok = m[1] === "ok";
      let error = "";
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const e = /^# error (.*)$/.exec(lines[j]);
        if (e) { error = e[1]; break; }
      }
      if (!ok && /Prerequisite failed/.test(error)) continue; // 前一项已失败,本项未执行,不计
      results.push({ suite: "user-contract", check: m[2], ok, ...(ok ? {} : { error, cls: classify(error) }) });
      continue;
    }
    if (/e2e-journey: 旅程全过/.test(l)) { results.push({ suite: "journey", check: "J1-J5", ok: true }); continue; }
    m = /e2e-journey: ✗ 步骤「(J\d)[^」]*」失败: (.*)$/.exec(l);
    if (m) results.push({ suite: "journey", check: m[1], ok: false, error: m[2], cls: classify(m[2]) });
  }
  return { results, slow };
}

export function summarize(all) {
  const by = {};
  for (const r of all.results) {
    const k = `${r.suite}:${r.check}`;
    by[k] ??= { runs: 0, pass: 0, fail: 0, classes: {} };
    by[k].runs++;
    if (r.ok) by[k].pass++; else { by[k].fail++; by[k].classes[r.cls] = (by[k].classes[r.cls] ?? 0) + 1; }
  }
  return { checks: by, slowUiSettleWarnings: all.slow };
}

function defaultFiles() {
  const out = [];
  for (const dir of ["/opt/openclaude/tmp/lease-trains", "/opt/openclaude/tmp"]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/^(tr-.*|cutover-.*|deploy-.*)\.log$/.test(f)) out.push(join(dir, f));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((a) => a !== "--json");
  const sources = files.length ? files : defaultFiles();
  const all = { results: [], slow: 0 };
  for (const f of sources) {
    const text = f === "-" ? readFileSync(0, "utf8") : readFileSync(f, "utf8");
    const r = parseLog(text);
    all.results.push(...r.results);
    all.slow += r.slow;
  }
  const s = summarize(all);
  if (json) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
  console.log(`sources=${sources.length} slow_ui_settle_warnings=${s.slowUiSettleWarnings}`);
  for (const [k, v] of Object.entries(s.checks).sort()) {
    const falseCand = v.classes.ui_settle ?? 0;
    console.log(`${k.padEnd(22)} runs=${v.runs} fail=${v.fail} (${(100 * v.fail / v.runs).toFixed(1)}%) ui_settle=${falseCand} (${(100 * falseCand / v.runs).toFixed(1)}%) classes=${JSON.stringify(v.classes)}`);
  }
}

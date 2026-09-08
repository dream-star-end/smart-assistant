/**
 * Shared billing-test diagnostic collector for OCV5-188 A.
 * Integ and the pre-record-fail worker must use this same helper so a throw
 * before record() is counted as a failed scenario, not dropped from JSON.
 */
import assert from "node:assert/strict";

export const MISSING_RECORD_ACTUAL = "missing record — pre-record throw or skipped body";

export type BillingScenario = {
  id: string;
  expected: string;
  actual: string;
  upstreamCalls: number;
  terminal?: string;
  phase?: string;
  usage?: unknown;
  ledger?: unknown;
  pass: boolean;
  error?: string;
};

export type BillingDiagnosticReport = {
  suite: string;
  passed: number;
  failed: number;
  skipped: 0 | "before_failed";
  beforeError: string | null;
  registered: string[];
  recorded: string[];
  scenarios: BillingScenario[];
  [extra: string]: unknown;
};

export function createBillingDiagnostics(suite: string) {
  const scenarios: BillingScenario[] = [];
  const registeredIds: string[] = [];
  let beforeError: string | null = null;

  function expectScenario(id: string): void {
    registeredIds.push(id);
  }

  function record(s: BillingScenario): void {
    scenarios.push(s);
    assert.equal(s.pass, true, `${s.id}: expected ${s.expected} actual ${s.actual}`);
  }

  function noteBeforeError(err: unknown): void {
    beforeError = err instanceof Error ? err.message : String(err);
  }

  function sealMissingRecords(): void {
    for (const id of registeredIds) {
      if (!scenarios.some((s) => s.id === id)) {
        scenarios.push({
          id,
          expected: "record() reached",
          actual: MISSING_RECORD_ACTUAL,
          upstreamCalls: -1,
          pass: false,
        });
      }
    }
  }

  function summary(extra: Record<string, unknown> = {}): BillingDiagnosticReport {
    sealMissingRecords();
    const passed = scenarios.filter((s) => s.pass).length;
    const failed = scenarios.filter((s) => !s.pass).length;
    const payload: BillingDiagnosticReport = {
      suite,
      passed,
      failed,
      skipped: beforeError ? "before_failed" : 0,
      beforeError,
      registered: [...registeredIds],
      recorded: scenarios.map((s) => s.id),
      scenarios,
      ...extra,
    };
    if (failed > 0 || beforeError) process.exitCode = 1;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return payload;
  }

  return {
    expectScenario,
    record,
    noteBeforeError,
    summary,
    scenarios,
    registeredIds,
    get beforeError() {
      return beforeError;
    },
  };
}

export function parseDiagnosticReport(stdout: string, suite: string): BillingDiagnosticReport {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i]!.replace(/^#\s*/, "").trim();
    if (!raw.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(raw) as BillingDiagnosticReport;
      if (parsed.suite === suite) return parsed;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error(`no diagnostic JSON for suite ${suite} in worker stdout: ${stdout.slice(0, 400)}`);
}

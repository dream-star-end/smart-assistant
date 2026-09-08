/**
 * Controlled pre-record failure: proves diagnostics capture a throw before
 * record() and the process exits 1. Not part of the green integ suite / pr-2.
 *
 *   npx tsx --test packages/commercial/src/__tests__/cursorExternalApiPrerecordFail.unit.test.ts
 *   expected exit 1
 */
import { after, test } from "node:test";

const registered = ["pre-record-control"];
const scenarios: Array<{ id: string; pass: boolean; actual: string }> = [];

test("pre-record-control throws before record()", async () => {
  throw new Error("controlled pre-record failure");
});

after(() => {
  for (const id of registered) {
    if (!scenarios.some((s) => s.id === id)) {
      scenarios.push({ id, pass: false, actual: "threw or returned before record()" });
    }
  }
  const passed = scenarios.filter((s) => s.pass).length;
  const failed = scenarios.filter((s) => !s.pass).length;
  process.stdout.write(
    `${JSON.stringify({
      suite: "cursorExternalApiPrerecordFail",
      registered,
      passed,
      failed,
      skipped: 0,
      scenarios,
    })}\n`,
  );
  if (failed > 0) process.exitCode = 1;
});

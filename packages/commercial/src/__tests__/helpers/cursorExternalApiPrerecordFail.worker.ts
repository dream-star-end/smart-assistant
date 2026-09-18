/**
 * Inner worker: controlled throw before record() using the shared collector.
 * Must NOT be named *.test.ts — default test:commercial:unit find would pick it up.
 *
 *   npx tsx packages/commercial/src/__tests__/helpers/cursorExternalApiPrerecordFail.worker.ts
 *   expected exit 1, JSON failed=1
 */
import { createBillingDiagnostics } from "./cursorExternalApiDiagnostics.js";

const diag = createBillingDiagnostics("cursorExternalApiPrerecordFail");
diag.expectScenario("pre-record-control");
try {
  throw new Error("controlled pre-record failure");
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
} finally {
  diag.summary();
}

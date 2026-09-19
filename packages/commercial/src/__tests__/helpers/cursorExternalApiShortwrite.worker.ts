/**
 * Isolated OS short-write child. Applies RLIMIT_FSIZE to this pid only after
 * imports, so tsx/module loads are not quota-killed. argv: <dir> <intent|ready>
 */
import { spawnSync } from "node:child_process";
import { openCursorExternalApiOutbox } from "../../billing/cursorExternalApiOutbox.js";
import type { CursorExternalIntentRecord, CursorExternalReadyRecord } from "../../billing/cursorExternalApiOutbox.js";

const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || (mode !== "intent" && mode !== "ready")) {
  process.stderr.write("usage: shortwrite worker <dir> intent|ready\n");
  process.exit(2);
}

process.on("SIGXFSZ", () => undefined);
const limit = spawnSync(
  "python3",
  ["-c", "import os,resource; resource.prlimit(int(os.environ['TARGET_PID']), resource.RLIMIT_FSIZE, (512, 512))"],
  { encoding: "utf8", env: { ...process.env, TARGET_PID: String(process.pid) } },
);
if (limit.status !== 0) {
  process.stderr.write(`rlimit failed: ${limit.stderr || limit.stdout}\n`);
  process.exit(3);
}

const intent: CursorExternalIntentRecord = {
  schema: 1,
  phase: "intent",
  billingId: "a".repeat(32),
  userId: "3",
  modelId: "cursor-fable-5.1-high",
  accountId: "17",
  apiKeyId: "9",
  sessionId: null,
  turnKey: null,
  parentTurnKey: null,
  parentSessionId: null,
  delegateAgentId: null,
  basis: {
    modelId: "cursor-fable-5.1-high",
    displayName: `Fable-shortwrite-padding-${"x".repeat(600)}`,
    inputPerMtok: "1500",
    outputPerMtok: "7500",
    cacheReadPerMtok: "150",
    cacheWritePerMtok: "1875",
    catalogMultiplier: "1.000",
    settleSurcharge: null,
    capturedAt: "2026-09-08T00:00:00.000Z",
  },
  createdAt: "2026-09-08T00:00:00.000Z",
};

const box = await openCursorExternalApiOutbox({ directory });
let resolved = false;
let error: string | null = null;
try {
  if (mode === "intent") {
    await box.writeIntent(intent);
  } else {
    const ready: CursorExternalReadyRecord = {
      ...intent,
      phase: "ready",
      engineStatus: "success",
      terminalCode: null,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      plan: { settleStatus: "success", costCredits: "12", snapshotJson: JSON.stringify({ model_id: intent.modelId, pad: "x".repeat(600) }) },
      sealedAt: "2026-09-08T00:00:01.000Z",
    };
    await box.writeReady(ready);
  }
  resolved = true;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}
const listing = await box.listBatch({ limit: 8 });
process.stdout.write(`${JSON.stringify({
  mode,
  resolved,
  error,
  observations: listing.observations.map((o) => o.kind),
})}\n`);

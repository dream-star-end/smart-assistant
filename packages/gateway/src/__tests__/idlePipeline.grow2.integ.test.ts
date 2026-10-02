/**
 * OCV5-296 grow2 only. One live chain; not split across cases.
 * Not re-run in the R31 shard-calibration round.
 */
import test from "node:test";

import { runIdleCase } from "./fixtures/idlePipelineFixture.js";

test("live bash rounds grow outer history through idle summary", { timeout: 3_600_000 }, () => runIdleCase("grow2"));

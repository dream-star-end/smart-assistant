/**
 * OCV5-296 seam only. Not re-run in the R31 shard-calibration round.
 */
import test from "node:test";

import { runIdleCase } from "./fixtures/idlePipelineFixture.js";

test("prepared idle summary commits on its own turn then applies", { timeout: 1_200_000 }, () => runIdleCase("seam"));

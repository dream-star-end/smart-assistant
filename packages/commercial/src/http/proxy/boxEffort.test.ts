// OCV5-305: Box Claude thinking effort, selectable like native Claude Code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOX_CLI_EFFORTS, BoxToolCatalogError, mapBoxCliEffort } from "./boxToolCatalog.js";
import { BOX_ROUTE_EFFORTS, providerCapabilityCeiling } from "./upstream.js";
import { makeBoxTextPlan } from "./boxTextPlan.js";
import { validateBoxTextRequest } from "./boxRequestGate.js";
import type { ProxyBody } from "./shared.js";

const unmapped = (thinking: unknown, output: unknown) => assert.throws(() => mapBoxCliEffort(thinking, output),
  (error: unknown) => error instanceof BoxToolCatalogError && error.code === "BOX_EFFORT_UNMAPPED");

test("OCV5-305 every native Claude Code effort maps to the Box CLI, with or without adaptive thinking", () => {
  assert.deepEqual([...BOX_CLI_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
  for (const effort of BOX_CLI_EFFORTS) {
    assert.equal(mapBoxCliEffort(undefined, { effort }), effort, "capability-zero CCB: effort only");
    assert.equal(mapBoxCliEffort({ type: "adaptive" }, { effort }), effort);
    assert.equal(mapBoxCliEffort({ type: "adaptive", display: "omitted" }, { effort }), effort);
  }
  unmapped(undefined, undefined);
  unmapped({ type: "adaptive" }, undefined);
  unmapped(undefined, { effort: "ultra" });
  unmapped(undefined, { effort: "high", task_budget: { total: 1 } });
  unmapped({ type: "enabled", budget_tokens: 1024 }, { effort: "high" });
  unmapped({ type: "adaptive", display: "summarized" }, { effort: "high" });
});

test("the Box route ceiling offers exactly the CLI's efforts", () => {
  assert.deepEqual([...BOX_ROUTE_EFFORTS], [...BOX_CLI_EFFORTS]);
  assert.deepEqual([...(providerCapabilityCeiling({ kind: "box", upstreamModel: "claude-opus-5-5" }).efforts ?? [])],
    [...BOX_CLI_EFFORTS]);
});

test("a text-only Box turn runs at the selected effort", () => {
  const asset = (name: string) => readFileSync(new URL(`../../../../../scripts/ocv5-289/${name}`, import.meta.url));
  const body = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
    messages: [{ role: "user", content: "hi" }], output_config: { effort: "xhigh" } } as unknown as ProxyBody;
  assert.equal(validateBoxTextRequest(body), null);
  const plan = makeBoxTextPlan({ body, upstreamModel: "claude-opus-5-5", maxOutputTokensLimit: 128_000,
    supervisorAsset: asset("box_supervisor.py"), keeperAsset: asset("box_keeper.py") });
  const at = plan.run.args.indexOf("--effort");
  assert.ok(at > 0 && plan.run.args[at + 1] === "xhigh", plan.run.args.join(" "));
  const none = makeBoxTextPlan({ body: { ...body, output_config: undefined } as unknown as ProxyBody,
    upstreamModel: "claude-opus-5-5", maxOutputTokensLimit: 128_000,
    supervisorAsset: asset("box_supervisor.py"), keeperAsset: asset("box_keeper.py") });
  assert.ok(!none.run.args.includes("--effort"), "no selection keeps the CLI's own default");
  assert.equal(validateBoxTextRequest({ ...body, output_config: { effort: "ultra" } } as unknown as ProxyBody),
    "BOX_EFFORT_UNMAPPED");
});

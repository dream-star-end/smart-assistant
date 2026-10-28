import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { classifyBoxContinuation, prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { validateBoxToolRequest } from "./boxRequestGate.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { normalizeBoxResultImagesForCli } from "./boxToolResultImages.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import type { BoxResultAtom } from "./boxResultSemantics.js";
import type { ProxyBody } from "./shared.js";

interface Fixture {
  incident: string; shape: string; stage: "echo" | "admission" | "decoder" | "mapper";
  body: ProxyBody; expected: string; published: BoxResultAtom[]; observed: unknown;
  error?: string; records: unknown[]; ids: string[]; messages: unknown[]; contains: string;
}
const fixtures = JSON.parse(readFileSync(new URL(
  "./__fixtures__/box-continuation-corpus/incidents.json", import.meta.url), "utf8")) as Fixture[];
const catalog = compileBoxToolCatalog([{ name: "Bash", description: "fixture",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }], "natural");

test("W5 corpus contains 19 distinct incident boundaries", () => {
  assert.equal(fixtures.length, 19);
  assert.equal(new Set(fixtures.map((item) => item.incident)).size, 19);
});

for (const fixture of fixtures) {
  test(`${fixture.incident}: ${fixture.shape}`, async () => {
    const exercise = async () => {
      if (fixture.stage === "echo") {
        const contentHash = createHash("sha256").update(JSON.stringify({
          content: fixture.published, isError: false })).digest("hex");
        const echo = new BoxToolResultEcho([{ modelToolUseId: "toolu_fixture",
          content: fixture.published, isError: false, contentHash }]);
        echo.accept({ type: "user", message: { role: "user", content: [{ type: "tool_result",
          tool_use_id: "toolu_fixture", content: fixture.observed }] } });
        await echo.verifyDeferred();
        echo.assertComplete();
      } else if (fixture.stage === "admission") {
        const before = structuredClone(fixture.body);
        const classified = classifyBoxContinuation(fixture.body);
        assert.equal(classified.classification, fixture.expected);
        const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: fixture.body.model,
          rawBody: fixture.body, authorityKind: "local_catalog", authorityTurnId: null });
        assert.equal(validateBoxToolRequest(fixture.body, prepared), null);
        if (classified.classification === "continuation_candidate") {
          const assistant = prepared.effectiveBody!.messages.at(-2) as { content: Array<{
            type: string; id: string; name: string; input: Record<string, unknown> }> };
          const expected = assistant.content.filter((block) => block.type === "tool_use")
            .map((block) => ({ id: block.id, boxName: `mcp__ocbridge__${block.name}`,
              clientName: block.name, input: block.input }));
          const published = await normalizeBoxResultImagesForCli(matchBoxToolResults(fixture.body, expected));
          const echo = new BoxToolResultEcho(published);
          // The live CLI echoes Anthropic image envelopes, in any result order.
          for (const result of [...published].reverse()) echo.accept({ type: "user", message: {
            role: "user", content: [{ type: "tool_result", tool_use_id: result.modelToolUseId,
              is_error: result.isError, content: result.content.map((part) => part.type === "text" ? part
                : { type: "image", source: { type: "base64", data: part.data, media_type: part.mimeType } }) }] } });
          await echo.verifyDeferred();
          echo.assertComplete();
        } else {
          const { tools: _tools, stream: _stream, ...body } = fixture.body;
          const staged = compileBoxCliSyntheticTurn(body as ProxyBody, {
            cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`, cliVersion: "2.1.280", resumeToolResults: true });
          assert.ok(staged.snapshotJsonl.includes("tool_result"));
          const replay = staged.snapshotJsonl + staged.stdinJsonl;
          const current = body.messages.at(-1) as { content: Array<{
            type: string; text?: string; source?: { data: string } }> };
          for (const block of current.content) {
            if (block.type === "text") {
              assert.ok(replay.includes(JSON.stringify(block.text).slice(1, -1)),
                "fresh restage must retain the complete trailing user text or image caption");
            } else if (block.type === "document") {
              assert.ok(replay.includes('"type":"document"') && replay.includes(block.source!.data),
                "fresh restage must retain the PDF attachment bytes");
            }
          }
        }
        assert.deepEqual(fixture.body, before, "comparison must not mutate replay identity");
      } else if (fixture.stage === "decoder") {
        const decoder = new BoxCliToolHandoffDecoder("claude-opus-5-5", catalog, { allowFinal: true });
        let output: ReturnType<BoxCliToolHandoffDecoder["push"]> | undefined;
        for (const record of fixture.records) output = decoder.push(`${JSON.stringify(record)}\n`);
        assert.deepEqual(output?.candidate?.toolUses.map((use) => use.id), fixture.ids);
      } else {
        const staged = compileBoxCliSyntheticTurn({ model: "claude-opus-5-5", max_tokens: 128,
          messages: fixture.messages } as ProxyBody, { cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
          cliVersion: "2.1.280", toolAliases: new Map([["Bash", "mcp__ocbridge__Bash"]]) });
        assert.ok((staged.snapshotJsonl + staged.stdinJsonl).includes(fixture.contains));
      }
    };
    if (fixture.error) await assert.rejects(exercise, (error: unknown) =>
      error instanceof Error && error.message === fixture.error);
    else await exercise();
  });
}

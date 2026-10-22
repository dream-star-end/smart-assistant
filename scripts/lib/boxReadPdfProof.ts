// OCV5-571 Box incident proofs, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxCliRepairProof.ts). What they use from that file is passed in.
import { isDeepStrictEqual } from "node:util";

type Body = Record<string, unknown>;
const MODEL = "box-api-claude-opus-5-5";
const LIVE_ONLY = "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION";
const text = (value: string) => ({ type: "text", text: value });

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

/** The gate's own helpers (check-v5-box-incident-proofs.ts), passed in unchanged. */
export type ReadPdfKit = {
  api: any;
  db: any;
  boxTurn: (...args: any[]) => any;
  prechecked: (api: any, db: any, row: Record<string, unknown>) => Promise<unknown>;
  journalRow: (db: any, requestId: string) => Promise<any>;
  must: <T>(label: string, pending: Promise<T>) => Promise<T>;
  spoolOf: (records: unknown[]) => Buffer;
  cliInit: unknown;
  FINAL_ANSWER: unknown[];
};

/** INC-20261022-BOX-READ-PDF-DOCUMENT, live #75f47e31 (selfhost uid 3, 2026-10-22 12:03 CST): box-claude-opus-5-5
 * read a PDF. Claude Code answers a PDF Read with a one-line tool_result plus a document block after the results;
 * being the last block it also carries CCB's cache marker. The marker on a document was refused (503) and the
 * document was no known tail (409); each automatic recovery appended a 「继续」 and failed the same way until the
 * budget was spent. The request must stop the CLI still waiting for that result and run fresh with the PDF
 * staged inside its own result. */
export async function proveReadPdfDocument(kit: ReadPdfKit): Promise<string> {
  const { api, db } = kit;
  const journal = api.journal(db);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
  const document = { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } };
  const announced = { type: "tool_result", tool_use_id: "toolu_good_1", content: "PDF file read: /u/酒水台账.pdf (1KB)" };
  const merged = (turn: any, requestId: string, key: string, last: unknown[]) => {
    const call = turn.answer(requestId, key);
    const base = JSON.parse(call.init.body) as Body;
    const body = { ...base, messages: [...(base.messages as unknown[]).slice(0, 2), { role: "user", content: last }] };
    return { ...call, canonicalBody: { ...body, model: MODEL }, init: { method: "POST", body: JSON.stringify(body) } };
  };
  const who = { uid: 900_000_571n, containerId: 571n, sessionId: "session-read-pdf" };
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'read-pdf@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const parked = kit.boxTurn(api, db, journal, who, "box-pdf", "e".repeat(64), undefined,
    { nextSpool: kit.spoolOf([kit.cliInit, ...kit.FINAL_ANSWER]) });
  await parked.first();
  // the first request after the Read: the document is last and carries the cache marker
  const first = merged(parked, "box-pdf-2", "e".repeat(64),
    [announced, { ...document, cache_control: { type: "ephemeral" } }]);
  const verdict = api.classify(first.canonicalBody as Body);
  if (verdict.classification !== "fresh" || !isDeepStrictEqual(verdict.answeredToolIds, ["toolu_good_1"])) {
    fail(`READ_PDF_CLASSIFIED_${verdict.classification}_${String(verdict.rejectCode)}`);
  }
  const gated = api.gate(first.canonicalBody as Body, true);
  if (gated !== null) fail(`READ_PDF_GATE_${gated}`);
  await kit.prechecked(api, db, { ...who, requestId: "box-pdf-2", turnKey: "e".repeat(64) });
  const answer = await kit.must("READ_PDF_REJECTED", parked.service.fetch(first).then((response: Response) => response.text()));
  if (!answer.includes("done") || parked.host.count.launch !== 2 || parked.host.count.stop !== 1) {
    fail(`READ_PDF_NO_ANSWER_${parked.host.count.launch}_${parked.host.count.stop}`);
  }
  // the fresh CLI resumes a history whose Read result holds the PDF itself
  const row = await kit.journalRow(db, "box-pdf-2");
  const run = `/tmp/ocv5-289-run-${String(row?.ctx.boxRunNonce)}`;
  const staged = ([...parked.host.files] as Array<[string, Buffer]>).filter(([path]) => path.endsWith(".jsonl") && !path.startsWith(run))
    .flatMap(([, raw]) => raw.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  const held = staged.some((record) => Array.isArray(record?.message?.content)
    && record.message.content.some((block: Record<string, unknown>) => block?.type === "tool_result"
      && Array.isArray(block.content) && block.content.some((part: unknown) => isDeepStrictEqual(part, document))));
  if (row?.ctx.boxState !== "terminal" || !held) fail(`READ_PDF_NOT_STAGED_${String(row?.ctx.boxState)}_${held}`);
  // the recovery shape of #75f47e31 (one more 「继续」 per failure) is the same answered exchange
  for (const count of [1, 3]) {
    const recovered = api.classify(merged(parked, "box-pdf-x", "f".repeat(64),
      [announced, document, ...Array.from({ length: count }, () => text("继续完成刚才因临时异常中断的任务。"))]).canonicalBody as Body);
    if (recovered.classification !== "fresh") fail(`READ_PDF_RECOVERY_${count}_${String(recovered.rejectCode)}`);
  }
  // a document the Box path cannot prove stays refused
  const unproven = api.classify(merged(parked, "box-pdf-x", "f".repeat(64),
    [announced, { type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }]).canonicalBody as Body);
  if (unproven.classification !== "reject" || unproven.rejectCode !== LIVE_ONLY) fail(`READ_PDF_WIDENED_${unproven.classification}`);
  return "[ocv5-571-read-pdf-document] PASS — a PDF Read result with its document block runs fresh with the PDF inside its result, never 409";
}

type Finalized = { jobs: string[]; gaveUp: boolean };

/** INC-20261022-BOX-READ-PDF-DOCUMENT, second half (#75f47e31): every empty recovery also closed with Claude
 * Code's own result event as the CLI writes it. Its modelUsage is summed over the whole CLI session (the first
 * turn's 52k cache tokens on every attempt) and lists maxOutputTokens; that passed for progress and the lineage
 * ran on to ten. Only the attempt's own usage (all zero) may count. `empty` is the finalized-turn helper of
 * proveFinalizedTurnRecovery: one automatic recovery attempt that failed with the Box 409 and no output. */
export async function proveEmptyRecoveryCliResult(
  empty: (attempt: number, name: string, payload: unknown) => Promise<Finalized>,
): Promise<string> {
  const result = { type: "result", subtype: "success", is_error: true, num_turns: 1, duration_api_ms: 14466,
    modelUsage: { "box-claude-opus-5-5": { cacheCreationInputTokens: 52253, cacheReadInputTokens: 18703,
      contextWindow: 1000000, inputTokens: 2, maxOutputTokens: 128000, outputTokens: 219, webSearchRequests: 0 } },
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0 } };
  const retried = await empty(2, "cli-result", result);
  const stopped = await empty(3, "cli-result", result);
  if (!isDeepStrictEqual(retried.jobs.map((job) => job.split("#")[1]), ["3"]) || stopped.jobs.length !== 0 || !stopped.gaveUp) {
    fail(`CLI_RESULT_RECOVERY_BUDGET_${retried.jobs.join(",")}_${stopped.jobs.join(",")}_${stopped.gaveUp}`);
  }
  // an attempt that did spend tokens keeps the ordinary budget
  const spent = await empty(3, "cli-result-spent", { ...result, usage: { ...result.usage, output_tokens: 7 } });
  if (!isDeepStrictEqual(spent.jobs.map((job) => job.split("#")[1]), ["4"])) {
    fail(`CLI_RESULT_SPENT_LOST_BUDGET_${spent.jobs.join(",")}`);
  }
  return "[ocv5-571-empty-recovery-cli-result] PASS — an empty recovery whose CLI result event repeats the session usage keeps the short budget of three";
}

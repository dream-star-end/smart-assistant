// OCV5-571 live #75f47e31 (selfhost uid 3, 2026-10-22 12:03 CST): box-claude-opus-5-5
// read a PDF. Claude Code answers a PDF Read with a one-line tool_result and an
// isMeta document block after it, so the next request ended in
// "user:tool_result+document"; the egress answered 409
// BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION, every automatic recovery appended one
// more "继续" text and failed the same way until the budget ran out.
// Every content shape a Read (or the Bash fallback Read asks for on Office files)
// produces must continue: never 409, and the staged history keeps the content.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyBoxContinuation, prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { validateBoxToolRequest } from "./boxRequestGate.js";
import type { ProxyBody } from "./shared.js";

const LIVE_ONLY = "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION";
const schema = { type: "object", properties: {} };
const tools = [{ name: "Read", description: "read", input_schema: schema },
  { name: "Bash", description: "bash", input_schema: schema }];
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
const PDF_2 = Buffer.from("%PDF-1.7\n%second\n%%EOF\n").toString("base64");
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } };
const pdfDocument = (data = PDF) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
const read = (id: string, file: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: file } });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "tool_result", tool_use_id: id, content, ...extra });
const text = (value: string) => ({ type: "text", text: value });
const resume = "上一条消息因上游瞬时错误中断，请继续完成该任务。";

const bodyWith = (uses: unknown[], last: unknown[], history: unknown[] = []): ProxyBody => ({
  model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true, tools,
  metadata: { user_id: JSON.stringify({ session_id: "sess-read-shapes", oc_turn_key: "cd".repeat(32) }) },
  messages: [...history, { role: "user", content: "帮我把错误的一行去掉" },
    { role: "assistant", content: [text("先看一下文件。"), ...uses] },
    { role: "user", content: last }] }) as ProxyBody;
const cwd = `/tmp/ocv5-289-run-${"a".repeat(24)}`;

/** The request passes the egress gate and is never the 409 that loops recovery. */
function continues(body: ProxyBody, label: string): ReturnType<typeof classifyBoxContinuation> {
  const classified = classifyBoxContinuation(body);
  assert.notEqual(classified.classification, "reject", `${label}: ${String(classified.rejectCode)}`);
  const prepared = prepareBoxContinuation({ uid: 765n, canonicalModel: body.model, rawBody: body,
    authorityKind: "local_catalog", authorityTurnId: null });
  assert.equal(validateBoxToolRequest(body, prepared), null, label);
  return classified;
}
/** The snapshot the fresh Box CLI resumes from, and its stdin prompt. */
function staged(body: ProxyBody): { history: Array<{ message: { content: unknown } }>; stdin: unknown } {
  const { tools: _tools, stream: _stream, ...textBody } = body;
  const turn = compileBoxCliSyntheticTurn(textBody as ProxyBody, { cwd, cliVersion: "2.1.280", resumeToolResults: true });
  return { history: turn.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line)),
    stdin: JSON.parse(turn.stdinJsonl).message.content };
}

test("OCV5-571 a PDF Read result with its document block runs fresh, never 409", () => {
  const uses = [read("toolu_pdf", "/u/酒水台账.pdf")];
  const announced = result("toolu_pdf", "PDF file read: /u/酒水台账.pdf (597.2KB)");
  // the first request after the Read, the cached retry, and the recovery shape of #75f47e31
  for (const [label, last] of [
    ["pdf", [announced, pdfDocument()]],
    ["pdf+cache-marker", [announced, { ...pdfDocument(), cache_control: { type: "ephemeral" } }]],
    ["pdf+recovery", [announced, pdfDocument(), text(resume)]],
    ["pdf+recovery×3", [announced, pdfDocument(), text(resume), text(resume), text(resume)]],
  ] as const) {
    const classified = continues(bodyWith(uses, [...last]), label);
    assert.equal(classified.classification, "fresh", label);
    assert.deepEqual(classified.answeredToolIds, ["toolu_pdf"], label);
  }
});

test("OCV5-571 the document joins its own Read result in the staged history", () => {
  const { history, stdin } = staged(bodyWith([read("toolu_pdf", "/u/a.pdf")],
    [result("toolu_pdf", "PDF file read: /u/a.pdf (1KB)"), pdfDocument(), text(resume)]));
  assert.deepEqual(history.at(-1)!.message.content, [result("toolu_pdf",
    [text("PDF file read: /u/a.pdf (1KB)"), pdfDocument()])]);
  assert.deepEqual(stdin, [text(resume)]);
  // two parallel PDF Reads: each document joins the Read that announced it, in order
  const two = staged(bodyWith([read("toolu_p1", "/u/1.pdf"), bash("toolu_ls", "ls"), read("toolu_p2", "/u/2.pdf")],
    [result("toolu_p1", "PDF file read: /u/1.pdf (1KB)"), result("toolu_ls", "1.pdf 2.pdf"),
      result("toolu_p2", "PDF file read: /u/2.pdf (1KB)"), pdfDocument(), pdfDocument(PDF_2)]));
  assert.deepEqual(two.history.at(-1)!.message.content, [
    result("toolu_p1", [text("PDF file read: /u/1.pdf (1KB)"), pdfDocument()]),
    result("toolu_ls", "1.pdf 2.pdf"),
    result("toolu_p2", [text("PDF file read: /u/2.pdf (1KB)"), pdfDocument(PDF_2)])]);
});

test("OCV5-571 a PDF read earlier stays valid history for every later request", () => {
  const earlier = [{ role: "user", content: "读一下" }, { role: "assistant", content: [read("toolu_old", "/u/a.pdf")] },
    { role: "user", content: [result("toolu_old", "PDF file read: /u/a.pdf (1KB)"), pdfDocument()] },
    { role: "assistant", content: [text("读完了。")] }];
  // the next tool round of a later turn is still a live continuation
  const live = continues(bodyWith([bash("toolu_b", "ls")], [result("toolu_b", "a.pdf")], earlier), "history+live");
  assert.equal(live.classification, "continuation_candidate");
  // and a later plain prompt still compiles for a fresh run
  const fresh = { ...bodyWith([], [], earlier), messages: [...earlier, { role: "user", content: "再删一行" }] } as ProxyBody;
  assert.equal(validateBoxToolRequest(fresh), null);
});

test("OCV5-571 every other Read result shape continues", () => {
  const caption = "[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]";
  const cases: Array<[string, unknown[], unknown[]]> = [
    ["text file", [read("toolu_t", "/u/a.md")], [result("toolu_t", "     1\t# 标题\n     2\t正文")]],
    ["csv file", [read("toolu_c", "/u/a.csv")], [result("toolu_c", "     1\t日期,金额\n     2\t10-21,120")]],
    ["empty file", [read("toolu_e", "/u/e.txt")],
      [result("toolu_e", "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>")]],
    ["image", [read("toolu_i", "/u/a.png")], [result("toolu_i", [image])]],
    ["scaled image + caption", [read("toolu_i", "/u/a.jpg")], [result("toolu_i", [image]), text(caption)]],
    ["notebook", [read("toolu_n", "/u/a.ipynb")], [result("toolu_n",
      [text("<cell id=\"c1\">import pandas as pd</cell>"), image, text("<cell id=\"c2\">df.head()</cell>")])]],
    ["pdf pages", [read("toolu_pp", "/u/a.pdf")],
      [result("toolu_pp", "PDF pages extracted: 2 page(s) from /u/a.pdf (1KB)"), image, image]],
    // Office files: Read refuses binaries, the model extracts them with Bash instead
    ["docx refused", [read("toolu_w", "/u/a.docx")], [result("toolu_w",
      "This tool cannot read binary files. The file appears to be a binary .docx file. Please use appropriate tools for binary file analysis.",
      { is_error: true })]],
    ["docx via bash", [bash("toolu_wb", "python3 -c 'import docx…'")], [result("toolu_wb", "会议纪要\n一、出席人员")]],
    ["xlsx via bash", [bash("toolu_xb", "python3 -c 'import openpyxl…'")], [result("toolu_xb", "Sheet1\n日期\t酒水\t数量")]],
    ["pptx via bash", [bash("toolu_pb", "python3 -c 'import pptx…'")], [result("toolu_pb", "幻灯片 1: 季度汇报")]],
  ];
  for (const [label, uses, last] of cases) {
    continues(bodyWith(uses, last), label);
    continues(bodyWith(uses, [...last, text(resume)]), `${label}+recovery`);
  }
});

test("OCV5-571 a malformed document still fails closed", () => {
  const uses = [read("toolu_pdf", "/u/a.pdf")];
  const announced = result("toolu_pdf", "PDF file read: /u/a.pdf (1KB)");
  for (const [label, document] of [
    ["not a pdf", pdfDocument(Buffer.from("PK\u0003\u0004word").toString("base64"))],
    ["url source", { type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }],
    ["extra key", { ...pdfDocument(), title: "a" }],
    ["non-canonical base64", pdfDocument(`${PDF}\n`)],
    ["other media type", { type: "document", source: { type: "base64", media_type: "application/msword", data: PDF } }],
    // Read never sends a text-source document; it stays unproven
    ["text source", { type: "document", source: { type: "text", media_type: "text/plain", data: "台账" } }],
  ] as const) {
    const classified = classifyBoxContinuation(bodyWith(uses, [announced, document]));
    assert.equal(classified.classification, "reject", label);
    assert.equal(classified.rejectCode, LIVE_ONLY, label);
  }
  // a document before or between the results is not an answered exchange either
  const between = classifyBoxContinuation(bodyWith([read("toolu_a", "/a.pdf"), read("toolu_b", "/b.pdf")],
    [result("toolu_a", "PDF file read: /a.pdf (1KB)"), pdfDocument(), result("toolu_b", "PDF file read: /b.pdf (1KB)")]));
  assert.equal(between.rejectCode, LIVE_ONLY);
});

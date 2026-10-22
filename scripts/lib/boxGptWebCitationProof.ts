// OCV5-584 Box incident proof, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxReadPdfProof.ts). It loads the candidate's own Box GPT Web core.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

const O = "";
const C = "";
const S = "";
const PUA = /[-]/;
const genui = (citation: object) => `${O}genui${S}${JSON.stringify({ citation })}${C}`;

/** INC-20261023-BOX-GPT-WEB-CITATION-LEAK, commercial uid 1 session webmvjqjcdxtgwq7a (box-gpt-6-astra-pro, 2026-10-23):
 * ChatGPT Web writes its source chips into the reply text as private-use markers, e.g.
 * U+E200 genui U+E202 {"citation":{"ref":"turn27view0"}} U+E201. The Box GPT Web host streamed the raw text, so the
 * markers showed up as glyphs plus JSON in table cells and paragraphs. Fed frame by frame the way host.mjs feeds
 * them (markers cut mid-JSON), no text delta and no final text may carry a marker; a citation whose source is in the
 * message metadata becomes a link. */
export async function proveGptWebCitationMarkers(candidate: string): Promise<string> {
  const core = await import(pathToFileURL(join(candidate, "packages/gateway/box-gpt-web-mod/chatgptWebCore.mjs")).href);
  const answer = `拓普康 0.5 mm+1 ppm,反射片测程1.3~200 m。${genui({ ref: "turn27view0" })}\n`
    + `| 索佳 | 不满足 ${genui({ refs: ["turn30search23", "turn30search0"] })} |\n`
    + `结论${O}cite${S}turn9search1${C}。`;
  const metadata = { content_references: [{ matched_text: genui({ ref: "turn27view0" }),
    refs: [{ turn_index: 27, ref_type: "view", ref_index: 0 }],
    items: [{ url: "https://topcon.example/ms05axii", title: "MS05AXII" }] }] };
  for (const size of [1, 3, 11]) {
    const streamer = new core.TurnProgressStreamer();
    const deltas: string[] = [];
    const acc = new core.SseAccumulator({ onTextDelta: () => {
      streamer.citations.addSources(acc.citationSources);
      const delta = streamer.consumeIncrementalFinalText(acc.finalText, { finalFlush: false });
      if (delta) deltas.push(delta);
    } });
    acc.feedDataLine(JSON.stringify({ v: { message: { id: "m", author: { role: "assistant" }, channel: "final",
      content: { content_type: "text", parts: [""] } } } }));
    acc.feedDataLine(JSON.stringify({ p: "/message/metadata", o: "add", v: metadata }));
    for (let at = 0; at < answer.length; at += size) {
      acc.feedDataLine(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: answer.slice(at, at + size) }));
    }
    acc.feedDataLine(JSON.stringify({ type: "message_stream_complete" }));
    streamer.citations.addSources(acc.citationSources);
    const tail = streamer.consumeIncrementalFinalText(acc.finalText, { finalFlush: true });
    if (tail) deltas.push(tail);
    const final: string = streamer.emittedFinalText;
    const leaked = deltas.find((delta) => PUA.test(delta) || delta.includes('"citation"'));
    if (leaked !== undefined) fail(`GPT_WEB_CITATION_DELTA_LEAK_${size}_${JSON.stringify(leaked)}`);
    if (PUA.test(final) || final.includes('"citation"')) fail(`GPT_WEB_CITATION_FINAL_LEAK_${size}`);
    if (deltas.join("") !== final) fail(`GPT_WEB_CITATION_STREAM_REWRITTEN_${size}`);
    if (!final.includes("200 m。[1](https://topcon.example/ms05axii)\n| 索佳 | 不满足  |\n结论。")) {
      fail(`GPT_WEB_CITATION_NOT_RENDERED_${size}_${JSON.stringify(final)}`);
    }
  }
  return "[ocv5-584-gpt-web-citation-markers] PASS — ChatGPT Web citation markers cut across SSE frames never reach a text delta and a known source becomes a link";
}

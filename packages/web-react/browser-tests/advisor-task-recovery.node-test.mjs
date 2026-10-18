import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { buildHarnessPage, exactSwap } from "./harness-page.mjs";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { BOARD_SESSION } from "./process-disclosure-story.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const red = process.env.OC_UX_ADVISOR_RED === "1";
const evidence = process.env.OC_UX_EVIDENCE_DIR;
const NOTICE = "顾问暂不可用，已由当前主模型继续处理";
const FILE = "任务材料.txt", FILE_URL = "/api/media/g512-input.txt";
const BYTES = Buffer.from("G512_ATTACHMENT_CONTENT");
const MEDIA = { kind: "file", url: FILE_URL, mimeType: "text/plain", filename: FILE };

test("OCV5-512 unavailable advisor continues the same main task with its attachment", { timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-advisor-recovery-"));
  const swaps = { count: 0 };
  await buildHarnessPage({ harness: "goal-start-harness.tsx", assetDir: dir,
    plugins: red ? [exactSwap("disable-advisor-task-recovery", /\/App\.tsx$/,
      'if (agent.id === "main" && continuePrimaryWithoutAdvisor(latestCollab)) {', "if (false) {", swaps)] : [] });
  assert.equal(swaps.count, red ? 1 : 0);
  const preview = await startPreviewServer(dir);
  preview.wss.removeAllListeners("connection");
  let scenario;
  let sequence = 0;
  preview.wss.on("connection", (ws) => {
    const send = (f) => ws.readyState === 1 && ws.send(JSON.stringify(f));
    send({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "ping") return send({ type: "pong", id: f.id });
      if (f.type === "inbound.hello") return send({ type: "sys.relay_ready", automaticRecoveryOwner: "master-v1" });
      if (f.type !== "inbound.message") return;
      scenario.inbounds.push(f);
      const sid = f.peer.id, id = f.clientMessageId, ts = Date.now();
      const answerId = "g512-answer-" + id, answer = "G512_MAIN_TASK_COMPLETED_" + scenario.inbounds.length;
      const base = preview.store.board.length + 1;
      preview.store.board.push(
        { id, role: "user", text: f.content.text, ts, _source: "server", _seq: base, _orderSeq: base },
        { id: answerId, role: "assistant", text: answer, ts: ts + 1, _source: "server", _seq: base + 1, _orderSeq: base + 1, _clientMessageId: id },
      );
      preview.store.revision++;
      preview.store.clocks[BOARD_SESSION].updatedAt = ts + 1;
      send({ type: "outbound.ack", admitted: true, peer: f.peer, clientMessageId: id });
      send({ type: "outbound.message", channel: "webchat", peer: f.peer, sessionKey: "agent:main:webchat:dm:" + sid,
        clientMessageId: id, frameSeq: ++sequence, blocks: [{ kind: "text", text: answer, messageId: answerId }], isFinal: true, ts: ts + 1 });
    });
  });
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [1280, 390]) for (const saveStatus of [200, 503, 409]) {
      scenario = { inbounds: [], calls: [], uploads: [], getCount: 0, mode: "advisor", rev: 7 };
      preview.store.board = []; preview.store.older = []; preview.store.revision++;
      const current = scenario;
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const doc = () => ({ rev: current.rev, defaultMode: "advisor", defaultAdvisorModel: "gpt-6-astra",
        session: { mode: current.mode, advisorModel: current.mode === "advisor" ? "gpt-6-astra" : null,
          configVersion: current.mode === "advisor" ? "v1:advisor:gpt-6-astra" : "v1:solo:", source: "session" },
        advisorModels: [], advisorUnavailableReason: "顾问引擎尚未完成无工具证明",
        advisorConsultParents: ["ccb"], advisorConsultAllowed: true, parentEngine: "ccb" });
      await page.route("**/api/collaboration-config**", async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() === "GET") {
          current.getCount++;
          current.calls.push({ method: "GET", sessionId: url.searchParams.get("sessionId") });
          return route.fulfill({ json: doc() });
        }
        const body = req.postDataJSON();
        current.calls.push({ method: "PUT", body, responseStatus: saveStatus });
        if (saveStatus !== 200) return route.fulfill({ status: saveStatus, json: { error: { message: "fixture save failure" } } });
        assert.equal(body.sessionId, BOARD_SESSION);
        assert.equal(body.asDefault, undefined);
        current.mode = body.mode; current.rev++;
        return route.fulfill({ json: doc() });
      });
      await page.route("**/api/uploads", async (route) => {
        const req = route.request(), bytes = req.postDataBuffer();
        current.uploads.push({ filename: decodeURIComponent(req.headers()["x-filename"]), bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
        return route.fulfill({ json: { url: FILE_URL, size: BYTES.length, mimeType: "text/plain" } });
      });
      const boot = async () => {
        await page.waitForURL("**/s/" + BOARD_SESSION);
        await page.getByRole("button", { name: /切换智能体/ }).click();
        await page.getByRole("dialog").getByText("顾问引擎尚未完成无工具证明", { exact: true }).first().waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
      };
      const submit = async (number) => {
        const text = "G512_KEEP_MAIN_TASK_" + number;
        await page.getByPlaceholder(/对话/).fill(text);
        await page.locator('input[type="file"]').first().setInputFiles({ name: FILE, mimeType: "text/plain", buffer: BYTES });
        await page.getByText(FILE, { exact: true }).first().waitFor();
        await page.getByRole("button", { name: "发送", exact: true }).click();
        if (red && evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.getByText("顾问引擎尚未完成无工具证明", { exact: true }).last().waitFor();
          await page.screenshot({ path: join(evidence, "advisor-before-" + width + ".png"), fullPage: true });
        }
        await page.getByText("G512_MAIN_TASK_COMPLETED_" + number, { exact: true }).first().waitFor({ timeout: 10000 });
        assert.equal(current.inbounds.length, number);
        const f = current.inbounds[number - 1];
        assert.equal(f.peer.id, BOARD_SESSION);
        assert.equal(f.model, "glm-5.2");
        assert.equal(f.content.text, text);
        assert.deepEqual(f.content.media, [MEDIA]);
        assert.equal(f.collabMode, "solo"); assert.equal(f.teamMode, false);
        assert.equal(f.advisorModel, undefined); assert.equal(f.collabConfigVersion, undefined);
        await page.getByText(NOTICE, { exact: true }).first().waitFor();
        assert.ok(current.getCount >= 2, "send rereads the formerly unavailable catalog before recovery");
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, "advisor-after-" + saveStatus + "-" + width + "-" + number + ".png"), fullPage: true });
        }
      };
      try {
        await page.goto(preview.url); await boot(); await submit(1);
        if (saveStatus !== 200) {
          await page.reload(); await boot();
          assert.equal(current.inbounds.length, 1, "reload does not resend the old task");
          await submit(2);
        }
        assert.deepEqual(errors, []);
        assert.ok(current.uploads.every((f) => f.filename === FILE && f.bytes === BYTES.length));
        for (const c of current.calls.filter((c) => c.method === "PUT")) {
          assert.equal(c.body.asDefault, undefined); assert.equal(c.body.mode, "solo");
        }
        if (evidence) writeFileSync(join(evidence, "advisor-" + saveStatus + "-" + width + ".json"), JSON.stringify(current, null, 2));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); for (const ws of preview.wss.clients) ws.terminate(); await new Promise((done) => preview.wss.close(done)); await new Promise((done) => preview.server.close(done)); }
});

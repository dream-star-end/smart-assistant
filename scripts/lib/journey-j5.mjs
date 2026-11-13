// J5 送达判定(从 v5-e2e-journey-canary.mjs 抽出,便于真浏览器夹具测试)。2026-10-08 冒烟健壮性。
//
// 判据(一条未放松):
//   失败 = ErrorBanner 签名(发送失败 / 消息暂未安全送达)一出现立即 fail;
//   成功 = 在**本次发送的用户消息行之后**出现 assistant 行 + 流式光标消失 + composer 恢复「发送」,
//          且该行无 alert(终态错误/空轮/截断都 fail)、最终正文含附件秘密探针。
// 锚点:聊天区里含本次唯一 marker 的用户消息行(data-testid="user-row")。旧实现用发送前数出来的
// assistant 行数作基线 —— J3 的目标轮被清除停止时行在变,基线偏高就永远等不到(OCV5-334 误报)。
//
// 超时:turnWaitMs 到点仍未判定 → 只读核对后端(backendCheck)。后端已有含探针的 assistant 回复 →
// 一次 graceMs 宽限,UI 判据不变;宽限内收尾即通过并打 `warn slow_ui_settle`;否则失败。
// 后端查不到/查不了 → 立即按原样失败。

export async function j5ReplyState(page, marker) {
  return page.evaluate((m) => {
    // 锚点只认聊天区的用户消息行,侧栏会话标题等别处出现 marker 不算。
    const userRows = [...document.querySelectorAll('[data-testid="user-row"]')].filter((r) => r.textContent?.includes(m));
    const anchor = userRows[userRows.length - 1] ?? null;
    if (!anchor) return { anchored: false, rowsAfter: 0, caret: false, alert: false, finalBody: "" };
    const rows = [...document.querySelectorAll('[data-testid="assistant-row"]')]
      .filter((r) => anchor.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING);
    const newestAssistant = rows[rows.length - 1];
    const bodies = newestAssistant ? newestAssistant.querySelectorAll(".prose") : [];
    return {
      anchored: true,
      rowsAfter: rows.length,
      caret: Boolean(newestAssistant?.querySelector(".caret-blink")),
      alert: Boolean(newestAssistant?.querySelector('[role="alert"]')),
      finalBody: (bodies.length ? bodies[bodies.length - 1].textContent : "")?.trim() ?? "",
    };
  }, marker);
}

export async function waitJ5Delivered(page, { marker, probeToken, turnWaitMs, graceMs, backendCheck, log = console.log, onEvidence = () => {}, pollMs = 500 }) {
  const failSig = page.getByText(/发送失败|消息暂未安全送达/).first();
  const send = page.getByRole("button", { name: "发送", exact: true });
  const deadline = Date.now() + turnWaitMs;
  let graceDeadline = 0;
  let backendAt = 0;
  let evidence = null;
  for (;;) {
    if ((await failSig.count()) > 0) {
      throw new Error("发送失败签名出现(消息未送达,见截图)");
    }
    const st = await j5ReplyState(page, marker);
    const responseFinished = st.rowsAfter > 0 && !st.caret && (await send.count()) > 0;
    if (responseFinished) {
      if (st.alert) {
        throw new Error("assistant 以错误/空轮/截断提示结束(非正常回复)");
      }
      if (!st.finalBody.includes(probeToken)) {
        throw new Error("assistant 最终正文未包含附件秘密探针(附件未送达 Agent、未读取或回复不完整)");
      }
      if (graceDeadline) {
        log(`e2e-journey: warn slow_ui_settle J5 ui_settled_ms_after_backend=${Date.now() - backendAt} turn_wait_ms=${turnWaitMs}`);
      }
      return { slow: Boolean(graceDeadline) };
    }
    const now = Date.now();
    if (now > deadline && !graceDeadline) {
      const backend = backendCheck();
      evidence = { atDeadline: st, sendVisible: (await send.count()) > 0, backend };
      onEvidence(evidence);
      if (!backend.found) {
        throw new Error(`assistant 回复在 ${turnWaitMs / 1000}s 内未完成(无失败卡亦无完整回复 = turn 挂起;后端核对:${backend.detail})`);
      }
      backendAt = Date.now();
      graceDeadline = backendAt + graceMs;
      log(`e2e-journey: J5 到 ${turnWaitMs / 1000}s 未判定;后端已有含探针的 assistant 回复(${backend.detail}),UI 判据不变,再等至多 ${graceMs / 1000}s`);
    } else if (graceDeadline && now > graceDeadline) {
      evidence = { ...evidence, atGraceEnd: st, sendVisibleAtGraceEnd: (await send.count()) > 0 };
      onEvidence(evidence);
      throw new Error(`后端已有含探针的回复,但 UI 在宽限 ${graceMs / 1000}s 内仍未收尾(回复未在界面完成 = 真失败)`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

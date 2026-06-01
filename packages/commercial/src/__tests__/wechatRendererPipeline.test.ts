/**
 * rendererPipeline 单元测试。
 *
 * 三个底层函数(sanitizeForWechat / splitText / friendlyToolName)是 fork 自
 * packages/channels/wechat/src/manager.ts 的复制(故意复制,详见模块头注释)。
 * 这里测的是 commercial fork 的行为锁定;若 manager.ts 上游升级,fork 副本不会
 * 自动跟进 — 这正是 fork 想要的隔离性。
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  WECHAT_MAX_TEXT,
  friendlyToolName,
  sanitizeForWechat,
  splitText,
  friendlyProviderErrorForWechat,
  renderAssistantText,
  renderToolAnnouncement,
} from "../wechat/rendererPipeline.js"

describe("rendererPipeline.friendlyToolName", () => {
  test("builtin map: Read → 读取文件 etc.", () => {
    assert.equal(friendlyToolName("Read"), "读取文件")
    assert.equal(friendlyToolName("Write"), "写入文件")
    assert.equal(friendlyToolName("Bash"), "执行命令")
    assert.equal(friendlyToolName("TodoWrite"), "规划任务")
  })

  test("MCP pattern matchers", () => {
    assert.equal(friendlyToolName("mcp__browser__browser_click"), "操作浏览器")
    assert.equal(friendlyToolName("mcp__memory__archival_add"), "访问记忆")
    assert.equal(friendlyToolName("mcp__minimax-vision__web_search"), "联网搜索")
    assert.equal(friendlyToolName("mcp__minimax__text_to_image"), "生成图片")
    assert.equal(friendlyToolName("create_reminder"), "设置定时任务")
  })

  test("fallback: mcp__server__action → action segment", () => {
    assert.equal(friendlyToolName("mcp__foo__some_unknown_tool"), "some_unknown_tool")
  })

  test("fully unknown: returns trimmed input as-is", () => {
    assert.equal(friendlyToolName("  TotallyMadeUpToolName  "), "TotallyMadeUpToolName")
  })
})

describe("rendererPipeline.sanitizeForWechat", () => {
  test("empty / whitespace pass-through", () => {
    assert.equal(sanitizeForWechat(""), "")
    assert.equal(sanitizeForWechat("   "), "   ")
  })

  test("strips fenced code blocks but keeps content", () => {
    const md = "前置\n```ts\nconst x = 1\n```\n后置"
    const out = sanitizeForWechat(md)
    assert.ok(out.includes("const x = 1"))
    assert.ok(!out.includes("```"))
  })

  test("strips bold / italic / inline code markup", () => {
    assert.equal(sanitizeForWechat("**粗**"), "粗")
    assert.equal(sanitizeForWechat("__粗__"), "粗")
    assert.equal(sanitizeForWechat("*斜*"), "斜")
    assert.equal(sanitizeForWechat("`code`"), "code")
  })

  test("[text](url) → text (url): keeps URL tappable in WeChat", () => {
    assert.equal(
      sanitizeForWechat("see [docs](https://a.com/x)"),
      "see docs (https://a.com/x)",
    )
  })

  test("strips heading hashes / blockquote / horizontal rules", () => {
    assert.equal(sanitizeForWechat("## title"), "title")
    assert.equal(sanitizeForWechat("> quoted"), "quoted")
    assert.equal(sanitizeForWechat("---"), "")
  })
})

describe("rendererPipeline.friendlyProviderErrorForWechat", () => {
  test("UNKNOWN_MODEL raw API JSON becomes actionable copy without request_id", () => {
    const raw =
      `API Error: 400 {"error":{"code":"UNKNOWN_MODEL","message":"model 'claude-opus-4-7' not enabled"},"request_id":"req-secret"}`
    const out = friendlyProviderErrorForWechat(raw)
    assert.ok(out)
    assert.match(out!, /claude-opus-4-7/)
    assert.match(out!, /网页端切换/)
    assert.doesNotMatch(out!, /request_id|req-secret|UNKNOWN_MODEL|API Error/)
  })

  test("generic API JSON is hidden behind a short WeChat message", () => {
    const out = friendlyProviderErrorForWechat('API Error: 400 {"error":{"message":"bad"},"request_id":"r1"}')
    assert.equal(out, "模型请求没有成功。请稍后重试；如果连续失败，请在网页端切换模型或联系管理员。")
  })

  test("ordinary assistant text is not rewritten", () => {
    assert.equal(friendlyProviderErrorForWechat("API 设计建议: 不要暴露 request_id"), null)
  })
})

describe("rendererPipeline.splitText", () => {
  test("under max returns single chunk", () => {
    assert.deepEqual(splitText("hello", 100), ["hello"])
  })

  test("at exact max returns single chunk", () => {
    const s = "a".repeat(100)
    assert.deepEqual(splitText(s, 100), [s])
  })

  test("over max → hard cut into chunks of max length", () => {
    const s = "a".repeat(250)
    const out = splitText(s, 100)
    assert.equal(out.length, 3)
    assert.equal(out[0]!.length, 100)
    assert.equal(out[1]!.length, 100)
    assert.equal(out[2]!.length, 50)
    assert.equal(out.join(""), s)
  })

  test("empty input → empty array", () => {
    assert.deepEqual(splitText("", 100), [])
  })

  test("max <= 0 throws (防呆,避免无限循环)", () => {
    assert.throws(() => splitText("x", 0), /max must be > 0/)
    assert.throws(() => splitText("x", -1), /max must be > 0/)
  })
})

describe("rendererPipeline.renderAssistantText", () => {
  test("plain text → single text part", () => {
    const parts = renderAssistantText("hello world")
    assert.deepEqual(parts, [{ type: "text", text: "hello world" }])
  })

  test("raw UNKNOWN_MODEL API error is rewritten before sending to WeChat", () => {
    const parts = renderAssistantText(
      `API Error: 400 {"error":{"code":"UNKNOWN_MODEL","message":"model 'claude-opus-4-7' not enabled"},"request_id":"req-secret"}`,
    )
    assert.equal(parts.length, 1)
    assert.match(parts[0]!.text, /这个模型（claude-opus-4-7）当前不可用/)
    assert.doesNotMatch(parts[0]!.text, /request_id|req-secret|UNKNOWN_MODEL|API Error/)
  })

  test("markdown is sanitized before splitting", () => {
    const parts = renderAssistantText("# 标题\n**粗**")
    assert.equal(parts.length, 1)
    assert.equal(parts[0]!.text, "标题\n粗")
  })

  test("long text is split into multiple parts honoring WECHAT_MAX_TEXT", () => {
    const long = "a".repeat(WECHAT_MAX_TEXT * 2 + 5)
    const parts = renderAssistantText(long)
    assert.equal(parts.length, 3)
    assert.equal(parts[0]!.text.length, WECHAT_MAX_TEXT)
    assert.equal(parts[1]!.text.length, WECHAT_MAX_TEXT)
    assert.equal(parts[2]!.text.length, 5)
  })

  test("empty / null / undefined → empty array (no zero-length part)", () => {
    assert.deepEqual(renderAssistantText(""), [])
    // 签名是 string | null | undefined,无须 cast(Codex slice 2 r1)
    assert.deepEqual(renderAssistantText(null), [])
    assert.deepEqual(renderAssistantText(undefined), [])
  })

  test("whitespace-only after sanitize → still emits as single part (not stripped)", () => {
    // sanitize 不去 leading/trailing space;空白字符串 cleanedLength > 0
    const parts = renderAssistantText("   ")
    assert.equal(parts.length, 1)
    assert.equal(parts[0]!.text, "   ")
  })
})

describe("rendererPipeline.renderToolAnnouncement", () => {
  test("builds 🔧 prefix with friendly tool name", () => {
    assert.deepEqual(renderToolAnnouncement("Read"), [{ type: "text", text: "🔧 读取文件…" }])
  })

  test("unknown tool falls through friendlyToolName fallback", () => {
    assert.deepEqual(renderToolAnnouncement("WhateverNewTool"), [
      { type: "text", text: "🔧 WhateverNewTool…" },
    ])
  })
})

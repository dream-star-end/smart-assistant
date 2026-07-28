import { describe, test } from "node:test"
import assert from "node:assert/strict"

import {
  handleWechatModelCommand,
  parseModelCommandSelection,
} from "../wechat/modelCommand.js"

const allowed = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5.6-sol"])

describe("parseModelCommandSelection", () => {
  test("extracts optional selection", () => {
    assert.equal(parseModelCommandSelection("/model"), null)
    assert.equal(parseModelCommandSelection(" /model   2 "), "2")
    assert.equal(parseModelCommandSelection("/model claude-sonnet-4-6"), "claude-sonnet-4-6")
  })
})

describe("handleWechatModelCommand", () => {
  const base = {
    preferredModel: "claude-sonnet-4-6",
    visibleModels: [
      { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
    ],
    canUseModel: (id: string) => id !== "claude-haiku-4-5",
    allowedModels: allowed,
  }

  test("/model lists allowed models and marks current", async () => {
    const out = await handleWechatModelCommand({
      ...base,
      text: "/model",
      setDefaultModel: async () => {
        throw new Error("should not set")
      },
    })
    assert.match(out, /1\. Claude Opus 4\.7/)
    assert.match(out, /2\. Claude Sonnet 4\.6（当前）/)
    assert.doesNotMatch(out, /Haiku/)
    assert.match(out, /\/model 2/)
    assert.match(out, /当前微信可用模型/)
  })

  test("channelName reuses the same model authority with QQ wording", async () => {
    const out = await handleWechatModelCommand({
      ...base,
      channelName: "QQ",
      text: "/model 1",
      setDefaultModel: async () => {},
    })
    assert.match(out, /下一条QQ消息会使用这个模型/)
    assert.doesNotMatch(out, /微信/)
  })

  test("/model <number> sets selected model", async () => {
    const calls: string[] = []
    const out = await handleWechatModelCommand({
      ...base,
      text: "/model 1",
      setDefaultModel: async (id) => { calls.push(id) },
    })
    assert.deepEqual(calls, ["claude-opus-4-7"])
    assert.match(out, /已切换默认模型为: Claude Opus 4\.7/)
  })

  test("/model <id> sets selected model", async () => {
    const calls: string[] = []
    await handleWechatModelCommand({
      ...base,
      text: "/model claude-sonnet-4-6",
      setDefaultModel: async (id) => { calls.push(id) },
    })
    assert.deepEqual(calls, ["claude-sonnet-4-6"])
  })

  test("invalid selection returns friendly guidance without setting", async () => {
    const calls: string[] = []
    const out = await handleWechatModelCommand({
      ...base,
      text: "/model 99",
      setDefaultModel: async (id) => { calls.push(id) },
    })
    assert.deepEqual(calls, [])
    assert.match(out, /没有找到可用模型: 99/)
    assert.match(out, /发送 \/model/)
  })
})

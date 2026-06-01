import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { pickWechatInboundModel } from "../wechat/modelResolver.js"

const allowed = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5.5"])

describe("pickWechatInboundModel", () => {
  test("uses preferred model only when gateway-compatible and authorized", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-sonnet-4-6",
      visibleModels: [{ id: "claude-opus-4-7" }],
      canUseModel: (id) => id === "claude-sonnet-4-6",
      allowedModels: allowed,
    })
    assert.equal(picked, "claude-sonnet-4-6")
  })

  test("authorized but gateway-incompatible preferred model falls back to allowed visible model", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-haiku-4-5", // canUseModel may allow it, but gateway rejects it
      visibleModels: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-6" }],
      canUseModel: (id) => id === "claude-haiku-4-5" || id === "claude-sonnet-4-6",
      allowedModels: allowed,
    })
    assert.equal(picked, "claude-sonnet-4-6")
  })

  test("authorized preferred model disabled/hidden from visible fallback returns null if no allowed fallback", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "unknown-model",
      visibleModels: [{ id: "claude-haiku-4-5" }],
      canUseModel: () => true,
      allowedModels: allowed,
    })
    assert.equal(picked, null)
  })

  test("unauthorized preferred model falls back to first authorized allowed visible model", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-opus-4-7",
      visibleModels: [{ id: "claude-opus-4-7" }, { id: "gpt-5.5" }],
      canUseModel: (id) => id === "gpt-5.5",
      allowedModels: allowed,
    })
    assert.equal(picked, "gpt-5.5")
  })
})

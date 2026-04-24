/**
 * V3 Phase 2 Task 2I-2 — 新增 metrics 系列单元测试。
 *
 * 范围:
 *   - Histogram 类:观察样本累计、bucket 边界、render 出 _bucket/_sum/_count、+Inf
 *   - 6 个新系列的 incr/observe + render 文本断言
 *   - shortModel():折叠日期后缀防 cardinality 爆
 *   - resetMetricsForTest 把 v3 系列也清掉
 *
 * 不依赖 PG / Redis,纯 in-process。
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  incrAnthropicProxyReject,
  incrAnthropicProxySettle,
  // 顺带验证老 helper 仍可用
  incrBillingDebit,
  observeAnthropicProxyStreamDuration,
  observeAnthropicProxyTtft,
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
  renderPrometheus,
  resetMetricsForTest,
} from '../metrics.js'

describe('V3 2I-2 — anthropicProxy + bridge histograms/counters', () => {
  beforeEach(() => {
    resetMetricsForTest()
  })

  describe('Histogram class shape', () => {
    test('空系列只渲染 HELP/TYPE 不出 sample 行', async () => {
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(text.includes('# HELP anthropic_proxy_ttft_seconds'))
      assert.ok(text.includes('# TYPE anthropic_proxy_ttft_seconds histogram'))
      // 没观察过的系列不应出 _bucket / _sum / _count
      assert.ok(!/anthropic_proxy_ttft_seconds_bucket/.test(text))
      assert.ok(!/anthropic_proxy_ttft_seconds_sum/.test(text))
    })

    test('observe 样本进 buckets 累计 + +Inf 兜底 + sum/count 正确', async () => {
      // buckets: 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30
      observeAnthropicProxyTtft('claude-sonnet-4-6', 0.04) // ≤ 0.05
      observeAnthropicProxyTtft('claude-sonnet-4-6', 0.3) // ≤ 0.5 .. 30
      observeAnthropicProxyTtft('claude-sonnet-4-6', 50) // 只进 +Inf
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      // 0.05 bucket = 1 (只有 0.04)
      assert.ok(
        /anthropic_proxy_ttft_seconds_bucket\{model="claude-sonnet-4-6",le="0\.05"\} 1/.test(text),
        text,
      )
      // 0.5 bucket = 2 (0.04 + 0.3)
      assert.ok(
        /anthropic_proxy_ttft_seconds_bucket\{model="claude-sonnet-4-6",le="0\.5"\} 2/.test(text),
        text,
      )
      // 30 bucket = 2 (50 还在 +Inf 之外)
      assert.ok(
        /anthropic_proxy_ttft_seconds_bucket\{model="claude-sonnet-4-6",le="30"\} 2/.test(text),
        text,
      )
      // +Inf = 3
      assert.ok(
        /anthropic_proxy_ttft_seconds_bucket\{model="claude-sonnet-4-6",le="\+Inf"\} 3/.test(text),
        text,
      )
      // sum = 0.04 + 0.3 + 50
      assert.ok(
        /anthropic_proxy_ttft_seconds_sum\{model="claude-sonnet-4-6"\} 50\.34/.test(text),
        text,
      )
      // count = 3
      assert.ok(
        /anthropic_proxy_ttft_seconds_count\{model="claude-sonnet-4-6"\} 3/.test(text),
        text,
      )
    })

    test('负数 / NaN / Infinity 被静默丢弃,不污染样本', async () => {
      observeAnthropicProxyStreamDuration('claude-sonnet-4-6', -1)
      observeAnthropicProxyStreamDuration('claude-sonnet-4-6', Number.NaN)
      observeAnthropicProxyStreamDuration('claude-sonnet-4-6', Number.POSITIVE_INFINITY)
      observeAnthropicProxyStreamDuration('claude-sonnet-4-6', 0.5)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(
        /anthropic_proxy_stream_duration_seconds_count\{model="claude-sonnet-4-6"\} 1/.test(text),
        text,
      )
      assert.ok(
        /anthropic_proxy_stream_duration_seconds_sum\{model="claude-sonnet-4-6"\} 0\.5/.test(text),
        text,
      )
    })

    test('不同 label 值各自一行', async () => {
      observeWsBridgeBuffered('user_to_container', 2048)
      observeWsBridgeBuffered('container_to_user', 8192)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(/ws_bridge_buffered_bytes_count\{side="user_to_container"\} 1/.test(text), text)
      assert.ok(/ws_bridge_buffered_bytes_count\{side="container_to_user"\} 1/.test(text), text)
    })
  })

  describe('counter:anthropic_proxy_settle_total', () => {
    test('三态各自累加,标签按字典序稳定', async () => {
      incrAnthropicProxySettle('final')
      incrAnthropicProxySettle('final')
      incrAnthropicProxySettle('partial')
      incrAnthropicProxySettle('aborted')
      incrAnthropicProxySettle('aborted')
      incrAnthropicProxySettle('aborted')
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(/anthropic_proxy_settle_total\{kind="final"\} 2/.test(text), text)
      assert.ok(/anthropic_proxy_settle_total\{kind="partial"\} 1/.test(text), text)
      assert.ok(/anthropic_proxy_settle_total\{kind="aborted"\} 3/.test(text), text)
    })
  })

  describe('counter:anthropic_proxy_reject_total', () => {
    test('8 个 reason 标签独立累加', async () => {
      incrAnthropicProxyReject('insufficient')
      incrAnthropicProxyReject('rate_limited')
      incrAnthropicProxyReject('rate_limited')
      incrAnthropicProxyReject('concurrency')
      incrAnthropicProxyReject('account_pool')
      incrAnthropicProxyReject('account_pool_busy')
      incrAnthropicProxyReject('unknown_model')
      incrAnthropicProxyReject('bad_body')
      incrAnthropicProxyReject('too_large')
      incrAnthropicProxyReject('identity')
      incrAnthropicProxyReject('bad_path')
      incrAnthropicProxyReject('bad_headers')
      incrAnthropicProxyReject('upstream_auth')
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(/anthropic_proxy_reject_total\{reason="insufficient"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="rate_limited"\} 2/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="concurrency"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="account_pool"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="account_pool_busy"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="unknown_model"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="bad_body"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="too_large"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="identity"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="bad_path"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="bad_headers"\} 1/.test(text))
      assert.ok(/anthropic_proxy_reject_total\{reason="upstream_auth"\} 1/.test(text))
    })
  })

  describe('ws_bridge_session_duration_seconds', () => {
    test('close cause 作为标签 + 多 cause 共存', async () => {
      observeWsBridgeSessionDuration('client_close', 12.5)
      observeWsBridgeSessionDuration('client_close', 60)
      observeWsBridgeSessionDuration('container_unready', 0.3)
      observeWsBridgeSessionDuration('backpressure', 5)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(
        /ws_bridge_session_duration_seconds_count\{cause="client_close"\} 2/.test(text),
        text,
      )
      assert.ok(
        /ws_bridge_session_duration_seconds_count\{cause="container_unready"\} 1/.test(text),
        text,
      )
      assert.ok(
        /ws_bridge_session_duration_seconds_count\{cause="backpressure"\} 1/.test(text),
        text,
      )
      // 标签值是任意字符串,Prometheus 接收 — 不强制 enum
    })
  })

  describe('model label normalization (shortModel)', () => {
    test('8 位日期后缀被 strip,防 cardinality 爆', async () => {
      // 同一模型,带不同日期后缀 → 应折叠成同一 series
      observeAnthropicProxyTtft('claude-sonnet-4-6-20250101', 0.5)
      observeAnthropicProxyTtft('claude-sonnet-4-6-20260420', 0.7)
      observeAnthropicProxyTtft('claude-sonnet-4-6', 0.9)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      // 三次 observe 都进同一 series count=3
      assert.ok(
        /anthropic_proxy_ttft_seconds_count\{model="claude-sonnet-4-6"\} 3/.test(text),
        text,
      )
      // 不应出现带日期后缀的标签
      assert.ok(!/model="claude-sonnet-4-6-20250101"/.test(text), text)
      assert.ok(!/model="claude-sonnet-4-6-20260420"/.test(text), text)
    })

    test('非日期后缀的 model 名保持原样', async () => {
      observeAnthropicProxyTtft('custom-model-v2', 0.5)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(/model="custom-model-v2"/.test(text), text)
    })

    test('超长 model 名截到 64 字符', async () => {
      const longName = 'x'.repeat(200)
      observeAnthropicProxyTtft(longName, 0.5)
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      // 截掉后是 64 个 x
      const expectedLabel = 'x'.repeat(64)
      assert.ok(text.includes(`model="${expectedLabel}"`), text)
    })
  })

  describe('resetMetricsForTest 清掉 v3 系列', () => {
    test('observe + reset → render 不再有样本行', async () => {
      observeAnthropicProxyTtft('claude-sonnet-4-6', 0.5)
      incrAnthropicProxySettle('final')
      incrAnthropicProxyReject('insufficient')
      observeWsBridgeBuffered('user_to_container', 1024)
      observeWsBridgeSessionDuration('client_close', 10)
      // 顺带验证老 helper 也被 reset 影响
      incrBillingDebit('success')

      let text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      assert.ok(/anthropic_proxy_ttft_seconds_count/.test(text))
      assert.ok(/anthropic_proxy_settle_total\{kind="final"\}/.test(text))
      assert.ok(/billing_debit_total\{result="success"\}/.test(text))

      resetMetricsForTest()
      text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      // sample 行没了,只剩 HELP/TYPE
      assert.ok(!/anthropic_proxy_ttft_seconds_count/.test(text), text)
      assert.ok(!/anthropic_proxy_settle_total\{/.test(text), text)
      assert.ok(!/billing_debit_total\{/.test(text), text)
      // HELP 行还在
      assert.ok(/# HELP anthropic_proxy_ttft_seconds/.test(text))
    })
  })

  describe('renderPrometheus 全局结构', () => {
    test('v1 + v3 系列都出现一次,以 newline 结尾', async () => {
      const text = await renderPrometheus({ override: { agentContainersRunning: 0 } })
      // v1 系列(已存在)
      assert.ok(text.includes('# HELP gateway_http_requests_total'))
      assert.ok(text.includes('# HELP billing_debit_total'))
      assert.ok(text.includes('# HELP claude_api_requests_total'))
      assert.ok(text.includes('# HELP admin_audit_write_failures_total'))
      // v3 2I-2 系列
      assert.ok(text.includes('# HELP anthropic_proxy_ttft_seconds'))
      assert.ok(text.includes('# HELP anthropic_proxy_stream_duration_seconds'))
      assert.ok(text.includes('# HELP anthropic_proxy_settle_total'))
      assert.ok(text.includes('# HELP anthropic_proxy_reject_total'))
      assert.ok(text.includes('# HELP ws_bridge_buffered_bytes'))
      assert.ok(text.includes('# HELP ws_bridge_session_duration_seconds'))
      // gauges
      assert.ok(text.includes('# HELP account_pool_health'))
      assert.ok(text.includes('# HELP agent_containers_running'))
      assert.ok(text.endsWith('\n'))
      // 每个 HELP 只出现一次
      const helpCount = (text.match(/^# HELP /gm) ?? []).length
      assert.equal(
        helpCount,
        12,
        `HELP 行总数 = 12 (4 v1 counter + 6 v3 + 2 gauge), got ${helpCount}`,
      )
    })
  })
})

// Dependency-free so the real-browser proof (web-react browser-tests) can bundle it
// together with browserBroker.ts without pulling Docker/DB code.
import type { ManagedBrowserBrokerLimits } from './browserBroker.js'

/**
 * Host-side TLS broker limits for Knowledge Planet worker runs.
 *
 * Action runs keep the original envelope. Login runs differ only in
 * `maxConcurrent`: the WeChat QR login page (lp.open / open / res / support
 * .weixin.qq.com plus wx/api.zsxq.com) opens 9–11 simultaneous TLS tunnels
 * (peak 10 measured in the g1669 isolated repro). With 8 the broker dropped
 * the tunnel carrying /connect/qrcode/<uuid>, so the iframe kept its blurred
 * placeholder and capture_qr failed with image_not_ready
 * (INC-20261109-KP-QR-BROKER-CONCURRENCY). 16 gives ~1.6x headroom over the
 * observed peak while staying well under the broker's hard ceiling (32); the
 * per-run total (64 connections), byte cap, idle and connect timeouts are
 * unchanged, and other plugins keep their own limits.
 */
export const KNOWLEDGE_PLANET_ACTION_BROKER_LIMITS: ManagedBrowserBrokerLimits = Object.freeze({
  maxConnections: 64,
  maxConcurrent: 8,
  maxBytesPerDirection: 64 * 1024 * 1024,
  idleTimeoutMs: 120_000,
  connectTimeoutMs: 10_000,
})

export const KNOWLEDGE_PLANET_LOGIN_BROKER_LIMITS: ManagedBrowserBrokerLimits = Object.freeze({
  ...KNOWLEDGE_PLANET_ACTION_BROKER_LIMITS,
  maxConcurrent: 16,
})

export function knowledgePlanetBrokerLimits(kind: 'action' | 'login'): ManagedBrowserBrokerLimits {
  return kind === 'login'
    ? KNOWLEDGE_PLANET_LOGIN_BROKER_LIMITS
    : KNOWLEDGE_PLANET_ACTION_BROKER_LIMITS
}

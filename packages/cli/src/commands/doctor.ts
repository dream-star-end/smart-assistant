import { existsSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { paths, probeSessionsDb, readAgentsConfig, readConfig } from '@openclaude/storage'

/** 脱敏展示 accessToken:前 4 位 + … + 后 4 位。完整值需 --show-token。 */
export function maskAccessToken(token: string): string {
  if (!token) return '(未设置)'
  // 短 token 不足以留首尾 4 位时只留首 2 位,避免脱敏后反而泄露大半内容。
  if (token.length <= 12) return `${token.slice(0, 2)}…`
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** TCP 探测 gateway 端口是否在监听(bind 0.0.0.0/:: 时用回环地址探测)。 */
function probeGatewayPort(bind: string, port: number): Promise<boolean> {
  const host = bind === '0.0.0.0' || bind === '::' || bind === '' ? '127.0.0.1' : bind
  return new Promise((resolveProbe) => {
    const sock = createConnection({ host, port })
    const done = (ok: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolveProbe(ok)
    }
    sock.setTimeout(1500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

export async function doctor(opts: { showToken?: boolean } = {}): Promise<void> {
  console.log('OpenClaude doctor\n')
  const cfg = await readConfig()
  if (!cfg) {
    console.error('✗ 未找到配置 (', paths.config, ')')
    console.error('  → 运行 `openclaude onboard`')
    process.exit(1)
  }
  console.log('✓ 配置文件:', paths.config)

  const ccbDir = resolve(cfg.auth.claudeCodePath)
  if (!existsSync(ccbDir)) {
    console.error('✗ Claude Code Best 路径不存在:', ccbDir)
    process.exit(1)
  }
  console.log('✓ CCB 路径:', ccbDir)

  const entry = resolve(ccbDir, cfg.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx')
  if (!existsSync(entry)) {
    console.error('✗ CCB 入口不存在:', entry)
    process.exit(1)
  }
  console.log('✓ CCB 入口:', entry)

  const agents = await readAgentsConfig()
  console.log(`✓ Agents: ${agents.agents.map((a) => a.id).join(', ')} (default: ${agents.default})`)

  let failed = false

  // ── sessions.db 可打开性(复用 gateway /healthz 同一探针)──
  try {
    const probe = await probeSessionsDb()
    if (probe.ok) {
      console.log('✓ sessions.db 可打开:', paths.sessionsDb)
    } else {
      failed = true
      console.error('✗ sessions.db 打不开:', probe.error)
    }
  } catch (err) {
    failed = true
    console.error('✗ sessions.db 探测失败:', err instanceof Error ? err.message : String(err))
  }

  // ── WAL 文件体积(过大提示 checkpoint 可能长期失败)──
  const walPath = `${paths.sessionsDb}-wal`
  if (existsSync(walPath)) {
    try {
      const walMB = statSync(walPath).size / 1024 / 1024
      const line = `WAL 文件: ${walMB.toFixed(1)}MB (${walPath})`
      if (walMB > 256) {
        console.warn(`⚠ ${line} — 体积异常偏大,checkpoint 可能长期失败`)
      } else {
        console.log(`✓ ${line}`)
      }
    } catch {
      console.warn('⚠ WAL 文件存在但无法 stat:', walPath)
    }
  } else {
    console.log('✓ WAL 文件: (无)')
  }

  // ── msg outbox 积压(落库失败的 server-authored 消息排队文件)──
  if (existsSync(paths.msgOutbox)) {
    try {
      const lines = readFileSync(paths.msgOutbox, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0).length
      if (lines > 0) {
        console.warn(
          `⚠ msg outbox 积压: ${lines} 行 (${paths.msgOutbox}) — sessions.db 写入曾失败,待 gateway 启动时重放`,
        )
      } else {
        console.log('✓ msg outbox: 空')
      }
    } catch {
      console.warn('⚠ msg outbox 文件存在但无法读取:', paths.msgOutbox)
    }
  } else {
    console.log('✓ msg outbox: (无积压)')
  }

  // ── gateway 端口监听探测 ──
  const portListening = await probeGatewayPort(cfg.gateway.bind, cfg.gateway.port)
  if (portListening) {
    console.log(`✓ gateway 端口在监听: ${cfg.gateway.bind}:${cfg.gateway.port}`)
  } else {
    console.warn(`⚠ gateway 端口未监听: ${cfg.gateway.bind}:${cfg.gateway.port} (gateway 未运行?)`)
  }

  if (failed) {
    console.error('\n✗ 部分检查未通过')
  } else {
    console.log('\n✓ all checks passed')
  }
  console.log(`\nGateway: http://${cfg.gateway.bind}:${cfg.gateway.port}`)
  // 默认脱敏输出:doctor 输出常被整段复制进工单/截图,明文 token 会直接泄露
  // gateway 管理权限。需要完整值时显式 `openclaude doctor --show-token`。
  console.log(
    `Token:   ${opts.showToken ? cfg.gateway.accessToken : maskAccessToken(cfg.gateway.accessToken)}`,
  )
  if (!opts.showToken) {
    console.log('         (已脱敏;用 --show-token 显示完整值)')
  }
  if (failed) process.exit(1)
}
